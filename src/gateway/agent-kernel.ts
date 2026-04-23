import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from 'ulid';
import {
  type AgentTurnProcessInput,
  AgentTurnProcessRuntime,
  type AgentTurnProcessState,
} from '../agent/process-runtime.js';
import type { RunnerOptions, TurnResult } from '../agent/runner.js';
import type { AgentRunner } from '../agent/runner.js';
import {
  AgentKernel,
  JsonFileCheckpointStore,
  type KernelProcessSnapshot,
  ScopedCheckpointStore,
} from '../core/kernel/index.js';
import type { ProcessStatus } from '../core/kernel/types.js';
import { createLogger } from '../core/logger.js';
import type { ProcessId, StreamChunk } from '../core/types.js';
import { asProcessId } from '../core/types.js';

const logger = createLogger('gateway:agent-kernel');
const MAX_RUN_RECORDS = 200;

function isArchivedRunRecord(record: AgentKernelRunRecord): boolean {
  return (
    record.processStatus === 'done' ||
    record.processStatus === 'error' ||
    record.phase === 'done' ||
    record.phase === 'error'
  );
}

function shouldCacheCompletionOutcome(record: AgentKernelRunRecord): boolean {
  return (
    isArchivedRunRecord(record) ||
    record.processStatus === 'suspended' ||
    record.phase === 'suspended'
  );
}

class AgentKernelRunRecordStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, 'agent-run-records.json');
  }

  load(): AgentKernelRunRecord[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as AgentKernelRunRecord[];
      logger.info('Loaded agent run records', { count: parsed.length });
      return parsed;
    } catch (error) {
      logger.warn('Failed to load agent-run-records.json, starting fresh', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async save(records: Iterable<AgentKernelRunRecord>): Promise<void> {
    try {
      await writeFile(this.filePath, JSON.stringify(Array.from(records), null, 2), 'utf-8');
    } catch (error) {
      logger.error('Failed to save agent-run-records.json', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export interface AgentKernelTurnInput {
  runId?: string;
  agentId: string;
  userMessage: string;
  threadKey?: string;
  options?: RunnerOptions;
}

export interface AgentKernelRunRecord {
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

export interface AgentActiveRunSummary {
  runId: string;
  threadKey: string;
  processStatus: ProcessStatus;
  phase: AgentTurnProcessState['phase'];
  createdAt: number;
  updatedAt: number;
  sessionKey?: string;
  error?: AgentTurnProcessState['error'];
}

export interface AgentQueuedRunSummary {
  runId: string;
  threadKey: string;
  processStatus: ProcessStatus;
  phase: AgentTurnProcessState['phase'];
  createdAt: number;
  updatedAt: number;
}

type CompletionOutcome = { ok: true; result: TurnResult } | { ok: false; message: string };

export interface AgentKernelServiceOptions {
  dataDir: string;
  runners: Map<string, AgentRunner>;
}

export class AgentKernelService {
  private readonly kernel: AgentKernel;
  private readonly runtime: AgentTurnProcessRuntime;
  private readonly runRecordStore: AgentKernelRunRecordStore;
  private readonly runners: Map<string, AgentRunner>;
  private initPromise: Promise<void> | null = null;
  private pumpPromise: Promise<void> | null = null;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduledPumpAt: number | null = null;
  private disposed = false;
  private readonly subscribers = new Map<string, Set<(chunk: StreamChunk) => void>>();
  private readonly completionWaiters = new Map<
    string,
    Array<{ resolve: (result: TurnResult) => void; reject: (error: Error) => void }>
  >();
  private readonly finalizing = new Set<string>();
  // RATIONALE: Tracks PIDs of processes whose syscall (LLM/tool call) is
  // currently executing as a background task, so firePendingSyscalls() does not
  // re-fire the same syscall a second time if the pump runs again while the
  // first background task is still awaiting a response.
  private readonly activeSyscalls = new Set<ProcessId>();
  private readonly queuedRuns = new Map<string, AgentKernelRunRecord>();
  private readonly runRecords = new Map<string, AgentKernelRunRecord>();

  constructor(options: AgentKernelServiceOptions) {
    this.runners = options.runners;
    this.runRecordStore = new AgentKernelRunRecordStore(options.dataDir);
    const loadedRecords = this.runRecordStore.load();
    let prunedLegacyLiveRecord = false;
    for (const record of loadedRecords) {
      if (!isArchivedRunRecord(record)) {
        prunedLegacyLiveRecord = true;
        continue;
      }
      this.rememberRunRecord(record, false);
    }
    if (prunedLegacyLiveRecord) {
      void this.runRecordStore.save(this.runRecords.values());
    }
    this.kernel = new AgentKernel({
      checkpointStore: new ScopedCheckpointStore(
        new JsonFileCheckpointStore(options.dataDir),
        'agent.turn',
      ),
    });
    this.runtime = new AgentTurnProcessRuntime(options.runners, {
      onChunk: (runId, chunk) => {
        this.publishChunk(runId, chunk);
      },
    });
    this.kernel.registerProcessRuntime(this.runtime);
  }

  async initialize(): Promise<void> {
    if (this.disposed) {
      throw new Error('AgentKernelService is disposed');
    }
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = (async () => {
      const restored = await this.kernel.restoreFromCheckpoints();
      if (restored > 0) {
        logger.info('Restored agent turn checkpoints', { restored });
      }
      await this.reconcileSnapshots();
      this.scheduleNextPump();
    })();
    return this.initPromise;
  }

  async startTurn(input: AgentKernelTurnInput): Promise<{ runId: string }> {
    await this.initialize();
    const runId = input.runId ?? ulid();
    const queuedRecord = this.queuedRuns.get(runId);
    this.queuedRuns.delete(runId);
    try {
      await this.kernel.createProcess<AgentTurnProcessInput>({
        processType: this.runtime.type,
        processId: asProcessId(runId),
        metadata: {
          agentId: input.agentId,
        },
        input: {
          runId,
          agentId: input.agentId,
          userMessage: input.userMessage,
          threadKey: input.threadKey,
          options: input.options,
        },
      });
    } catch (error) {
      if (queuedRecord) {
        this.rememberRunRecord({
          ...queuedRecord,
          processStatus: 'error',
          phase: 'error',
          updatedAt: Date.now(),
          error: {
            code: 'AGENT_TURN_ERROR',
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        });
      }
      throw error;
    }
    this.schedulePump(0);
    return { runId };
  }

  async reserveQueuedTurn(input: AgentKernelTurnInput): Promise<{ runId: string }> {
    await this.initialize();
    const runId = input.runId ?? ulid();
    const runner = this.runners.get(input.agentId);
    const threadKey = input.threadKey?.trim()
      ? input.threadKey
      : runner
        ? (runner.currentSessionKey as unknown as string).split(':').slice(2).join(':') || 'default'
        : 'default';
    const now = Date.now();
    this.queuedRuns.set(runId, {
      runId,
      agentId: input.agentId,
      threadKey,
      processStatus: 'waiting',
      phase: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    return { runId };
  }

  async executeTurn(input: AgentKernelTurnInput): Promise<TurnResult> {
    const started = await this.startTurn(input);
    return await this.waitForCompletion(started.runId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
      this.scheduledPumpAt = null;
    }
    if (this.pumpPromise) {
      await this.pumpPromise;
    }
  }

  getRun(runId: string): AgentKernelRunRecord | null {
    const snapshot = this.kernel.getSnapshot(asProcessId(runId));
    if (snapshot) {
      return this.snapshotToRunRecord(snapshot);
    }
    const queued = this.queuedRuns.get(runId);
    if (queued) {
      return queued;
    }
    return this.runRecords.get(runId) ?? null;
  }

  getLatestLiveRunForAgent(agentId: string): AgentActiveRunSummary | null {
    const matches = this.kernel
      .listSnapshots()
      .filter((snapshot) => snapshot.processType === this.runtime.type)
      .map((snapshot) => this.snapshotToRunRecord(snapshot))
      .filter((record) => record.agentId === agentId)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const current = matches[0];
    if (!current) {
      return null;
    }
    return {
      runId: current.runId,
      threadKey: current.threadKey,
      processStatus: current.processStatus,
      phase: current.phase,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      sessionKey: current.sessionKey,
      error: current.error,
    };
  }

  getQueuedRunsForAgent(agentId: string): AgentQueuedRunSummary[] {
    return Array.from(this.queuedRuns.values())
      .filter((record) => record.agentId === agentId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => ({
        runId: record.runId,
        threadKey: record.threadKey,
        processStatus: record.processStatus,
        phase: record.phase,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }));
  }

  async cancelQueuedTurn(runId: string): Promise<AgentKernelRunRecord | null> {
    await this.initialize();
    const queued = this.queuedRuns.get(runId);
    if (!queued) {
      return null;
    }
    this.queuedRuns.delete(runId);
    const cancelledRecord: AgentKernelRunRecord = {
      ...queued,
      processStatus: 'error',
      phase: 'error',
      updatedAt: Date.now(),
      error: {
        code: 'AGENT_TURN_CANCELLED',
        message: 'Queued run was cancelled before kernel start.',
        retryable: false,
      },
    };
    this.rememberRunRecord(cancelledRecord);
    return cancelledRecord;
  }

  async resumeTurn(runId: string): Promise<AgentKernelRunRecord | null> {
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
    const record = this.snapshotToRunRecord(resumed);
    this.schedulePump(0);
    return record;
  }

  async *streamTurn(input: AgentKernelTurnInput): AsyncGenerator<StreamChunk, TurnResult | null> {
    await this.initialize();
    const queue: StreamChunk[] = [];
    let notify: (() => void) | null = null;
    let ended = false;
    const waitForChunk = async (): Promise<void> => {
      if (queue.length > 0 || ended) {
        return;
      }
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
      notify = null;
    };
    const pushChunk = (chunk: StreamChunk): void => {
      queue.push(chunk);
      notify?.();
    };

    const started = await this.startTurn(input);
    const subscriberSet = this.subscribers.get(started.runId) ?? new Set();
    subscriberSet.add(pushChunk);
    this.subscribers.set(started.runId, subscriberSet);

    try {
      const completionPromise = this.waitForCompletion(started.runId)
        .then((result) => {
          ended = true;
          notify?.();
          return result;
        })
        .catch(() => {
          ended = true;
          notify?.();
          return null;
        });
      return yield* this.consumeQueuedStream(queue, waitForChunk, () => ended, completionPromise);
    } finally {
      const current = this.subscribers.get(started.runId);
      current?.delete(pushChunk);
      if (current && current.size === 0) {
        this.subscribers.delete(started.runId);
      }
    }
  }

  private publishChunk(runId: string, chunk: StreamChunk): void {
    const listeners = this.subscribers.get(runId);
    if (!listeners) {
      return;
    }
    for (const listener of listeners) {
      listener(chunk);
    }
  }

  private async *consumeQueuedStream(
    queue: StreamChunk[],
    waitForChunk: () => Promise<void>,
    isEnded: () => boolean,
    completionPromise: Promise<TurnResult | null>,
  ): AsyncGenerator<StreamChunk, TurnResult | null> {
    await waitForChunk();
    while (queue.length > 0) {
      const chunk = queue.shift();
      if (chunk) {
        yield chunk;
      }
    }
    if (isEnded()) {
      return await completionPromise;
    }
    return yield* this.consumeQueuedStream(queue, waitForChunk, isEnded, completionPromise);
  }

  private schedulePump(delayMs: number): void {
    if (this.disposed) {
      return;
    }
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
    if (this.disposed) {
      return;
    }
    if (this.pumpPromise) {
      return;
    }
    // Only schedule for waiting processes that don't already have an active
    // background syscall worker. Those already tracked in activeSyscalls will
    // call schedulePump(0) themselves once their LLM/tool call completes.
    // Without this guard, scheduleNextPump would spin in a rapid no-op loop
    // while background syscalls are in flight.
    const waitingSnapshotNeedsFiring = this.kernel
      .listSnapshots()
      .some(
        (snapshot) =>
          snapshot.processType === this.runtime.type &&
          snapshot.status === 'waiting' &&
          !this.activeSyscalls.has(snapshot.pid),
      );
    if (waitingSnapshotNeedsFiring) {
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
    if (this.disposed) {
      return;
    }
    if (this.pumpPromise) {
      return this.pumpPromise;
    }
    this.pumpPromise = this.runPump().finally(() => {
      this.pumpPromise = null;
      if (!this.disposed) {
        this.scheduleNextPump();
      }
    });
    return this.pumpPromise;
  }

  private async runPump(): Promise<void> {
    await this.reconcileSnapshots();
    // RATIONALE: Fire pending syscalls (LLM calls, tool calls) as background
    // workers so they run independently of the pump gate. The pump then ticks all
    // currently ready processes and exits immediately, releasing pumpPromise.
    // This means:
    //  (a) Multiple agents' LLM calls run fully in parallel.
    //  (b) A new agent that starts while an LLM is in flight gets its own tick
    //      pump started immediately (pumpPromise is null between tick cycles),
    //      rather than waiting up to 30 seconds for the slow LLM to finish.
    this.firePendingSyscalls();
    await this.tickAllReady();
    await this.reconcileSnapshots();
  }

  /**
   * Fire each waiting process's pending syscall as an independent background
   * task. Skips processes already tracked in activeSyscalls to avoid duplicate
   * executions when the pump cycles while a slow LLM call is still in-flight.
   * Each task schedules a new tick pump when it completes so the resolved
   * process is advanced without delay.
   */
  private firePendingSyscalls(): void {
    const waitingSnapshots = this.kernel
      .listSnapshots()
      .filter(
        (snapshot) =>
          snapshot.processType === this.runtime.type &&
          snapshot.status === 'waiting' &&
          snapshot.pendingSyscall &&
          !this.activeSyscalls.has(snapshot.pid),
      );
    for (const snapshot of waitingSnapshots) {
      this.activeSyscalls.add(snapshot.pid);
      void this.runSyscallBackground(snapshot);
    }
  }

  private async runSyscallBackground(snapshot: KernelProcessSnapshot): Promise<void> {
    try {
      const pendingSyscall = snapshot.pendingSyscall;
      if (!pendingSyscall) {
        return;
      }
      const state = this.runtime.deserialize(snapshot.state);
      const resolution = await this.runtime.executePendingSyscall(
        state,
        pendingSyscall,
        Date.now(),
      );
      if (!this.kernel.getSnapshot(snapshot.pid)) {
        return;
      }
      await this.kernel.resolveSyscall(snapshot.pid, resolution);
    } catch (error) {
      logger.error('Background syscall execution failed', {
        pid: snapshot.pid,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.activeSyscalls.delete(snapshot.pid);
      // Wake up a tick pump to advance the now-resolved process.
      this.schedulePump(0);
    }
  }

  /**
   * Advance all currently ready processes one step each until the scheduler
   * reports idle. The pump gate (pumpPromise) is held only for this fast
   * synchronous phase, not for slow I/O — those are handled by background
   * syscall workers (see firePendingSyscalls / runSyscallBackground).
   */
  private async tickAllReady(): Promise<void> {
    let result = await this.kernel.tick();
    while (result.kind === 'executed') {
      result = await this.kernel.tick();
    }
  }

  private async reconcileSnapshots(): Promise<void> {
    const snapshots = this.kernel
      .listSnapshots()
      .filter((snapshot) => snapshot.processType === this.runtime.type);
    for (const snapshot of snapshots) {
      const runId = String(snapshot.pid);
      const previousRecord = this.runRecords.get(runId) ?? null;
      if (snapshot.status === 'suspended') {
        this.rememberRunRecord(this.snapshotToRunRecord(snapshot), false);
      } else {
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
    snapshot: ReturnType<AgentKernel['getSnapshot']> extends infer T ? Exclude<T, null> : never,
    previousRecord: AgentKernelRunRecord | null,
  ): void {
    const runId = String(snapshot.pid);
    if (
      previousRecord?.processStatus === 'suspended' &&
      previousRecord.updatedAt === snapshot.updatedAt
    ) {
      return;
    }
    const state = this.snapshotToState(snapshot);
    this.publishChunk(runId, {
      type: 'error',
      message: state?.error?.message ?? 'Agent turn suspended',
    });
    this.completeRun(runId, {
      ok: false,
      message: state?.error?.message ?? 'Agent turn suspended',
    });
  }

  private async finalizeSnapshot(
    snapshot: ReturnType<AgentKernel['getSnapshot']> extends infer T ? Exclude<T, null> : never,
  ): Promise<void> {
    const runId = String(snapshot.pid);
    if (this.finalizing.has(runId)) {
      return;
    }
    this.finalizing.add(runId);
    try {
      const state = this.snapshotToState(snapshot);
      if (!state) {
        this.completeRun(runId, { ok: false, message: 'Agent turn state is unavailable' });
        await this.kernel.deleteProcess(snapshot.pid);
        return;
      }
      this.rememberRunRecord({
        runId,
        agentId: state.agentId,
        threadKey: state.threadKey,
        processStatus: snapshot.status,
        phase: state.phase,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
        result: state.result,
        sessionKey: state.result?.sessionKey,
        error: state.error,
      }, false);
      // RATIONALE: await the save before firing completion waiters so that tests
      // reading the persisted file after waitForArchivedRun always find the record.
      await this.runRecordStore.save(this.runRecords.values());
      if (state.phase === 'done' && state.result) {
        this.completeRun(runId, { ok: true, result: state.result });
      } else {
        this.publishChunk(runId, {
          type: 'error',
          message: state.error?.message ?? 'Agent turn failed',
        });
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

  private completeRun(runId: string, outcome: CompletionOutcome): void {
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
    return await new Promise<TurnResult>((resolve, reject) => {
      const waiters = this.completionWaiters.get(runId) ?? [];
      waiters.push({
        resolve,
        reject,
      });
      this.completionWaiters.set(runId, waiters);
    });
  }

  private getArchivedCompletionOutcome(runId: string): CompletionOutcome | null {
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

  private snapshotToState(
    snapshot: ReturnType<AgentKernel['getSnapshot']>,
  ): AgentTurnProcessState | null {
    if (!snapshot) {
      return null;
    }
    try {
      return this.runtime.deserialize(snapshot.state);
    } catch (error) {
      logger.error('Failed to deserialize agent snapshot', {
        pid: snapshot.pid,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private snapshotToRunRecord(
    snapshot: ReturnType<AgentKernel['getSnapshot']> extends infer T ? Exclude<T, null> : never,
  ): AgentKernelRunRecord {
    const state = this.snapshotToState(snapshot);
    return {
      runId: String(snapshot.pid),
      agentId: state?.agentId ?? snapshot.metadata.agentId ?? '',
      threadKey: state?.threadKey ?? '',
      processStatus: snapshot.status,
      phase: state?.phase ?? (snapshot.status === 'suspended' ? 'suspended' : 'error'),
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      result: state?.result,
      sessionKey: state?.result?.sessionKey,
      error: state?.error ?? snapshot.lastError,
    };
  }

  private rememberRunRecord(record: AgentKernelRunRecord, persist = true): AgentKernelRunRecord {
    if (!shouldCacheCompletionOutcome(record)) {
      this.runRecords.delete(record.runId);
      return record;
    }
    this.runRecords.set(record.runId, record);
    while (this.runRecords.size > MAX_RUN_RECORDS) {
      const oldest = this.runRecords.keys().next().value;
      if (!oldest) {
        break;
      }
      this.runRecords.delete(oldest);
    }
    if (persist && isArchivedRunRecord(record)) {
      void this.runRecordStore.save(this.runRecords.values());
    }
    return record;
  }
}

const agentKernelServices = new WeakMap<object, Promise<AgentKernelService>>();

export async function getAgentKernelService(ctx: {
  dataDir: string;
  runners: Map<string, AgentRunner>;
}): Promise<AgentKernelService> {
  const existing = agentKernelServices.get(ctx);
  if (existing) {
    return existing;
  }
  const created = (async () => {
    const service = new AgentKernelService({
      dataDir: ctx.dataDir,
      runners: ctx.runners,
    });
    await service.initialize();
    return service;
  })();
  agentKernelServices.set(ctx, created);
  return created;
}
