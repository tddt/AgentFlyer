import { ulid } from 'ulid';
import {
  AgentKernel,
  type CheckpointStore,
  JsonFileCheckpointStore,
  type KernelProcessSnapshot,
  ScopedCheckpointStore,
} from '../core/kernel/index.js';
import type { ProcessStatus } from '../core/kernel/types.js';
import type { StreamChunk } from '../core/types.js';
import { asProcessId } from '../core/types.js';
import { drainWaitingAgentSyscalls } from './kernel-syscall-broker.js';
import {
  type AgentTurnProcessInput,
  AgentTurnProcessRuntime,
  type AgentTurnProcessState,
} from './process-runtime.js';
import type { AgentRunner } from './runner.js';
import type { TurnResult } from './runner.js';

type AgentRunnerResolver =
  | Map<string, AgentRunner>
  | ((agentId: string) => AgentRunner | undefined);

class InMemoryCheckpointStore implements CheckpointStore {
  private readonly snapshots = new Map<string, KernelProcessSnapshot>();

  async save(snapshot: KernelProcessSnapshot): Promise<void> {
    this.snapshots.set(String(snapshot.pid), snapshot);
  }

  async load(pid: import('../core/types.js').ProcessId): Promise<KernelProcessSnapshot | null> {
    return this.snapshots.get(String(pid)) ?? null;
  }

  async list(): Promise<KernelProcessSnapshot[]> {
    return Array.from(this.snapshots.values());
  }

  async delete(pid: import('../core/types.js').ProcessId): Promise<void> {
    this.snapshots.delete(String(pid));
  }
}

export interface ExecuteAgentTurnViaKernelOptions {
  runners: AgentRunnerResolver;
  input: AgentTurnProcessInput;
  dataDir?: string;
  timeoutMs?: number;
  /** Called for every StreamChunk emitted by the agent during this turn. */
  onChunk?: (chunk: StreamChunk) => void;
}

export interface AgentTurnKernelControlOptions {
  runners: AgentRunnerResolver;
  dataDir?: string;
}

export interface AgentTurnKernelRunRecord {
  runId: string;
  agentId: string;
  threadKey: string;
  processStatus: ProcessStatus;
  phase: AgentTurnProcessState['phase'];
  createdAt: number;
  updatedAt: number;
  result?: TurnResult;
  sessionKey?: string;
  error?: AgentTurnProcessState['error'];
}

function resolveRunner(runners: AgentRunnerResolver, agentId: string): AgentRunner | undefined {
  return runners instanceof Map ? runners.get(agentId) : runners(agentId);
}

function createCheckpointStore(dataDir?: string): CheckpointStore {
  return dataDir
    ? new ScopedCheckpointStore(new JsonFileCheckpointStore(dataDir), 'agent.turn')
    : new InMemoryCheckpointStore();
}

class AgentKernelTurnExecutor {
  private readonly kernel: AgentKernel;
  private readonly runtime: AgentTurnProcessRuntime;
  private initPromise: Promise<void> | null = null;
  private pumpPromise: Promise<void> | null = null;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduledPumpAt: number | null = null;
  private readonly completions = new Map<
    string,
    { ok: true; result: TurnResult } | { ok: false; message: string }
  >();
  private readonly completionWaiters = new Map<
    string,
    Array<{ resolve: (result: TurnResult) => void; reject: (error: Error) => void }>
  >();
  private readonly finalizing = new Set<string>();
  private readonly suspendedRuns = new Set<string>();
  private readonly runRecords = new Map<string, AgentTurnKernelRunRecord>();
  private resolveRunnerFn: (agentId: string) => AgentRunner | undefined;
  private readonly chunkSubscribers = new Map<string, Set<(chunk: StreamChunk) => void>>();
  private readonly activitySubscribers = new Map<string, Set<() => void>>();

  constructor(runners: AgentRunnerResolver, checkpointStore: CheckpointStore) {
    this.resolveRunnerFn = (agentId) => resolveRunner(runners, agentId);
    this.kernel = new AgentKernel({ checkpointStore });
    this.runtime = new AgentTurnProcessRuntime((agentId) => this.resolveRunnerFn(agentId), {
      onChunk: (runId, chunk) => {
        const subs = this.chunkSubscribers.get(runId);
        if (subs) {
          for (const sub of subs) sub(chunk);
        }
      },
    });
    this.kernel.registerProcessRuntime(this.runtime);
  }

