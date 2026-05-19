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
  type WorkflowSuperNodeChildLineage,
  type WorkflowSuperNodeParticipantResult,
  type WorkflowSuperNodeTrace,
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
  retrySuperNodeTrace?: WorkflowStepResult['superNodeTrace'];
  error?: ProcessErrorEvent;
}

export interface WorkflowAgentStepRequest {
  runId: string;
  stepId: string;
  agentId: string;
  message: string;
  threadKey: string;
  delegatedRunId?: string;
  /** Called for each streamed text token from the LLM during this step. */
  onToken?: (token: string) => void;
}

export interface WorkflowAgentStepExecutionResult {
  output: string;
  delegatedAgentId?: string;
  delegatedRunId?: string;
  delegatedRunStatus?: 'ready' | 'waiting' | 'suspended' | 'done' | 'error';
}

export interface WorkflowHttpStepRequest {
  stepId: string;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: string;
}

export interface WorkflowRuntimeHandlers {
  runAgentStep?(
    request: WorkflowAgentStepRequest,
  ): Promise<string | WorkflowAgentStepExecutionResult>;
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
          coordinatorLineage: { ...step.superNodeTrace.coordinatorLineage },
          participantResults: step.superNodeTrace.participantResults.map((item) => ({
            ...item,
            lineage: { ...item.lineage },
          })),
        }
      : undefined,
    varsSnapshot: step.varsSnapshot ? { ...step.varsSnapshot } : undefined,
  }));
}

interface WorkflowStepExecutionResult {
  output: string;
  superNodeTrace?: WorkflowStepResult['superNodeTrace'];
  delegatedAgentId?: string;
  delegatedRunId?: string;
  delegatedRunStatus?: 'ready' | 'waiting' | 'suspended' | 'done' | 'error';
}

class WorkflowSuperNodeExecutionError extends Error {
  readonly trace: WorkflowStepResult['superNodeTrace'];
  readonly stage: 'participant' | 'coordinator';
  readonly delegatedAgentId?: string;
  readonly delegatedRunId?: string;
  readonly delegatedRunStatus?: 'ready' | 'waiting' | 'suspended' | 'done' | 'error';

  constructor(
    message: string,
    trace: WorkflowStepResult['superNodeTrace'],
    stage: 'participant' | 'coordinator',
    delegated?: Pick<
      WorkflowStepResult,
      'delegatedAgentId' | 'delegatedRunId' | 'delegatedRunStatus'
    >,
  ) {
    super(message);
    this.name = 'WorkflowSuperNodeExecutionError';
    this.trace = trace;
    this.stage = stage;
    this.delegatedAgentId = delegated?.delegatedAgentId;
    this.delegatedRunId = delegated?.delegatedRunId;
    this.delegatedRunStatus = delegated?.delegatedRunStatus;
  }
}

function buildSuperNodeChildLineage(params: {
  parentRunId: string;
  parentStepId: string;
  childStepId: string;
  threadKey: string;
  role: 'participant' | 'coordinator';
  participantIndex?: number;
}): WorkflowSuperNodeChildLineage {
  return {
    parentRunId: params.parentRunId,
    parentStepId: params.parentStepId,
    childStepId: params.childStepId,
    threadKey: params.threadKey,
    role: params.role,
    ...(params.participantIndex !== undefined ? { participantIndex: params.participantIndex } : {}),
  };
}

function canReuseParticipantResults(
  trace: WorkflowStepResult['superNodeTrace'] | undefined,
): trace is WorkflowSuperNodeTrace {
  const participantResults = trace?.participantResults;
  return Boolean(
    participantResults?.every(
      (item) => item.status === 'done' || item.delegatedRunStatus === 'suspended',
    ) && !participantResults.some((item) => item.status === 'error'),
  );
}

function getDelegatedRunMetadata(
  value: unknown,
): Pick<WorkflowSuperNodeParticipantResult, 'delegatedRunId' | 'delegatedRunStatus'> {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const candidate = value as {
    delegatedRunId?: unknown;
    delegatedRunStatus?: unknown;
  };
  return {
    ...(typeof candidate.delegatedRunId === 'string'
      ? { delegatedRunId: candidate.delegatedRunId }
      : {}),
    ...(candidate.delegatedRunStatus === 'ready' ||
    candidate.delegatedRunStatus === 'waiting' ||
    candidate.delegatedRunStatus === 'suspended' ||
    candidate.delegatedRunStatus === 'done' ||
    candidate.delegatedRunStatus === 'error'
      ? { delegatedRunStatus: candidate.delegatedRunStatus }
      : {}),
  };
}

