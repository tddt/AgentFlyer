import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { drainWaitingAgentSyscalls } from '../agent/kernel-syscall-broker.js';
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
  ScopedCheckpointStore,
} from '../core/kernel/index.js';
import type { ProcessStatus } from '../core/kernel/types.js';
import { createLogger } from '../core/logger.js';
import type { StreamChunk } from '../core/types.js';
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

  save(records: Iterable<AgentKernelRunRecord>): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(Array.from(records), null, 2), 'utf-8');
    } catch (error) {
      logger.error('Failed to save agent-run-records.json', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export interface AgentKernelTurnInput {
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

type CompletionOutcome = { ok: true; result: TurnResult } | { ok: false; message: string };

export interface AgentKernelServiceOptions {
  dataDir: string;
  runners: Map<string, AgentRunner>;
}

export class AgentKernelService {
  private readonly kernel: AgentKernel;
  private readonly runtime: AgentTurnProcessRuntime;
  private readonly runRecordStore: AgentKernelRunRecordStore;
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
  private readonly runRecords = new Map<string, AgentKernelRunRecord>();

  constructor(options: AgentKernelServiceOptions) {
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
      this.runRecordStore.save(this.runRecords.values());
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
    const runId = ulid();
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
    this.schedulePump(0);
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
    return this.runRecords.get(runId) ?? null;
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
    const resolvedSyscalls = await drainWaitingAgentSyscalls(this.kernel, this.runtime);
    if (!resolvedSyscalls) {
      await this.kernel.tick();
    }
    await this.reconcileSnapshots();
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
      });
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
      this.runRecordStore.save(this.runRecords.values());
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