  setRunnerResolver(runners: AgentRunnerResolver): void {
    this.resolveRunnerFn = (agentId) => resolveRunner(runners, agentId);
  }

  subscribeToTurnChunks(runId: string, onChunk: (chunk: StreamChunk) => void): () => void {
    const subs = this.chunkSubscribers.get(runId) ?? new Set();
    subs.add(onChunk);
    this.chunkSubscribers.set(runId, subs);
    return () => {
      const current = this.chunkSubscribers.get(runId);
      if (!current) return;
      current.delete(onChunk);
      if (current.size === 0) this.chunkSubscribers.delete(runId);
    };
  }

  /**
   * Subscribe to step-level activity for a turn. The callback fires each time the
   * kernel completes a step (tick or syscall resolution) while the turn is alive.
   * Used to implement a sliding timeout that resets on each agent step.
   */
  subscribeToTurnActivity(runId: string, onActivity: () => void): () => void {
    const subs = this.activitySubscribers.get(runId) ?? new Set();
    subs.add(onActivity);
    this.activitySubscribers.set(runId, subs);
    return () => {
      const current = this.activitySubscribers.get(runId);
      if (!current) return;
      current.delete(onActivity);
      if (current.size === 0) this.activitySubscribers.delete(runId);
    };
  }

  async initialize(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = (async () => {
      await this.kernel.restoreFromCheckpoints();
      await this.reconcileSnapshots();
      this.scheduleNextPump();
    })();
    return this.initPromise;
  }

  async startTurn(input: AgentTurnProcessInput): Promise<{ runId: string }> {
    await this.initialize();
    const runId = input.runId ?? ulid();
    await this.kernel.createProcess<AgentTurnProcessInput>({
      processType: this.runtime.type,
      processId: asProcessId(runId),
      metadata: {
        agentId: input.agentId,
      },
      input: {
        ...input,
        runId,
      },
    });
    this.schedulePump(0);
    return { runId };
  }

  async executeTurn(input: AgentTurnProcessInput): Promise<TurnResult> {
    const started = await this.startTurn(input);
    return await this.waitForCompletion(started.runId);
  }

  async waitForRun(runId: string): Promise<TurnResult> {
    return await this.waitForCompletion(runId);
  }

  getRun(runId: string): AgentTurnKernelRunRecord | null {
    const snapshot = this.kernel.getSnapshot(asProcessId(runId));
    if (snapshot) {
      return this.snapshotToRunRecord(snapshot);
    }
    return this.runRecords.get(runId) ?? null;
  }

  async resumeTurn(runId: string): Promise<AgentTurnKernelRunRecord | null> {
    await this.initialize();
    if (this.pumpPromise) {
      await this.pumpPromise;
    }
    const pid = asProcessId(runId);
    const snapshot = this.kernel.getSnapshot(pid);
    if (!snapshot) {
      return this.runRecords.get(runId) ?? null;
    }
    const current = this.snapshotToRunRecord(snapshot);
    if (snapshot.status !== 'suspended') {
      return current;
    }
    this.runRecords.delete(runId);
    const resumed = await this.kernel.resumeProcess(pid);
    this.schedulePump(0);
    return this.snapshotToRunRecord(resumed);
  }

  async abortTurn(runId: string, message: string): Promise<void> {
    await this.initialize();
    const snapshot = this.kernel.getSnapshot(asProcessId(runId));
    if (snapshot) {
      try {
        const state = this.runtime.deserialize(snapshot.state) as AgentTurnProcessState;
        const runner = this.resolveRunnerFn(state.agentId);
        if (runner) {
          runner.syncRuntimeState(state.threadKey, runId, state.runnerState.toolResultCache);
          runner.forceReset(runId);
        }
        this.runRecords.set(runId, {
          runId,
          agentId: state.agentId,
          threadKey: state.threadKey,
          processStatus: 'error',
          phase: 'error',
          createdAt: snapshot.createdAt,
          updatedAt: Date.now(),
          error: {
            code: 'AGENT_TURN_ABORTED',
            message,
            retryable: false,
          },
        });
      } catch {
        // Best effort: timeout cleanup should not fail if lease recovery is unavailable.
      }
      await this.kernel.deleteProcess(snapshot.pid);
    }
    this.suspendedRuns.delete(runId);
    this.completeRun(runId, { ok: false, message });
  }