function workflowThreadKey(runId: string, stepIndex: number, suffix?: string): string {
  return suffix
    ? `workflow:${runId}:step${stepIndex}:${suffix}`
    : `workflow:${runId}:step${stepIndex}`;
}

function hasCoordinatorAttempted(trace: WorkflowSuperNodeTrace | undefined): boolean {
  return Boolean(
    trace &&
      (trace.coordinatorStartedAt !== undefined ||
        trace.coordinatorStatus !== undefined ||
        trace.coordinatorDelegatedRunStatus !== undefined),
  );
}

function normalizeWorkflowAgentStepExecutionResult(
  result: string | WorkflowAgentStepExecutionResult,
): WorkflowAgentStepExecutionResult {
  return typeof result === 'string' ? { output: result } : result;
}

function upsertStepResult(
  stepResults: WorkflowStepResult[],
  nextResult: WorkflowStepResult,
): WorkflowStepResult[] {
  const next = cloneStepResults(stepResults);
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const current = next[index];
    if (
      current?.stepId === nextResult.stepId &&
      current.delegatedRunStatus === 'suspended' &&
      (current.delegatedRunId === nextResult.delegatedRunId ||
        Boolean(current.superNodeTrace && nextResult.superNodeTrace))
    ) {
      next[index] = nextResult;
      return next;
    }
  }
  next.push(nextResult);
  return next;
}

