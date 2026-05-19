import type { ProcessRuntime, SyscallRequest, SyscallResolution } from '../core/kernel/types.js';
import type { ProcessStepContext, ProcessStepResult } from '../core/kernel/types.js';
import type { ProcessErrorEvent } from '../core/kernel/types.js';
import type { StreamChunk } from '../core/types.js';
import type {
  KernelTurnStepResult,
  RunnerLeaseSyncMode,
  RunnerOptions,
  SerializedAgentRunnerState,
  SerializedAgentTurnExecutionState,
  TurnResult,
} from './runner.js';
import type { AgentRunner } from './runner.js';
import {
  type AgentTurnControlState,
  type AgentTurnPhase,
  deriveAgentTurnControlStateForPhase,
  deriveRunnerLeaseModeForAgentTurnPhase,
} from './turn-phase-contract.js';

export interface AgentTurnProcessInput {
  agentId: string;
  runId?: string;
  userMessage: string;
  options?: RunnerOptions;
  threadKey?: string;
}

export interface AgentTurnProcessState {
  phase: AgentTurnPhase;
  controlState?: AgentTurnControlState;
  runId: string;
  agentId: string;
  userMessage: string;
  options?: RunnerOptions;
  threadKey: string;
  runnerState: SerializedAgentRunnerState;
  executionState?: SerializedAgentTurnExecutionState;
  stream: StreamChunk[];
  result?: TurnResult;
  error?: ProcessErrorEvent;
}

export interface AgentTurnProcessRuntimeCallbacks {
  onChunk?(runId: string, chunk: StreamChunk): void;
}

type AgentRunnerResolver =
  | Map<string, AgentRunner>
  | ((agentId: string) => AgentRunner | undefined);

type AgentWaitingPhase = Extract<
  AgentTurnProcessState['phase'],
  'waiting_llm' | 'waiting_approval' | 'waiting_tool'
>;

type AgentSyscallExecutor = 'llm' | 'tool' | 'approval';

interface AgentSyscallBinding {
  kind: SyscallRequest['kind'];
  operation: string;
  phase: AgentWaitingPhase;
  executor: AgentSyscallExecutor;
}

const AGENT_SYSCALL_BINDINGS: readonly AgentSyscallBinding[] = [
  {
    kind: 'llm.generate',
    operation: 'agent.turn.generate',
    phase: 'waiting_llm',
    executor: 'llm',
  },
  {
    kind: 'tool.call',
    operation: 'agent.turn.tool-call-batch',
    phase: 'waiting_tool',
    executor: 'tool',
  },
  {
    kind: 'custom',
    operation: 'agent.turn.approval-request',
    phase: 'waiting_approval',
    executor: 'approval',
  },
];

function buildError(message: string, retryable = false): ProcessErrorEvent {
  return {
    code: retryable ? 'AGENT_TURN_RETRYABLE_ERROR' : 'AGENT_TURN_ERROR',
    message,
    retryable,
  };
}

function normalizeThreadKey(_runner: AgentRunner, requested?: string): string {
  if (requested && requested.trim().length > 0) {
    return requested;
  }
  return 'default';
}

function buildInitialRunnerState(
  runner: AgentRunner,
  threadKey: string,
): SerializedAgentRunnerState {
  const snapshot = runner.serializeState();
  const defaultThreadKey =
    (runner as AgentRunner & { defaultThreadKey?: string }).defaultThreadKey ??
    snapshot.defaultThreadKey ??
    'default';
  return {
    activeThreadKey: threadKey,
    defaultThreadKey,
    toolResultCache: threadKey === defaultThreadKey ? snapshot.toolResultCache : [],
    promptLayerHashes: snapshot.promptLayerHashes ?? [],
    cachedSystemPrompt: snapshot.cachedSystemPrompt ?? null,
  };
}

function resolveRunner(runners: AgentRunnerResolver, agentId: string): AgentRunner {
  const runner = runners instanceof Map ? runners.get(agentId) : runners(agentId);
  if (!runner) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  return runner;
}