  private schedulePump(delayMs: number): void {
    if (this.pumpPromise) {
      return;
    }
    const targetAt = Date.now() + Math.max(0, delayMs);
    if (this.pumpTimer && this.scheduledPumpAt !== null && this.scheduledPumpAt <= targetAt) {
      return;
    }
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
    }
    this.scheduledPumpAt = targetAt;
    this.pumpTimer = setTimeout(
      () => {
        this.pumpTimer = null;
        this.scheduledPumpAt = null;
        void this.ensurePump();
      },
      Math.max(0, targetAt - Date.now()),
    );
  }

  private scheduleNextPump(): void {
    if (this.pumpPromise) {
      return;
    }
    const waitingSnapshots = this.kernel
      .listSnapshots()
      .filter(
        (snapshot) => snapshot.processType === this.runtime.type && snapshot.status === 'waiting',
      );
    if (waitingSnapshots.length > 0) {
      this.schedulePump(0);
      return;
    }
    const snapshots = this.kernel
      .listSnapshots()
      .filter(
        (snapshot) => snapshot.processType === this.runtime.type && snapshot.status === 'ready',
      );
    if (snapshots.length === 0) {
      return;
    }
    const now = Date.now();
    const nextRunAt = Math.min(...snapshots.map((snapshot) => snapshot.nextRunAt ?? now));
    this.schedulePump(Math.max(0, nextRunAt - now));
  }

  private async ensurePump(): Promise<void> {
    if (this.pumpPromise) {
      return this.pumpPromise;
    }
    this.pumpPromise = this.runPump().finally(() => {
      this.pumpPromise = null;
      this.scheduleNextPump();
    });
    return this.pumpPromise;
  }

  private async runPump(): Promise<void> {
    await this.reconcileSnapshots();
    // Notify activity for any process that is actively waiting for a syscall.
    // This resets the idle-timeout clock at the START of syscall execution so
    // long-running tool calls or slow-starting LLM responses don't mistakenly
    // trigger the watchdog before the syscall has had a chance to produce output.
    for (const snapshot of this.kernel.listSnapshots()) {
      if (snapshot.processType === this.runtime.type && snapshot.status === 'waiting') {
        this.notifyStepActivity(String(snapshot.pid));
      }
    }
    const resolvedSyscalls = await drainWaitingAgentSyscalls(this.kernel, this.runtime);
    if (!resolvedSyscalls) {
      const tickResult = await this.kernel.tick();
      if (tickResult.kind === 'executed' && tickResult.pid !== undefined) {
        this.notifyStepActivity(String(tickResult.pid));
      }
    } else {
      // One or more syscalls resolved — notify all still-alive run IDs
      this.notifyStepActivityAll();
    }
    await this.reconcileSnapshots();
  }

  /** Fire step-activity for a specific run ID. */
  private notifyStepActivity(runId: string): void {
    const subs = this.activitySubscribers.get(runId);
    if (subs) {
      for (const sub of subs) sub();
    }
  }

  /** Fire step-activity for all run IDs that are still alive (ready/waiting). */
  private notifyStepActivityAll(): void {
    for (const snapshot of this.kernel.listSnapshots()) {
      if (snapshot.processType !== this.runtime.type) continue;
      if (snapshot.status === 'ready' || snapshot.status === 'waiting') {
        this.notifyStepActivity(String(snapshot.pid));
      }
    }
  }

  private async reconcileSnapshots(): Promise<void> {
    const snapshots = this.kernel
      .listSnapshots()
      .filter((snapshot) => snapshot.processType === this.runtime.type);
    for (const snapshot of snapshots) {
      const runId = String(snapshot.pid);
      const previousRecord = this.runRecords.get(runId) ?? null;
      if (snapshot.status !== 'suspended') {
        this.suspendedRuns.delete(runId);
      }
      if (snapshot.status === 'suspended') {
        this.runRecords.set(runId, this.snapshotToRunRecord(snapshot));
      } else if (snapshot.status !== 'done' && snapshot.status !== 'error') {
        this.runRecords.delete(runId);
      }
      if (snapshot.status === 'done' || snapshot.status === 'error') {
        await this.finalizeSnapshot(snapshot);
      } else if (snapshot.status === 'suspended') {
        this.completeSuspendedSnapshot(snapshot, previousRecord);
      }
    }
  }

  private completeSuspendedSnapshot(
    snapshot: KernelProcessSnapshot,
    previousRecord: AgentTurnKernelRunRecord | null,
  ): void {
    const runId = String(snapshot.pid);
    if (
      this.suspendedRuns.has(runId) &&
      previousRecord?.processStatus === 'suspended' &&
      previousRecord.updatedAt === snapshot.updatedAt
    ) {
      return;
    }
    this.suspendedRuns.add(runId);
    const state = this.snapshotToState(snapshot);
    this.completeRun(runId, {
      ok: false,
      message: state.error?.message ?? 'Agent turn suspended',
    });
  }

  private async finalizeSnapshot(snapshot: KernelProcessSnapshot): Promise<void> {
    const runId = String(snapshot.pid);
    if (this.finalizing.has(runId)) {
      return;
    }
    this.finalizing.add(runId);
    try {
      const state = this.snapshotToState(snapshot);
      this.runRecords.set(runId, this.snapshotToRunRecord(snapshot));
      if (state.phase === 'done' && state.result) {
        this.completeRun(runId, { ok: true, result: state.result });
      } else {
        this.completeRun(runId, {
          ok: false,
          message: state.error?.message ?? 'Agent turn failed',
        });
      }
      await this.kernel.deleteProcess(snapshot.pid);
    } finally {
      this.finalizing.delete(runId);
    }
  }

  private completeRun(
    runId: string,
    outcome: { ok: true; result: TurnResult } | { ok: false; message: string },
  ): void {
    this.completions.set(runId, outcome);
    const waiters = this.completionWaiters.get(runId) ?? [];
    this.completionWaiters.delete(runId);
    for (const waiter of waiters) {
      if (outcome.ok) {
        waiter.resolve(outcome.result);
      } else {
        waiter.reject(new Error(outcome.message));
      }
    }
  }

  private async waitForCompletion(runId: string): Promise<TurnResult> {
    const archivedOutcome = this.getArchivedCompletionOutcome(runId);
    if (archivedOutcome) {
      if (archivedOutcome.ok) {
        return archivedOutcome.result;
      }
      throw new Error(archivedOutcome.message);
    }
    const outcome = this.completions.get(runId);
    if (outcome) {
      this.completions.delete(runId);
      if (outcome.ok) {
        return outcome.result;
      }
      throw new Error(outcome.message);
    }
    return await new Promise<TurnResult>((resolve, reject) => {
      const waiters = this.completionWaiters.get(runId) ?? [];
      waiters.push({
        resolve: (result) => {
          this.completions.delete(runId);
          resolve(result);
        },
        reject: (error) => {
          this.completions.delete(runId);
          reject(error);
        },
      });
      this.completionWaiters.set(runId, waiters);
    });
  }

  private getArchivedCompletionOutcome(
    runId: string,
  ): { ok: true; result: TurnResult } | { ok: false; message: string } | null {
    const record = this.runRecords.get(runId);
    if (!record) {
      return null;
    }
    if (record.phase === 'done' && record.result) {
      return { ok: true, result: record.result };
    }
    if (
      record.processStatus === 'error' ||
      record.processStatus === 'suspended' ||
      record.phase === 'error' ||
      record.phase === 'suspended'
    ) {
      return {
        ok: false,
        message: record.error?.message ?? 'Agent turn failed',
      };
    }
    return null;
  }

  private snapshotToState(snapshot: KernelProcessSnapshot): AgentTurnProcessState {
    return this.runtime.deserialize(snapshot.state) as AgentTurnProcessState;
  }

  private snapshotToRunRecord(snapshot: KernelProcessSnapshot): AgentTurnKernelRunRecord {
    const state = this.snapshotToState(snapshot);
    return {
      runId: String(snapshot.pid),
      agentId: state.agentId,
      threadKey: state.threadKey,
      processStatus: snapshot.status,
      phase: state.phase,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      result: state.result,
      sessionKey: state.result?.sessionKey,
      error: state.error,
    };
  }
}

