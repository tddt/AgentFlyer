import type {
  ProcessErrorEvent,
  ProcessRuntime,
  ProcessStepContext,
  ProcessStepResult,
} from '../core/kernel/types.js';
import type { WorkflowDef, WorkflowRunRecord, WorkflowStepResult } from './workflow-backend.js';
import {
  applyFormatInstruction,
  buildWorkflowStepIndexMap,
  deserializeStepVars,
  evalBranchExpression,
  extractStepVars,
  interpolate,
  resolveWorkflowEntryStepIndex,
  resolveWorkflowNextStepIndex,
  resolveWorkflowStepId,
  resolveWorkflowStepIndex,
  serializeStepVars,
  snapshotVars,
} from './workflow-runtime-shared.js';
import {
  type WorkflowSuperNodeParticipantResult,
  type WorkflowSuperNodeType,
  buildWorkflowSuperNodeCoordinatorPrompt,
  buildWorkflowSuperNodeParticipantPrompt,
  isWorkflowSuperNodeType,
  minimumWorkflowSuperNodeParticipants,
  normalizeWorkflowSuperNodePrompts,
} from './workflow-super-nodes.js';

export interface WorkflowProcessInput {
  runId: string;
  workflow: WorkflowDef;
  input: string;
  startedAt?: number;
  /** When present, creates a forked state instead of a fresh state. */
  _fork?: {
    priorRun: WorkflowRunRecord;
    fromStepId: string;
    /** When set, include this step result in the copied prior results (used for skipStep). */
    appendStepResult?: WorkflowStepResult;
  };
}

export interface WorkflowProcessState {
  phase: 'running' | 'done' | 'error' | 'cancelled';
  workflow: WorkflowDef;
  run: WorkflowRunRecord;
  currentStepId?: string;
  currentStepIndex: number;
  prevOutputs: string[];
  stepVars: ReturnType<typeof serializeStepVars>;
  currentAttempt: number;
  error?: ProcessErrorEvent;
}

export interface WorkflowAgentStepRequest {
  runId: string;
  stepId: string;
  agentId: string;
  message: string;
  threadKey: string;
  /** Called for each streamed text token from the LLM during this step. */
  onToken?: (token: string) => void;
}

export interface WorkflowHttpStepRequest {
  stepId: string;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: string;
}

export interface WorkflowRuntimeHandlers {
  runAgentStep?(request: WorkflowAgentStepRequest): Promise<string>;
  runHttpStep?(request: WorkflowHttpStepRequest): Promise<string>;
  /** Optional: called for each streamed text token from a running agent step. */
  onToken?(runId: string, stepId: string, token: string): void;
}

function buildError(code: string, message: string, retryable: boolean): ProcessErrorEvent {
  return { code, message, retryable };
}

function cloneStepResults(stepResults: WorkflowStepResult[]): WorkflowStepResult[] {
  return stepResults.map((step) => ({
    ...step,
    superNodeTrace: step.superNodeTrace
      ? {
          ...step.superNodeTrace,
          participantResults: step.superNodeTrace.participantResults.map((item) => ({ ...item })),
        }
      : undefined,
    varsSnapshot: step.varsSnapshot ? { ...step.varsSnapshot } : undefined,
  }));
}

interface WorkflowStepExecutionResult {
  output: string;
  superNodeTrace?: WorkflowStepResult['superNodeTrace'];
}

class WorkflowSuperNodeExecutionError extends Error {
  readonly trace: WorkflowStepResult['superNodeTrace'];

  constructor(message: string, trace: WorkflowStepResult['superNodeTrace']) {
    super(message);
    this.name = 'WorkflowSuperNodeExecutionError';
    this.trace = trace;
  }
}

function workflowThreadKey(runId: string, stepIndex: number, suffix?: string): string {
  return suffix
    ? `workflow:${runId}:step${stepIndex}:${suffix}`
    : `workflow:${runId}:step${stepIndex}`;
}

