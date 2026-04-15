import { ulid } from 'ulid';
import { createLogger } from '../logger.js';
import type { ProcessId } from '../types.js';
import { asProcessId } from '../types.js';
import { PriorityScheduler } from './priority-scheduler.js';
import type {
  CheckpointStore,
  CreateProcessOptions,
  KernelProcessSnapshot,
  KernelTickResult,
  ProcessRuntime,
  SyscallResolution,
} from './types.js';

const logger = createLogger('kernel:agent-kernel');

export interface AgentKernelDeps {
  checkpointStore: CheckpointStore;
  scheduler?: PriorityScheduler;
  now?: () => number;
}

type RuntimeRegistry = Map<string, ProcessRuntime<unknown, unknown>>;

function toFatalError(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof Error) {
    return {
      code: 'UNCAUGHT_PROCESS_ERROR',
      message: error.message,
      retryable: false,
    };
  }
  return {
    code: 'UNCAUGHT_PROCESS_ERROR',
    message: String(error),
    retryable: false,
  };
}

export class AgentKernel {
  private readonly checkpointStore: CheckpointStore;
  private readonly scheduler: PriorityScheduler;
  private readonly now: () => number;
  private readonly runtimes: RuntimeRegistry = new Map();
  private readonly snapshots = new Map<ProcessId, KernelProcessSnapshot>();

  constructor(deps: AgentKernelDeps) {
    this.checkpointStore = deps.checkpointStore;
    this.scheduler = deps.scheduler ?? new PriorityScheduler();
    this.now = deps.now ?? (() => Date.now());
  }

  registerProcessRuntime<TState, TInput>(runtime: ProcessRuntime<TState, TInput>): void {
    if (this.runtimes.has(runtime.type)) {
      throw new Error(`Process runtime '${runtime.type}' is already registered`);
    }
    this.runtimes.set(runtime.type, runtime as ProcessRuntime<unknown, unknown>);
  }

  async restoreFromCheckpoints(): Promise<number> {
    const snapshots = await this.checkpointStore.list();
    let restored = 0;
    for (const snapshot of snapshots) {
      if (!this.runtimes.has(snapshot.processType)) {
        logger.warn('Skipping checkpoint for unknown runtime', {
          pid: snapshot.pid,
          processType: snapshot.processType,
        });
        continue;
      }
      this.snapshots.set(snapshot.pid, snapshot);
      restored += 1;
    }
    return restored;
  }

  async createProcess<TInput>(
    options: CreateProcessOptions<TInput>,
  ): Promise<KernelProcessSnapshot> {
    const runtime = this.getRuntime(options.processType) as ProcessRuntime<unknown, TInput>;
    const createdAt = options.createdAt ?? this.now();
    const pid = options.processId ?? asProcessId(ulid());
    const state = runtime.serialize(runtime.createInitialState(options.input));
    const snapshot: KernelProcessSnapshot = {
      pid,
      processType: options.processType,
      version: runtime.version,
      status: 'ready',
      priority: options.priority ?? 'normal',
      state,
      createdAt,
      updatedAt: createdAt,
      runCount: 0,
      retryCount: 0,
      metadata: options.metadata ?? {},
    };

    this.snapshots.set(pid, snapshot);
    await this.checkpointStore.save(snapshot);
    return snapshot;
  }

  getSnapshot(pid: ProcessId): KernelProcessSnapshot | null {
    return this.snapshots.get(pid) ?? null;
  }

  listSnapshots(): KernelProcessSnapshot[] {
    return Array.from(this.snapshots.values());
  }

  async tick(): Promise<KernelTickResult> {
    const now = this.now();
    const candidate = this.scheduler.selectNext(this.listSnapshots(), now);
    if (!candidate) {
      return { kind: 'idle' };
    }

    const liveCandidate = this.getSnapshot(candidate.pid);
    if (!liveCandidate) {
      return { kind: 'idle' };
    }

    const runtime = this.getRuntime(candidate.processType);
    const running = this.updateSnapshot(liveCandidate.pid, {
      status: 'running',
      updatedAt: now,
    });

    try {
      const state = runtime.deserialize(running.state);
      const result = await runtime.step(state, {
        pid: running.pid,
        now,
        runCount: running.runCount,
        retryCount: running.retryCount,
        pendingSyscall: running.pendingSyscall,
        lastSyscallResult: running.lastSyscallResult,
        metadata: running.metadata,
      });

      if (!this.getSnapshot(running.pid)) {
        return { kind: 'idle' };
      }

      const nextSnapshot = this.applyStepResult(running, runtime, result, now);
      await this.checkpointStore.save(nextSnapshot);
      this.snapshots.set(nextSnapshot.pid, nextSnapshot);
      return {
        kind: 'executed',
        pid: nextSnapshot.pid,
        signal: result.signal,
        status: nextSnapshot.status,
      };
    } catch (error) {
      if (!this.getSnapshot(running.pid)) {
        return { kind: 'idle' };
      }

      const fatal = toFatalError(error);
      const errored = this.updateSnapshot(candidate.pid, {
        status: 'error',
        updatedAt: now,
        runCount: candidate.runCount + 1,
        lastSignal: 'ERROR',
        lastError: fatal,
        pendingSyscall: undefined,
      });
      await this.checkpointStore.save(errored);
      logger.error('Kernel step crashed', { pid: candidate.pid, error: fatal.message });
      return {
        kind: 'executed',
        pid: errored.pid,
        signal: 'ERROR',
        status: errored.status,
      };
    }
  }