const sharedExecutors = new Map<string, Promise<AgentKernelTurnExecutor>>();

function buildExecutorKey(options: AgentTurnKernelControlOptions): string | null {
  if (!options.dataDir) {
    return null;
  }
  if (options.runners instanceof Map && options.runners.size === 1) {
    const onlyAgentId = options.runners.keys().next().value;
    if (typeof onlyAgentId === 'string' && onlyAgentId.length > 0) {
      return `${options.dataDir}::${onlyAgentId}`;
    }
  }
  return options.dataDir;
}

async function getExecutor(
  options: AgentTurnKernelControlOptions,
): Promise<AgentKernelTurnExecutor> {
  const key = buildExecutorKey(options);
  if (!key) {
    const executor = new AgentKernelTurnExecutor(options.runners, createCheckpointStore());
    await executor.initialize();
    return executor;
  }

  const existing = sharedExecutors.get(key);
  if (existing) {
    const executor = await existing;
    executor.setRunnerResolver(options.runners);
    return executor;
  }

  const created = (async () => {
    const executor = new AgentKernelTurnExecutor(
      options.runners,
      createCheckpointStore(options.dataDir),
    );
    await executor.initialize();
    return executor;
  })();
  sharedExecutors.set(key, created);
  const executor = await created;
  executor.setRunnerResolver(options.runners);
  return executor;
}