export class WorkflowProcessRuntime
  implements ProcessRuntime<WorkflowProcessState, WorkflowProcessInput>
{
  readonly type = 'workflow.run';
  readonly version = 2;

  constructor(private readonly handlers: WorkflowRuntimeHandlers = {}) {}

  createInitialState(input: WorkflowProcessInput): WorkflowProcessState {
    if (input._fork) {
      return this.createForkState(input, input._fork.priorRun, input._fork.fromStepId, {
        appendStepResult: input._fork.appendStepResult,
      });
    }
    const currentStepIndex = resolveWorkflowEntryStepIndex(input.workflow);

    return {
      phase: 'running',
      workflow: input.workflow,
      run: {
        runId: input.runId,
        workflowId: input.workflow.id,
        workflowName: input.workflow.name,
        input: input.input,
        startedAt: input.startedAt ?? Date.now(),
        status: 'running',
        stepResults: [],
      },
      currentStepId: resolveWorkflowStepId(input.workflow, currentStepIndex),
      currentStepIndex,
      prevOutputs: [],
      stepVars: {},
      currentAttempt: 0,
    };
  }

  /**
   * Create a forked initial state that pre-populates completed steps from a prior run.
   * Used by retryFromStep to skip re-executing already-completed steps.
   */
  createForkState(
    input: WorkflowProcessInput,
    priorRun: WorkflowRunRecord,
    fromStepId: string,
    options?: { appendStepResult?: WorkflowStepResult },
  ): WorkflowProcessState {
    const fromStepIndex = input.workflow.steps.findIndex((s) => s.id === fromStepId);
    if (fromStepIndex <= 0) {
      // If fork point is the first step or not found, start fresh
      return this.createInitialState({ ...input, _fork: undefined });
    }

    // Take only step results that are BEFORE the retry step
    const priorResults = priorRun.stepResults.slice(0, fromStepIndex);
    // For skipStep: append the failed step result so history is preserved
    if (options?.appendStepResult) {
      priorResults.push(options.appendStepResult);
    }
    const prevOutputs = priorResults
      .slice(0, fromStepIndex)  // don't include appended step result in prevOutputs
      .map((r) => r.output ?? '');

    // Reconstruct SerializedStepVars from the varsSnapshot of the last completed step
    const lastSnap = [...priorResults].reverse().find((r) => r.varsSnapshot);
    const stepVars: Record<string, Record<string, string>> = {};
    if (lastSnap?.varsSnapshot) {
      for (const [key, value] of Object.entries(lastSnap.varsSnapshot)) {
        const dotIdx = key.indexOf('.');
        if (dotIdx > 0) {
          const sid = key.slice(0, dotIdx);
          const vname = key.slice(dotIdx + 1);
          if (!stepVars[sid]) stepVars[sid] = {};
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          stepVars[sid]![vname] = value;
        }
      }
    }

    return {
      phase: 'running',
      workflow: input.workflow,
      run: {
        runId: input.runId,
        workflowId: input.workflow.id,
        workflowName: input.workflow.name,
        input: priorRun.input,
        startedAt: input.startedAt ?? Date.now(),
        status: 'running',
        stepResults: priorResults,
        forkFromRunId: priorRun.runId,
        forkFromStepId: fromStepId,
      },
      currentStepId: resolveWorkflowStepId(input.workflow, fromStepIndex),
      currentStepIndex: fromStepIndex,
      prevOutputs,
      stepVars,
      currentAttempt: 0,
    };
  }

  async step(
    state: WorkflowProcessState,
    context: ProcessStepContext,
  ): Promise<ProcessStepResult<WorkflowProcessState>> {
    if (state.phase === 'done') {
      return { signal: 'DONE', state };
    }
    if (state.phase === 'cancelled') {
      return { signal: 'SUSPENDED', state };
    }
    if (state.phase === 'error') {
      return { signal: 'ERROR', state, error: state.error };
    }

    const currentStepIndex = resolveWorkflowStepIndex(
      state.workflow,
      state.currentStepId,
      state.currentStepIndex,
    );

    if (currentStepIndex >= state.workflow.steps.length) {
      const doneState = this.finishState(state, 'done', context.now);
      return { signal: 'DONE', state: doneState };
    }

    const workflow = state.workflow;
    const step = workflow.steps[currentStepIndex];
    if (!step) {
      const error = buildError(
        'WORKFLOW_STEP_CURSOR_OUT_OF_RANGE',
        `Invalid workflow step cursor ${state.currentStepId ?? currentStepIndex}`,
        false,
      );
      return {
        signal: 'ERROR',
        error,
        state: this.failState(state, error, context.now),
      };
    }

    const globals = workflow.variables ?? {};
    const stepVars = deserializeStepVars(state.stepVars);
    const prevOutputs = [...state.prevOutputs];
    const stepResults = cloneStepResults(state.run.stepResults);
    const message = interpolate(
      step.messageTemplate,
      state.run.input,
      prevOutputs,
      stepVars,
      globals,
    );
    const maxRetries = step.maxRetries ?? 0;

    try {
      const type = step.type ?? 'agent';
      if (type === 'condition') {
        return this.handleConditionStep(state, context.now, stepResults, prevOutputs, stepVars);
      }

      const stepStartedAt = Date.now();
      const execution = await this.executeStep(type, step, message, state, currentStepIndex);
      const stepFinishedAt = Date.now();
      extractStepVars(execution.output, step.id, step, stepVars, globals);
      prevOutputs.push(execution.output);

      stepResults.push(
        this.buildSuccessStepResult(step.id, execution.output, stepVars, execution.superNodeTrace, {
          startedAt: stepStartedAt,
          finishedAt: stepFinishedAt,
        }),
      );
      const nextState = this.advanceState(
        state,
        {
          stepResults,
          prevOutputs,
          stepVars: serializeStepVars(stepVars),
        },
        stepFinishedAt,
        resolveWorkflowNextStepIndex(state.workflow, step, currentStepIndex),
      );
      return {
        signal: nextState.phase === 'done' ? 'DONE' : 'YIELD',
        state: nextState,
        nextRunAt: context.now,
      };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      const superNodeTrace =
        error instanceof WorkflowSuperNodeExecutionError ? error.trace : undefined;
      const errorFinishedAt = Date.now();
      if (state.currentAttempt < maxRetries) {
        return {
          signal: 'RETRYABLE_ERROR',
          error: buildError('WORKFLOW_STEP_RETRYABLE_ERROR', messageText, true),
          state: {
            ...state,
            currentAttempt: state.currentAttempt + 1,
          },
          delayMs: 0,
        };
      }

      stepResults.push({
        stepId: step.id,
        error: messageText,
        finishedAt: errorFinishedAt,
        ...(superNodeTrace ? { superNodeTrace } : {}),
      });
      if (step.condition === 'on_success') {
        const finalError = buildError('WORKFLOW_STEP_FATAL_ERROR', messageText, false);
        return {
          signal: 'ERROR',
          error: finalError,
          state: {
            ...this.failState(state, finalError, errorFinishedAt),
            run: {
              ...state.run,
              stepResults,
              status: 'error',
              finishedAt: errorFinishedAt,
            },
            currentAttempt: 0,
          },
        };
      }

      const nextState = this.advanceState(
        state,
        {
          stepResults,
          prevOutputs: [
            ...prevOutputs,
            this.buildContinuationOutput(step.id, messageText, superNodeTrace),
          ],
          stepVars: serializeStepVars(stepVars),
        },
        errorFinishedAt,
        resolveWorkflowNextStepIndex(state.workflow, step, currentStepIndex),
      );
      return {
        signal: nextState.phase === 'done' ? 'DONE' : 'YIELD',
        state: nextState,
        nextRunAt: context.now,
      };
    }
  }

  serialize(state: WorkflowProcessState): unknown {
    return state;
  }

  deserialize(payload: unknown): WorkflowProcessState {
    const state = payload as WorkflowProcessState;
    const currentStepIndex = resolveWorkflowStepIndex(
      state.workflow,
      state.currentStepId,
      state.currentStepIndex,
    );
    return {
      ...state,
      currentStepIndex,
      currentStepId: resolveWorkflowStepId(state.workflow, currentStepIndex),
    };
  }

  private async executeStep(
    type: Exclude<NonNullable<WorkflowDef['steps'][number]['type']>, 'condition'>,
    step: WorkflowDef['steps'][number],
    message: string,
    state: WorkflowProcessState,
    currentStepIndex: number,
  ): Promise<WorkflowStepExecutionResult> {
    if (isWorkflowSuperNodeType(type)) {
      return await this.executeSuperNodeStep(type, step, message, state, currentStepIndex);
    }

    switch (type) {
      case 'agent': {
        const agentId = step.agentId ?? '';
        if (!agentId) {
          throw new Error(`Agent not found: ${step.agentId ?? '(missing)'}`);
        }
        if (!this.handlers.runAgentStep) {
          throw new Error('Workflow agent step handler is not configured');
        }
        const onToken = this.handlers.onToken
          ? (token: string) => this.handlers.onToken!(state.run.runId, step.id, token)
          : undefined;
        return {
          output: (
            await this.handlers.runAgentStep({
              runId: state.run.runId,
              stepId: step.id,
              agentId,
              message: applyFormatInstruction(step, message),
              threadKey: workflowThreadKey(state.run.runId, currentStepIndex),
              onToken,
            })
          ).trim(),
        };
      }
      case 'transform': {
        const globals = state.workflow.variables ?? {};
        const stepVars = deserializeStepVars(state.stepVars);
        const result = new Function(
          'vars',
          'globals',
          'input',
          'prev_output',
          `return (${step.transformCode ?? message});`,
        )(
          Object.fromEntries(
            [...stepVars.entries()].map(([key, value]) => [key, Object.fromEntries(value)]),
          ),
          globals,
          state.run.input,
          state.prevOutputs[state.prevOutputs.length - 1] ?? '',
        );
        return { output: String(result ?? '') };
      }
      case 'http': {
        const globals = state.workflow.variables ?? {};
        const stepVars = deserializeStepVars(state.stepVars);
        const url = interpolate(
          step.url ?? '',
          state.run.input,
          state.prevOutputs,
          stepVars,
          globals,
        );
        const body = step.bodyTemplate
          ? interpolate(step.bodyTemplate, state.run.input, state.prevOutputs, stepVars, globals)
          : undefined;
        if (this.handlers.runHttpStep) {
          return {
            output: await this.handlers.runHttpStep({
              stepId: step.id,
              url,
              method: step.method ?? 'GET',
              headers: step.headers,
              body,
            }),
          };
        }
        const response = await fetch(url, {
          method: step.method ?? 'GET',
          headers: step.headers,
          body,
        });
        return { output: await response.text() };
      }
    }
  }

  private async executeSuperNodeStep(
    type: WorkflowSuperNodeType,
    step: WorkflowDef['steps'][number],
    message: string,
    state: WorkflowProcessState,
    currentStepIndex: number,
  ): Promise<WorkflowStepExecutionResult> {
    const coordinatorAgentId = step.agentId?.trim() ?? '';
    if (!coordinatorAgentId) {
      throw new Error(`Super node ${step.id} is missing coordinator agentId`);
    }
    if (!this.handlers.runAgentStep) {
      throw new Error(`Workflow super node step handler is not configured for '${type}'`);
    }

    const participantAgentIds = (step.participantAgentIds ?? [])
      .map((agentId) => agentId.trim())
      .filter(Boolean);
    const minimumParticipants = minimumWorkflowSuperNodeParticipants(type);
    if (participantAgentIds.length < minimumParticipants) {
      throw new Error(
        `Super node '${step.id}' requires at least ${minimumParticipants} participant agents`,
      );
    }

    const rolePrompts = normalizeWorkflowSuperNodePrompts(type, step.superNodePrompts);
    const participantResults: WorkflowSuperNodeParticipantResult[] = await Promise.all(
      participantAgentIds.map(async (agentId, index) => {
        const rolePrompt = rolePrompts[index] ?? `补充视角 ${index + 1}`;
        try {
          const output = await this.handlers.runAgentStep?.({
            runId: state.run.runId,
            stepId: `${step.id}:participant:${index + 1}`,
            agentId,
            message: buildWorkflowSuperNodeParticipantPrompt({
              type,
              baseMessage: message,
              rolePrompt,
              index,
              total: participantAgentIds.length,
              domainRules: step.domainRules,
            }),
            threadKey: workflowThreadKey(
              state.run.runId,
              currentStepIndex,
              `participant-${index + 1}`,
            ),
          });

          return {
            agentId,
            prompt: rolePrompt,
            output: (output ?? '').trim(),
          };
        } catch (error) {
          return {
            agentId,
            prompt: rolePrompt,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    const trace: WorkflowStepResult['superNodeTrace'] = {
      type,
      coordinatorAgentId,
      participantResults,
    };

    const failedParticipant = participantResults.find((item) => item.error?.trim());
    if (failedParticipant) {
      throw new WorkflowSuperNodeExecutionError(
        `Super node '${step.id}' participant '${failedParticipant.agentId}' failed: ${failedParticipant.error}`,
        trace,
      );
    }

    const coordinatorPrompt = buildWorkflowSuperNodeCoordinatorPrompt({
      step,
      participantResults,
      baseMessage: message,
      previousOutput: state.prevOutputs[state.prevOutputs.length - 1] ?? '',
    });

    try {
      return {
        output: (
          await this.handlers.runAgentStep({
            runId: state.run.runId,
            stepId: step.id,
            agentId: coordinatorAgentId,
            message: applyFormatInstruction(step, coordinatorPrompt),
            threadKey: workflowThreadKey(state.run.runId, currentStepIndex, 'coordinator'),
          })
        ).trim(),
        superNodeTrace: trace,
      };
    } catch (error) {
      throw new WorkflowSuperNodeExecutionError(
        error instanceof Error ? error.message : String(error),
        trace,
      );
    }
  }

  private handleConditionStep(
    state: WorkflowProcessState,
    now: number,
    stepResults: WorkflowStepResult[],
    prevOutputs: string[],
    stepVars: ReturnType<typeof deserializeStepVars>,
  ): ProcessStepResult<WorkflowProcessState> {
    const currentStepIndex = resolveWorkflowStepIndex(
      state.workflow,
      state.currentStepId,
      state.currentStepIndex,
    );
    const step = state.workflow.steps[currentStepIndex];
    if (!step) {
      const error = buildError('WORKFLOW_CONDITION_STEP_MISSING', 'Condition step missing', false);
      return { signal: 'ERROR', error, state: this.failState(state, error, now) };
    }

    const testOutput = prevOutputs[prevOutputs.length - 1] ?? '';
    let nextIndex = resolveWorkflowNextStepIndex(state.workflow, step, currentStepIndex);
    let outputText = testOutput;
    const stepIndexMap = buildWorkflowStepIndexMap(state.workflow);
    const globals = state.workflow.variables ?? {};

    if (step.branches?.length) {
      for (const branch of step.branches) {
        if (!evalBranchExpression(branch.expression, testOutput, stepVars, globals)) continue;
        if (branch.goto === '$end') {
          extractStepVars(testOutput, step.id, step, stepVars, globals);
          stepResults.push(this.buildSuccessStepResult(step.id, '→ $end', stepVars));
          const doneState: WorkflowProcessState = {
            ...state,
            phase: 'done' as const,
            currentStepId: undefined,
            currentStepIndex: state.workflow.steps.length,
            currentAttempt: 0,
            prevOutputs: [...prevOutputs, testOutput],
            stepVars: serializeStepVars(stepVars),
            run: {
              ...state.run,
              stepResults,
              status: 'done',
              finishedAt: now,
            },
          };
          return { signal: 'DONE', state: doneState };
        }
        const targetIndex = stepIndexMap.get(branch.goto);
        if (targetIndex !== undefined) {
          nextIndex = targetIndex;
          outputText = `→ ${branch.goto}`;
          break;
        }
      }
    }

    extractStepVars(testOutput, step.id, step, stepVars, globals);
    stepResults.push(this.buildSuccessStepResult(step.id, outputText, stepVars));
    const nextState = this.advanceState(
      state,
      {
        stepResults,
        prevOutputs: [...prevOutputs, testOutput],
        stepVars: serializeStepVars(stepVars),
      },
      now,
      nextIndex,
    );
    return {
      signal: nextState.phase === 'done' ? 'DONE' : 'YIELD',
      state: nextState,
      nextRunAt: now,
    };
  }

  private buildSuccessStepResult(
    stepId: string,
    output: string,
    stepVars: ReturnType<typeof deserializeStepVars>,
    superNodeTrace?: WorkflowStepResult['superNodeTrace'],
    timing?: { startedAt: number; finishedAt: number },
  ): WorkflowStepResult {
    const varsSnapshot = snapshotVars(stepVars);
    return {
      stepId,
      output,
      ...(timing ? { startedAt: timing.startedAt, finishedAt: timing.finishedAt } : {}),
      ...(superNodeTrace ? { superNodeTrace } : {}),
      ...(Object.keys(varsSnapshot).length > 0 ? { varsSnapshot } : {}),
    };
  }

  private buildContinuationOutput(
    stepId: string,
    error: string,
    superNodeTrace?: WorkflowStepResult['superNodeTrace'],
  ): string {
    try {
      return JSON.stringify(
        {
          status: 'error',
          stepId,
          error,
          ...(superNodeTrace ? { superNodeTrace } : {}),
        },
        null,
        2,
      );
    } catch {
      return `Workflow step '${stepId}' failed: ${error}`;
    }
  }

  private advanceState(
    state: WorkflowProcessState,
    updates: Pick<WorkflowProcessState, 'prevOutputs' | 'stepVars'> & {
      stepResults: WorkflowStepResult[];
    },
    now: number,
    nextStepIndex = state.currentStepIndex + 1,
  ): WorkflowProcessState {
    const done = nextStepIndex >= state.workflow.steps.length;
    return {
      ...state,
      phase: done ? 'done' : 'running',
      currentStepId: done ? undefined : resolveWorkflowStepId(state.workflow, nextStepIndex),
      currentStepIndex: nextStepIndex,
      currentAttempt: 0,
      prevOutputs: updates.prevOutputs,
      stepVars: updates.stepVars,
      run: {
        ...state.run,
        stepResults: updates.stepResults,
        status: done ? 'done' : 'running',
        ...(done ? { finishedAt: now } : {}),
      },
    };
  }

  private finishState(
    state: WorkflowProcessState,
    phase: 'done' | 'error',
    now: number,
  ): WorkflowProcessState {
    return {
      ...state,
      phase,
      currentStepId:
        phase === 'done'
          ? undefined
          : resolveWorkflowStepId(
              state.workflow,
              resolveWorkflowStepIndex(state.workflow, state.currentStepId, state.currentStepIndex),
            ),
      run: {
        ...state.run,
        status: phase,
        finishedAt: now,
      },
    };
  }

  private failState(
    state: WorkflowProcessState,
    error: ProcessErrorEvent,
    now: number,
  ): WorkflowProcessState {
    return {
      ...state,
      phase: 'error',
      error,
      run: {
        ...state.run,
        status: 'error',
        finishedAt: now,
      },
    };
  }
}
