import type { ProcessRuntime, SyscallRequest, SyscallResolution } from '../core/kernel/types.js';
import type { ProcessStepContext, ProcessStepResult } from '../core/kernel/types.js';
import type { ProcessErrorEvent } from '../core/kernel/types.js';
import type { StreamChunk } from '../core/types.js';
import type {
  RunnerOptions,
  SerializedAgentRunnerState,
  SerializedAgentTurnExecutionState,
  TurnResult,
} from './runner.js';
import type { AgentRunner } from './runner.js';

export interface AgentTurnProcessInput {
  agentId: string;
  runId?: string;
  userMessage: string;
  options?: RunnerOptions;
  threadKey?: string;
}

export interface AgentTurnProcessState {
  phase:
    | 'pending'
    | 'running'
    | 'waiting_llm'
    | 'waiting_approval'
    | 'waiting_tool'
    | 'suspended'
    | 'done'
    | 'error';
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

function buildError(message: string, retryable = false): ProcessErrorEvent {
  return {
    code: retryable ? 'AGENT_TURN_RETRYABLE_ERROR' : 'AGENT_TURN_ERROR',
    message,
    retryable,
  };
}

function normalizeThreadKey(runner: AgentRunner, requested?: string): string {
  if (requested && requested.trim().length > 0) {
    return requested;
  }
  return 'default';
}

function buildInitialRunnerState(
  runner: AgentRunner,
  threadKey: string,
): SerializedAgentRunnerState {
  return {
    threadKey,
    toolResultCache: [],
  };
}

function resolveRunner(runners: AgentRunnerResolver, agentId: string): AgentRunner {
  const runner = runners instanceof Map ? runners.get(agentId) : runners(agentId);
  if (!runner) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  return runner;
}

function syncRunnerRuntimeState(runner: AgentRunner, state: AgentTurnProcessState): void {
  const candidate = runner as AgentRunner & {
    syncRuntimeState?: (
      threadKey: string,
      runId: string | null,
      toolResultCache?: SerializedAgentRunnerState['toolResultCache'],
    ) => void;
  };
  if (candidate.syncRuntimeState) {
    candidate.syncRuntimeState(state.threadKey, state.runId, state.runnerState.toolResultCache);
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
    ) => void;
  };
  if (candidate.syncRuntimeState) {
    candidate.syncRuntimeState(state.threadKey, null, state.runnerState.toolResultCache);
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

  createInitialState(input: AgentTurnProcessInput): AgentTurnProcessState {
    const runner = resolveRunner(this.runners, input.agentId);
    const threadKey = normalizeThreadKey(runner, input.threadKey);
    return {
      phase: 'pending',
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
      if (request.kind === 'llm.generate') {
        return await runner.executeKernelLlmGenerateSyscall(
          state.executionState,
          request,
          resolvedAt,
        );
      }
      if (request.kind === 'custom' && request.operation === 'agent.turn.approval-request') {
        return await runner.executeKernelApprovalSyscall(state.executionState, request, resolvedAt);
      }
      if (request.kind === 'tool.call') {
        return await runner.executeKernelToolCallSyscall(
          state.executionState,
          request,
          resolvedAt,
          state.runnerState.toolResultCache,
        );
      }
      throw new Error(`Unsupported agent syscall kind '${request.kind}'`);
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
          return {
            signal: 'WAITING_SYSCALL',
            syscall: stepResult.syscall,
            state: {
              ...state,
              phase:
                stepResult.syscall?.kind === 'tool.call'
                  ? 'waiting_tool'
                  : stepResult.syscall?.kind === 'llm.generate'
                    ? 'waiting_llm'
                    : 'waiting_approval',
              executionState: stepResult.state,
              runnerState: runner.serializeState(),
              error: undefined,
            },
          };
        }
        if (state.phase === 'pending') {
          syncRunnerPendingState(runner, state);
          const executionState = await runner.beginKernelTurn(
            state.runId,
            state.userMessage,
            state.options,
          );
          return {
            signal: 'YIELD',
            nextRunAt: _context.now,
            state: {
              ...state,
              phase: 'running',
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
          const stream = [...state.stream];
          for (const chunk of stepResult.chunks) {
            stream.push(chunk);
            this.callbacks.onChunk?.(state.runId, chunk);
          }

          if (stepResult.done && stepResult.result) {
            return {
              signal: 'DONE',
              state: {
                ...state,
                phase: 'done',
                executionState: stepResult.state,
                runnerState: runner.serializeState(),
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
                ...state,
                phase: 'suspended',
                executionState: stepResult.state,
                runnerState: runner.serializeState(),
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
                ...state,
                phase:
                  stepResult.syscall.kind === 'tool.call'
                    ? 'waiting_tool'
                    : stepResult.syscall.kind === 'llm.generate'
                      ? 'waiting_llm'
                      : 'waiting_approval',
                executionState: stepResult.state,
                runnerState: runner.serializeState(),
                stream,
              },
            };
          }

          return {
            signal: 'YIELD',
            nextRunAt: _context.now,
            state: {
              ...state,
              phase: 'running',
              executionState: stepResult.state,
              runnerState: runner.serializeState(),
              stream,
            },
          };
        }

        if (state.phase === 'waiting_tool') {
          if (!_context.lastSyscallResult) {
            throw new Error(`Agent tool syscall resolution is missing for run '${state.runId}'`);
          }

          const stepResult = await runner.applyKernelToolCallSyscall(
            state.executionState,
            _context.lastSyscallResult,
          );
          const stream = [...state.stream];
          for (const chunk of stepResult.chunks) {
            stream.push(chunk);
            this.callbacks.onChunk?.(state.runId, chunk);
          }

          if (stepResult.done && stepResult.result) {
            return {
              signal: 'DONE',
              state: {
                ...state,
                phase: 'done',
                executionState: stepResult.state,
                runnerState: runner.serializeState(),
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
                ...state,
                phase: 'suspended',
                executionState: stepResult.state,
                runnerState: runner.serializeState(),
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
                ...state,
                phase:
                  stepResult.syscall.kind === 'tool.call'
                    ? 'waiting_tool'
                    : stepResult.syscall.kind === 'llm.generate'
                      ? 'waiting_llm'
                      : 'waiting_approval',
                executionState: stepResult.state,
                runnerState: runner.serializeState(),
                stream,
              },
            };
          }

          return {
            signal: 'YIELD',
            nextRunAt: _context.now,
            state: {
              ...state,
              phase: 'running',
              executionState: stepResult.state,
              runnerState: runner.serializeState(),
              stream,
            },
          };
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
          const stream = [...state.stream];
          for (const chunk of stepResult.chunks) {
            stream.push(chunk);
            this.callbacks.onChunk?.(state.runId, chunk);
          }

          if (stepResult.done && stepResult.result) {
            return {
              signal: 'DONE',
              state: {
                ...state,
                phase: 'done',
                executionState: stepResult.state,
                runnerState: runner.serializeState(),
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
                ...state,
                phase: 'suspended',
                executionState: stepResult.state,
                runnerState: runner.serializeState(),
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
                ...state,
                phase:
                  stepResult.syscall.kind === 'tool.call'
                    ? 'waiting_tool'
                    : stepResult.syscall.kind === 'llm.generate'
                      ? 'waiting_llm'
                      : 'waiting_approval',
                executionState: stepResult.state,
                runnerState: runner.serializeState(),
                stream,
              },
            };
          }

          return {
            signal: 'YIELD',
            nextRunAt: _context.now,
            state: {
              ...state,
              phase: 'running',
              executionState: stepResult.state,
              runnerState: runner.serializeState(),
              stream,
            },
          };
        }

        if (state.phase === 'running') {
          const stepResult = await runner.continueKernelTurn(state.executionState);
          const stream = [...state.stream];
          for (const chunk of stepResult.chunks) {
            stream.push(chunk);
            this.callbacks.onChunk?.(state.runId, chunk);
          }

          if (stepResult.done && stepResult.result) {
            return {
              signal: 'DONE',
              state: {
                ...state,
                phase: 'done',
                executionState: stepResult.state,
                runnerState: runner.serializeState(),
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
                ...state,
                phase: 'suspended',
                executionState: stepResult.state,
                runnerState: runner.serializeState(),
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
                ...state,
                phase:
                  stepResult.syscall.kind === 'tool.call'
                    ? 'waiting_tool'
                    : stepResult.syscall.kind === 'llm.generate'
                      ? 'waiting_llm'
                      : 'waiting_approval',
                executionState: stepResult.state,
                runnerState: runner.serializeState(),
                stream,
              },
            };
          }

          return {
            signal: 'YIELD',
            nextRunAt: _context.now,
            state: {
              ...state,
              executionState: stepResult.state,
              runnerState: runner.serializeState(),
              stream,
            },
          };
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
            ...state,
            phase: 'error',
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
    return state;
  }

  deserialize(payload: unknown): AgentTurnProcessState {
    return payload as AgentTurnProcessState;
  }
}