export async function startAgentTurnViaKernel(
  options: AgentTurnKernelControlOptions & { input: AgentTurnProcessInput },
): Promise<{ runId: string }> {
  const executor = await getExecutor(options);
  return await executor.startTurn(options.input);
}

export async function waitForAgentTurnViaKernel(
  options: AgentTurnKernelControlOptions & { runId: string },
): Promise<TurnResult> {
  const executor = await getExecutor(options);
  return await executor.waitForRun(options.runId);
}

export async function getAgentTurnRunViaKernel(
  options: AgentTurnKernelControlOptions & { runId: string },
): Promise<AgentTurnKernelRunRecord | null> {
  const executor = await getExecutor(options);
  return executor.getRun(options.runId);
}

export async function resumeAgentTurnViaKernel(
  options: AgentTurnKernelControlOptions & { runId: string },
): Promise<AgentTurnKernelRunRecord | null> {
  const executor = await getExecutor(options);
  return await executor.resumeTurn(options.runId);
}

export async function abortAgentTurnViaKernel(
  options: AgentTurnKernelControlOptions & { runId: string; message: string },
): Promise<void> {
  const executor = await getExecutor(options);
  await executor.abortTurn(options.runId, options.message);
}

export async function executeAgentTurnViaKernel(
  options: ExecuteAgentTurnViaKernelOptions,
): Promise<TurnResult> {
  const executor = await getExecutor(options);
  const runId = options.input.runId ?? ulid();

  let unsubscribeFn: (() => void) | undefined;
  if (options.onChunk) {
    unsubscribeFn = executor.subscribeToTurnChunks(runId, options.onChunk);
  }

  const turnPromise = executor.executeTurn({
    ...options.input,
    runId,
  });

  if (!options.timeoutMs || options.timeoutMs <= 0) {
    return await turnPromise.finally(() => unsubscribeFn?.());
  }
  const timeoutMs = options.timeoutMs;

  // Sliding deadline: reset on every streaming chunk or completed kernel step so that
  // active LLM streaming or tool execution doesn't count as inactivity.
  return await new Promise<TurnResult>((resolve, reject) => {
    let lastActivityAt = Date.now();
    const resetActivity = (): void => {
      lastActivityAt = Date.now();
    };

    // Reset deadline on every streaming token
    const chunkActivityUnsub = executor.subscribeToTurnChunks(runId, resetActivity);
    // Reset deadline on every completed kernel step (tool calls, LLM round-trips, etc.)
    const stepActivityUnsub = executor.subscribeToTurnActivity(runId, resetActivity);

    const cleanup = (): void => {
      clearInterval(watchdogTimer);
      chunkActivityUnsub();
      stepActivityUnsub();
      unsubscribeFn?.();
    };

    // Check roughly once per second (or once per timeoutMs if it's very short)
    const watchdogIntervalMs = Math.min(timeoutMs, 1_000);
    const watchdogTimer = setInterval(() => {
      const idleMs = Date.now() - lastActivityAt;
      if (idleMs >= timeoutMs) {
        cleanup();
        const message = `Agent '${options.input.agentId}' turn timed out after ${options.timeoutMs}ms`;
        void executor.abortTurn(runId, message).finally(() => reject(new Error(message)));
      }
    }, watchdogIntervalMs);

    turnPromise.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