  async resumeProcess(pid: ProcessId): Promise<KernelProcessSnapshot> {
    this.requireSnapshot(pid);
    const resumed = this.updateSnapshot(pid, {
      status: 'ready',
      nextRunAt: this.now(),
      updatedAt: this.now(),
    });
    await this.checkpointStore.save(resumed);
    return resumed;
  }

  async resolveSyscall(
    pid: ProcessId,
    resolution: SyscallResolution,
  ): Promise<KernelProcessSnapshot | null> {
    if (!this.snapshots.has(pid)) {
      // Process was deleted (e.g. cancelled) while we were awaiting the syscall — silently ignore
      logger.warn('resolveSyscall: process already deleted, ignoring', { pid });
      return null;
    }
    const updated = this.updateSnapshot(pid, {
      status: 'ready',
      updatedAt: resolution.resolvedAt,
      pendingSyscall: undefined,
      lastSyscallResult: resolution,
      lastError: resolution.ok ? undefined : resolution.error,
      nextRunAt: resolution.resolvedAt,
    });
    await this.checkpointStore.save(updated);
    return updated;
  }

  async deleteProcess(pid: ProcessId): Promise<void> {
    this.snapshots.delete(pid);
    await this.checkpointStore.delete(pid);
  }

  private applyStepResult(
    current: KernelProcessSnapshot,
    runtime: ProcessRuntime<unknown, unknown>,
    result: Awaited<ReturnType<ProcessRuntime<unknown, unknown>['step']>>,
    now: number,
  ): KernelProcessSnapshot {
    const nextState = runtime.serialize(result.state);
    const common = {
      state: nextState,
      updatedAt: now,
      runCount: current.runCount + 1,
      lastSignal: result.signal,
      metadata: result.metadata ?? current.metadata,
      lastError: result.error,
      lastSyscallResult: undefined,
    } satisfies Partial<KernelProcessSnapshot>;

    switch (result.signal) {
      case 'YIELD':
        return this.updateSnapshot(current.pid, {
          ...common,
          status: 'ready',
          pendingSyscall: undefined,
          nextRunAt: result.nextRunAt ?? now,
        });
      case 'WAITING_SYSCALL':
        return this.updateSnapshot(current.pid, {
          ...common,
          status: 'waiting',
          pendingSyscall: result.syscall,
          nextRunAt: undefined,
        });
      case 'SUSPENDED':
        return this.updateSnapshot(current.pid, {
          ...common,
          status: 'suspended',
          pendingSyscall: undefined,
          nextRunAt: result.nextRunAt,
        });
      case 'DONE':
        return this.updateSnapshot(current.pid, {
          ...common,
          status: 'done',
          pendingSyscall: undefined,
          nextRunAt: undefined,
        });
      case 'RETRYABLE_ERROR':
        return this.updateSnapshot(current.pid, {
          ...common,
          status: 'ready',
          retryCount: current.retryCount + 1,
          pendingSyscall: undefined,
          nextRunAt: this.scheduler.computeRetryAt(now, current.retryCount + 1, result.delayMs),
        });
      default:
        return this.updateSnapshot(current.pid, {
          ...common,
          status: 'error',
          pendingSyscall: undefined,
          nextRunAt: undefined,
        });
    }
  }

  private getRuntime(processType: string): ProcessRuntime<unknown, unknown> {
    const runtime = this.runtimes.get(processType);
    if (!runtime) {
      throw new Error(`Unknown process runtime '${processType}'`);
    }
    return runtime;
  }

  private requireSnapshot(pid: ProcessId): KernelProcessSnapshot {
    const snapshot = this.snapshots.get(pid);
    if (!snapshot) {
      throw new Error(`Unknown process '${pid}'`);
    }
    return snapshot;
  }

  private updateSnapshot(
    pid: ProcessId,
    updates: Partial<KernelProcessSnapshot>,
  ): KernelProcessSnapshot {
    const current = this.requireSnapshot(pid);
    const next = { ...current, ...updates };
    this.snapshots.set(pid, next);
    return next;
  }
}