function resolveAgentSyscallBinding(
  request: Pick<SyscallRequest, 'kind' | 'operation'>,
): AgentSyscallBinding {
  const binding = AGENT_SYSCALL_BINDINGS.find(
    (candidate) => candidate.kind === request.kind && candidate.operation === request.operation,
  );
  if (!binding) {
    throw new Error(`Unsupported agent syscall '${request.kind}:${request.operation}'`);
  }
  return binding;
}

function applyProcessPhase(
  state: AgentTurnProcessState,
  phase: AgentTurnProcessState['phase'],
): AgentTurnProcessState {
  return {
    ...state,
    phase,
    controlState: deriveAgentTurnControlStateForPhase(phase),
  };
}

function normalizeProcessState(state: AgentTurnProcessState): AgentTurnProcessState {
  if (state.controlState) {
    return state;
  }
  return {
    ...state,
    controlState: deriveAgentTurnControlStateForPhase(state.phase),
  };
}

function syncRunnerRuntimeState(runner: AgentRunner, state: AgentTurnProcessState): void {
  const candidate = runner as AgentRunner & {
    syncRuntimeState?: (
      threadKey: string,
      runId: string | null,
      toolResultCache?: SerializedAgentRunnerState['toolResultCache'],
      promptLayerHashes?: SerializedAgentRunnerState['promptLayerHashes'],
      cachedSystemPrompt?: SerializedAgentRunnerState['cachedSystemPrompt'],
      defaultThreadKey?: SerializedAgentRunnerState['defaultThreadKey'],
      leaseMode?: RunnerLeaseSyncMode,
    ) => void;
  };
  if (candidate.syncRuntimeState) {
    candidate.syncRuntimeState(
      state.threadKey,
      state.runId,
      state.runnerState.toolResultCache,
      state.runnerState.promptLayerHashes,
      state.runnerState.cachedSystemPrompt,
      state.runnerState.defaultThreadKey,
      deriveRunnerLeaseModeForAgentTurnPhase(state.phase),
    );
    return;
  }
  runner.restoreState(state.runnerState);
}

function syncRunnerPendingState(runner: AgentRunner, state: AgentTurnProcessState): void {
  const candidate = runner as AgentRunner & {
    syncRuntimeState?: (
      threadKey: string,
      runId: string | null,
      toolResultCache?: SerializedAgentRunnerState['toolResultCache'],
      promptLayerHashes?: SerializedAgentRunnerState['promptLayerHashes'],
      cachedSystemPrompt?: SerializedAgentRunnerState['cachedSystemPrompt'],
      defaultThreadKey?: SerializedAgentRunnerState['defaultThreadKey'],
      leaseMode?: RunnerLeaseSyncMode,
    ) => void;
  };
  if (candidate.syncRuntimeState) {
    candidate.syncRuntimeState(
      state.threadKey,
      null,
      state.runnerState.toolResultCache,
      state.runnerState.promptLayerHashes,
      state.runnerState.cachedSystemPrompt,
      state.runnerState.defaultThreadKey,
      'idle',
    );
    return;
  }
  runner.restoreState(state.runnerState);
}