function findSuspendedDelegatedRunId(
  stepResults: WorkflowStepResult[],
  stepId: string,
): string | undefined {
  for (let index = stepResults.length - 1; index >= 0; index -= 1) {
    const result = stepResults[index];
    if (result?.stepId === stepId && result.delegatedRunStatus === 'suspended') {
      return result.delegatedRunId;
    }
  }
  return undefined;
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
      .slice(0, fromStepIndex) // don't include appended step result in prevOutputs
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
          const stepBucket = stepVars[sid] ?? {};
          stepBucket[vname] = value;
          stepVars[sid] = stepBucket;
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

      const successStepResult = this.buildSuccessStepResult(
        step.id,
        execution.output,
        stepVars,
        execution.superNodeTrace,
        {
          startedAt: stepStartedAt,
          finishedAt: stepFinishedAt,
        },
        {
          delegatedAgentId: execution.delegatedAgentId,
          delegatedRunId: execution.delegatedRunId,
          delegatedRunStatus: execution.delegatedRunStatus,
        },
      );
      const nextStepResults = upsertStepResult(stepResults, successStepResult);
      const nextState = this.advanceState(
        state,
        {
          stepResults: nextStepResults,
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
      const delegated =
        error && typeof error === 'object'
          ? (error as {
              delegatedAgentId?: string;
              delegatedRunId?: string;
              delegatedRunStatus?: 'ready' | 'waiting' | 'suspended' | 'done' | 'error';
            })
          : null;
      const errorFinishedAt = Date.now();
      if (delegated?.delegatedRunStatus === 'suspended') {
        const retrySuperNodeTrace =
          error instanceof WorkflowSuperNodeExecutionError ? error.trace : undefined;
        return {
          signal: 'SUSPENDED',
          state: {
            ...state,
            currentAttempt: 0,
            ...(retrySuperNodeTrace ? { retrySuperNodeTrace } : {}),
            run: {
              ...state.run,
              status: 'suspended',
              stepResults: upsertStepResult(stepResults, {
                stepId: step.id,
                error: messageText,
                ...(delegated.delegatedAgentId
                  ? { delegatedAgentId: delegated.delegatedAgentId }
                  : {}),
                ...(delegated.delegatedRunId ? { delegatedRunId: delegated.delegatedRunId } : {}),
                delegatedRunStatus: 'suspended',
                finishedAt: errorFinishedAt,
                ...(superNodeTrace ? { superNodeTrace } : {}),
              }),
            },
          },
        };
      }
      if (state.currentAttempt < maxRetries) {
        const retrySuperNodeTrace =
          error instanceof WorkflowSuperNodeExecutionError && error.stage === 'coordinator'
            ? error.trace
            : undefined;
        return {
          signal: 'RETRYABLE_ERROR',
          error: buildError('WORKFLOW_STEP_RETRYABLE_ERROR', messageText, true),
          state: {
            ...state,
            currentAttempt: state.currentAttempt + 1,
            ...(retrySuperNodeTrace ? { retrySuperNodeTrace } : {}),
          },
          delayMs: 0,
        };
      }

      const failedStepResult: WorkflowStepResult = {
        stepId: step.id,
        error: messageText,
        ...(delegated?.delegatedAgentId ? { delegatedAgentId: delegated.delegatedAgentId } : {}),
        ...(delegated?.delegatedRunId ? { delegatedRunId: delegated.delegatedRunId } : {}),
        ...(delegated?.delegatedRunStatus
          ? { delegatedRunStatus: delegated.delegatedRunStatus }
          : {}),
        finishedAt: errorFinishedAt,
        ...(superNodeTrace ? { superNodeTrace } : {}),
      };
      const nextStepResults = upsertStepResult(stepResults, failedStepResult);
      if (step.condition === 'on_success') {
        const finalError = buildError('WORKFLOW_STEP_FATAL_ERROR', messageText, false);
        return {
          signal: 'ERROR',
          error: finalError,
          state: {
            ...this.failState(state, finalError, errorFinishedAt),
            run: {
              ...state.run,
              stepResults: nextStepResults,
              status: 'error',
              finishedAt: errorFinishedAt,
            },
            currentAttempt: 0,
            retrySuperNodeTrace: undefined,
          },
        };
      }

      const nextState = this.advanceState(
        state,
        {
          stepResults: nextStepResults,
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
          ? (token: string) => this.handlers.onToken?.(state.run.runId, step.id, token)
          : undefined;
        const execution = normalizeWorkflowAgentStepExecutionResult(
          await this.handlers.runAgentStep({
            runId: state.run.runId,
            stepId: step.id,
            agentId,
            message: applyFormatInstruction(step, message),
            threadKey: workflowThreadKey(state.run.runId, currentStepIndex),
            delegatedRunId: findSuspendedDelegatedRunId(state.run.stepResults, step.id),
            onToken,
          }),
        );
        return {
          ...execution,
          delegatedAgentId: execution.delegatedAgentId ?? agentId,
          output: execution.output.trim(),
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
    const runAgentStep = this.handlers.runAgentStep;

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
    const reusableTrace = canReuseParticipantResults(state.retrySuperNodeTrace)
      ? state.retrySuperNodeTrace
      : undefined;
    const participantResults: WorkflowSuperNodeParticipantResult[] = await Promise.all(
      participantAgentIds.map(async (agentId, index) => {
        const reusableItem = reusableTrace?.participantResults.find(
          (item) => item.lineage.participantIndex === index + 1,
        );
        if (reusableItem?.status === 'done') {
          return {
            ...reusableItem,
            lineage: { ...reusableItem.lineage },
          };
        }

        const rolePrompt = rolePrompts[index] ?? `补充视角 ${index + 1}`;
        const participantStepId = `${step.id}:participant:${index + 1}`;
        const participantThreadKey = workflowThreadKey(
          state.run.runId,
          currentStepIndex,
          `participant-${index + 1}`,
        );
        const participantStartedAt = Date.now();
        try {
          const execution = normalizeWorkflowAgentStepExecutionResult(
            await runAgentStep({
              runId: state.run.runId,
              stepId: participantStepId,
              agentId,
              message: buildWorkflowSuperNodeParticipantPrompt({
                type,
                baseMessage: message,
                rolePrompt,
                index,
                total: participantAgentIds.length,
                domainRules: step.domainRules,
              }),
              threadKey: participantThreadKey,
              delegatedRunId:
                reusableItem?.delegatedRunStatus === 'suspended'
                  ? reusableItem.delegatedRunId
                  : undefined,
            }),
          );

          return {
            agentId,
            status: 'done',
            prompt: rolePrompt,
            startedAt: participantStartedAt,
            finishedAt: Date.now(),
            lineage: buildSuperNodeChildLineage({
              parentRunId: state.run.runId,
              parentStepId: step.id,
              childStepId: participantStepId,
              threadKey: participantThreadKey,
              role: 'participant',
              participantIndex: index + 1,
            }),
            output: execution.output.trim(),
            ...getDelegatedRunMetadata(execution),
          };
        } catch (error) {
          const delegatedMetadata = getDelegatedRunMetadata(error);
          return {
            agentId,
            status: delegatedMetadata.delegatedRunStatus === 'suspended' ? 'suspended' : 'error',
            prompt: rolePrompt,
            startedAt: participantStartedAt,
            finishedAt: Date.now(),
            lineage: buildSuperNodeChildLineage({
              parentRunId: state.run.runId,
              parentStepId: step.id,
              childStepId: participantStepId,
              threadKey: participantThreadKey,
              role: 'participant',
              participantIndex: index + 1,
            }),
            error: error instanceof Error ? error.message : String(error),
            ...delegatedMetadata,
          };
        }
      }),
    );

    const coordinatorThreadKey = workflowThreadKey(
      state.run.runId,
      currentStepIndex,
      'coordinator',
    );
    const coordinatorLineage = buildSuperNodeChildLineage({
      parentRunId: state.run.runId,
      parentStepId: step.id,
      childStepId: `${step.id}:coordinator`,
      threadKey: coordinatorThreadKey,
      role: 'coordinator',
    });

    const trace: WorkflowSuperNodeTrace = {
      type,
      parentRunId: state.run.runId,
      parentStepId: step.id,
      participantExecution: reusableTrace ? 'reused' : 'fresh',
      coordinatorAttempt: hasCoordinatorAttempted(reusableTrace)
        ? (reusableTrace?.coordinatorAttempt ?? 0) + 1
        : 1,
      coordinatorAgentId,
      coordinatorLineage,
      participantResults,
    };

    const failedParticipant = participantResults.find((item) => item.status !== 'done');
    if (failedParticipant) {
      const participantDelegated =
        failedParticipant.delegatedRunStatus === 'suspended'
          ? {
              delegatedAgentId: failedParticipant.agentId,
              delegatedRunId: failedParticipant.delegatedRunId,
              delegatedRunStatus: 'suspended' as const,
            }
          : undefined;
      throw new WorkflowSuperNodeExecutionError(
        `Super node '${step.id}' participant '${failedParticipant.agentId}' ${failedParticipant.status === 'suspended' ? 'suspended' : 'failed'}: ${failedParticipant.error}`,
        trace,
        'participant',
        participantDelegated,
      );
    }

    const coordinatorPrompt = buildWorkflowSuperNodeCoordinatorPrompt({
      step,
      participantResults,
      baseMessage: message,
      previousOutput: state.prevOutputs[state.prevOutputs.length - 1] ?? '',
    });
    const coordinatorStartedAt = Date.now();

    try {
      const execution = normalizeWorkflowAgentStepExecutionResult(
        await runAgentStep({
          runId: state.run.runId,
          stepId: step.id,
          agentId: coordinatorAgentId,
          message: applyFormatInstruction(step, coordinatorPrompt),
          threadKey: coordinatorThreadKey,
          delegatedRunId:
            reusableTrace?.coordinatorDelegatedRunStatus === 'suspended'
              ? reusableTrace.coordinatorDelegatedRunId
              : undefined,
        }),
      );
      return {
        ...execution,
        delegatedAgentId: execution.delegatedAgentId ?? coordinatorAgentId,
        output: execution.output.trim(),
        superNodeTrace: {
          ...trace,
          coordinatorStatus: 'done',
          coordinatorStartedAt,
          coordinatorFinishedAt: Date.now(),
          ...(execution.delegatedRunId
            ? { coordinatorDelegatedRunId: execution.delegatedRunId }
            : {}),
          ...(execution.delegatedRunStatus
            ? { coordinatorDelegatedRunStatus: execution.delegatedRunStatus }
            : {}),
        },
      };
    } catch (error) {
      const delegatedMetadata = getDelegatedRunMetadata(error);
      throw new WorkflowSuperNodeExecutionError(
        error instanceof Error ? error.message : String(error),
        {
          ...trace,
          coordinatorStatus:
            delegatedMetadata.delegatedRunStatus === 'suspended' ? 'suspended' : 'error',
          coordinatorStartedAt,
          coordinatorFinishedAt: Date.now(),
          ...(delegatedMetadata.delegatedRunId
            ? { coordinatorDelegatedRunId: delegatedMetadata.delegatedRunId }
            : {}),
          ...(delegatedMetadata.delegatedRunStatus
            ? { coordinatorDelegatedRunStatus: delegatedMetadata.delegatedRunStatus }
            : {}),
        },
        'coordinator',
        {
          delegatedAgentId: coordinatorAgentId,
          delegatedRunId: delegatedMetadata.delegatedRunId,
          delegatedRunStatus: delegatedMetadata.delegatedRunStatus,
        },
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
    delegated?: Pick<
      WorkflowStepResult,
      'delegatedAgentId' | 'delegatedRunId' | 'delegatedRunStatus'
    >,
  ): WorkflowStepResult {
    const varsSnapshot = snapshotVars(stepVars);
    return {
      stepId,
      output,
      ...(timing ? { startedAt: timing.startedAt, finishedAt: timing.finishedAt } : {}),
      ...(delegated?.delegatedAgentId ? { delegatedAgentId: delegated.delegatedAgentId } : {}),
      ...(delegated?.delegatedRunId ? { delegatedRunId: delegated.delegatedRunId } : {}),
      ...(delegated?.delegatedRunStatus
        ? { delegatedRunStatus: delegated.delegatedRunStatus }
        : {}),
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
      retrySuperNodeTrace: undefined,
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