export class AgentTurnProcessRuntime
  implements ProcessRuntime<AgentTurnProcessState, AgentTurnProcessInput>
{
  readonly type = 'agent.turn';
  readonly version = 1;
  private readonly runnerLocks = new WeakMap<AgentRunner, Promise<void>>();

  constructor(
    private readonly runners: AgentRunnerResolver,
    private readonly callbacks: AgentTurnProcessRuntimeCallbacks = {},
  ) {}

  private async withRunnerLock<T>(runner: AgentRunner, work: () => Promise<T>): Promise<T> {
    const previous = this.runnerLocks.get(runner) ?? Promise.resolve();
    const settledPrevious = previous.catch(() => undefined);
    const releaseCurrent: { current: (() => void) | null } = { current: null };
    const current = new Promise<void>((resolve) => {
      releaseCurrent.current = () => {
        resolve();
      };
    });
    const tail = settledPrevious.then(() => current);
    this.runnerLocks.set(runner, tail);
    await settledPrevious;
    try {
      return await work();
    } finally {
      releaseCurrent.current?.();
      if (this.runnerLocks.get(runner) === tail) {
        this.runnerLocks.delete(runner);
      }
    }
  }

  private phaseForSyscall(syscall: SyscallRequest): AgentWaitingPhase {
    return resolveAgentSyscallBinding(syscall).phase;
  }

  private appendChunks(runId: string, stream: StreamChunk[], chunks: StreamChunk[]): StreamChunk[] {
    const nextStream = [...stream];
    for (const chunk of chunks) {
      nextStream.push(chunk);
      this.callbacks.onChunk?.(runId, chunk);
    }
    return nextStream;
  }

  private buildStepProgressResult(
    state: AgentTurnProcessState,
    runner: AgentRunner,
    stepResult: KernelTurnStepResult,
    stream: StreamChunk[],
    nextRunAt: number,
  ): ProcessStepResult<AgentTurnProcessState> {
    const runnerState = runner.serializeState();

    if (stepResult.done && stepResult.result) {
      return {
        signal: 'DONE',
        state: {
          ...applyProcessPhase(state, 'done'),
          executionState: stepResult.state,
          runnerState,
          stream,
          result: stepResult.result,
        },
      };
    }

    if (stepResult.suspended) {
      return {
        signal: 'SUSPENDED',
        nextRunAt: stepResult.nextRunAt,
        error: stepResult.suspended,
        state: {
          ...applyProcessPhase(state, 'suspended'),
          executionState: stepResult.state,
          runnerState,
          stream,
          error: stepResult.suspended,
        },
      };
    }

    if (stepResult.syscall) {
      return {
        signal: 'WAITING_SYSCALL',
        syscall: stepResult.syscall,
        state: {
          ...applyProcessPhase(state, this.phaseForSyscall(stepResult.syscall)),
          executionState: stepResult.state,
          runnerState,
          stream,
          error: undefined,
        },
      };
    }

    return {
      signal: 'YIELD',
      nextRunAt,
      state: {
        ...applyProcessPhase(state, 'running'),
        executionState: stepResult.state,
        runnerState,
        stream,
        error: undefined,
      },
    };
  }

  createInitialState(input: AgentTurnProcessInput): AgentTurnProcessState {
    const runner = resolveRunner(this.runners, input.agentId);
    const threadKey = normalizeThreadKey(runner, input.threadKey);
    return {
      phase: 'pending',
      controlState: 'queued',
      runId: input.runId ?? `agent-turn:${input.agentId}`,
      agentId: input.agentId,
      userMessage: input.userMessage,
      options: input.options,
      threadKey,
      runnerState: buildInitialRunnerState(runner, threadKey),
      stream: [],
    };
  }

  async executePendingSyscall(
    state: AgentTurnProcessState,
    request: SyscallRequest,
    resolvedAt: number,
  ): Promise<SyscallResolution> {
    try {
      if (!state.executionState) {
        throw new Error(`Agent turn execution state is missing for run '${state.runId}'`);
      }
      const runner = resolveRunner(this.runners, state.agentId);
      const binding = resolveAgentSyscallBinding(request);
      if (binding.executor === 'llm') {
        return await runner.executeKernelLlmGenerateSyscall(
          state.executionState,
          request,
          resolvedAt,
        );
      }
      if (binding.executor === 'approval') {
        return await runner.executeKernelApprovalSyscall(state.executionState, request, resolvedAt);
      }
      if (binding.executor === 'tool') {
        return await runner.executeKernelToolCallSyscall(
          state.executionState,
          request,
          resolvedAt,
          state.runnerState.toolResultCache,
        );
      }
      throw new Error(`Unsupported agent syscall executor '${binding.executor}'`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        requestId: request.id,
        ok: false,
        error: buildError(message),
        resolvedAt,
      };
    }
  }

  async step(
    state: AgentTurnProcessState,
    _context: ProcessStepContext,
  ): Promise<ProcessStepResult<AgentTurnProcessState>> {
    state = normalizeProcessState(state);
    if (state.phase === 'done') {
      return {
        signal: 'DONE',
        state,
      };
    }

    if (state.phase === 'error') {
      return {
        signal: 'ERROR',
        state,
        error: state.error,
      };
    }

    const runner = resolveRunner(this.runners, state.agentId);
    return await this.withRunnerLock(runner, async () => {
      try {
        if (state.phase === 'suspended') {
          syncRunnerRuntimeState(runner, state);
          if (!state.executionState) {
            throw new Error(`Agent turn execution state is missing for run '${state.runId}'`);
          }
          const stepResult = await runner.resumeKernelTurn(state.executionState);
          return this.buildStepProgressResult(
            state,
            runner,
            stepResult,
            state.stream,
            _context.now,
          );
        }
        if (state.phase === 'pending') {
          syncRunnerPendingState(runner, state);
          const executionState = await runner.beginKernelTurn(
            state.runId,
            state.userMessage,
            state.options,
            state.threadKey,
          );
          return {
            signal: 'YIELD',
            nextRunAt: _context.now,
            state: {
              ...applyProcessPhase(state, 'running'),
              executionState,
              runnerState: runner.serializeState(),
            },
          };
        }

        if (!state.executionState) {
          throw new Error(`Agent turn execution state is missing for run '${state.runId}'`);
        }

        syncRunnerRuntimeState(runner, state);

        if (state.phase === 'waiting_llm') {
          if (!_context.lastSyscallResult) {
            throw new Error(`Agent llm syscall resolution is missing for run '${state.runId}'`);
          }

          const stepResult = await runner.applyKernelLlmGenerateSyscall(
            state.executionState,
            _context.lastSyscallResult,
          );
          const stream = this.appendChunks(state.runId, state.stream, stepResult.chunks);
          return this.buildStepProgressResult(state, runner, stepResult, stream, _context.now);
        }

        if (state.phase === 'waiting_tool') {
          if (!_context.lastSyscallResult) {
            throw new Error(`Agent tool syscall resolution is missing for run '${state.runId}'`);
          }

          const stepResult = await runner.applyKernelToolCallSyscall(
            state.executionState,
            _context.lastSyscallResult,
          );
          const stream = this.appendChunks(state.runId, state.stream, stepResult.chunks);
          return this.buildStepProgressResult(state, runner, stepResult, stream, _context.now);
        }

        if (state.phase === 'waiting_approval') {
          if (!_context.lastSyscallResult) {
            throw new Error(
              `Agent approval syscall resolution is missing for run '${state.runId}'`,
            );
          }

          const stepResult = await runner.applyKernelApprovalSyscall(
            state.executionState,
            _context.lastSyscallResult,
          );
          const stream = this.appendChunks(state.runId, state.stream, stepResult.chunks);
          return this.buildStepProgressResult(state, runner, stepResult, stream, _context.now);
        }

        if (state.phase === 'running') {
          const stepResult = await runner.continueKernelTurn(state.executionState);
          const stream = this.appendChunks(state.runId, state.stream, stepResult.chunks);
          return this.buildStepProgressResult(state, runner, stepResult, stream, _context.now);
        }
      } catch (error) {
        try {
          syncRunnerRuntimeState(runner, state);
          runner.forceReset();
        } catch {
          // Ignore cleanup failures and preserve the original execution error.
        }
        const message = error instanceof Error ? error.message : String(error);
        const processError = buildError(message);
        const errorChunk: StreamChunk = { type: 'error', message };
        this.callbacks.onChunk?.(state.runId, errorChunk);
        return {
          signal: 'ERROR',
          error: processError,
          state: {
            ...applyProcessPhase(state, 'error'),
            stream: [...state.stream, errorChunk],
            error: processError,
          },
        };
      }

      return {
        signal: 'YIELD',
        nextRunAt: _context.now,
        state,
      };
    });
  }

  serialize(state: AgentTurnProcessState): unknown {
    return normalizeProcessState(state);
  }

  deserialize(payload: unknown): AgentTurnProcessState {
    return normalizeProcessState(payload as AgentTurnProcessState);
  }
}
