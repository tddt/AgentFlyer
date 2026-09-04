import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from 'ulid';
import {
  type AgentTurnProcessInput,
  AgentTurnProcessRuntime,
  type AgentTurnProcessState,
} from '../agent/process-runtime.js';
import type {
  AgentRunRecord,
  AgentCancelRunResult as SharedAgentCancelRunResult,
} from '../agent/run-control-contract.js';
import type { RunnerOptions, TurnResult } from '../agent/runner.js';
import type { AgentRunner } from '../agent/runner.js';
import type { TaskRunState } from '../agent/task/task-run-state.js';
import {
  deriveAgentTurnControlState,
  deriveAgentTurnRunRecord,
  getAgentTurnCompletionOutcome,
  isSuspendedAgentTurnRun,
  isTerminalAgentTurnRun,
  shouldRetainAgentTurnRunRecord,
} from '../agent/turn-run-state.js';
import {
  AgentKernel,
  CoalescingCheckpointStore,
  JsonFileCheckpointStore,
  type KernelProcessSnapshot,
  ScopedCheckpointStore,
} from '../core/kernel/index.js';
import type { ProcessStatus } from '../core/kernel/types.js';
import { createLogger } from '../core/logger.js';
import type { ProcessId, StreamChunk } from '../core/types.js';
import { asProcessId } from '../core/types.js';
import { type ResourceLane, RuntimeResourceGovernor } from './runtime-resource-governor.js';

const logger = createLogger('gateway:agent-kernel');
const MAX_RUN_RECORDS = 200;
const STREAM_TEXT_FLUSH_MS = 32;

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
  priority?: KernelProcessSnapshot['priority'];
  userMessage: string;
  threadKey?: string;
  options?: RunnerOptions;
  taskState?: TaskRunState;
}

export type AgentKernelRunRecord = AgentRunRecord;

export interface AgentActiveRunSummary {
  runId: string;
  threadKey: string;
  processStatus: ProcessStatus;
  phase: AgentTurnProcessState['phase'];
  controlState?: import('../agent/turn-run-state.js').AgentTurnControlState;
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
  controlState?: import('../agent/turn-run-state.js').AgentTurnControlState;
  createdAt: number;
  updatedAt: number;
}

export type AgentCancelRunResult = Omit<SharedAgentCancelRunResult, 'run'> & {
  run?: AgentKernelRunRecord | null;
};

type CompletionOutcome = { ok: true; result: TurnResult } | { ok: false; message: string };

export interface AgentKernelServiceOptions {
  dataDir: string;
  runners: Map<string, AgentRunner>;
  resourceGovernor?: RuntimeResourceGovernor;
}

export class AgentKernelService {
  private readonly kernel: AgentKernel;
  private readonly runtime: AgentTurnProcessRuntime;
  private readonly runRecordStore: AgentKernelRunRecordStore;
  private readonly runners: Map<string, AgentRunner>;
  private readonly resourceGovernor: RuntimeResourceGovernor;
  private initPromise: Promise<void> | null = null;
  private pumpPromise: Promise<void> | null = null;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduledPumpAt: number | null = null;
  private disposed = false;
  private readonly subscribers = new Map<string, Set<(chunk: StreamChunk) => void>>();
  private readonly pendingText = new Map<string, string>();
  private readonly textFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly completionWaiters = new Map<
    string,
    Array<{ resolve: (result: TurnResult) => void; reject: (error: Error) => void }>
  >();
  private readonly finalizing = new Set<string>();
  private readonly activitySubscribers = new Set<(agentId: string) => void>();
  // RATIONALE: Tracks PIDs of processes whose syscall (LLM/tool call) is
  // currently executing as a background task, so firePendingSyscalls() does not
  // re-fire the same syscall a second time if the pump runs again while the
  // first background task is still awaiting a response.
  private readonly activeSyscalls = new Set<ProcessId>();
  private readonly syscallAbortControllers = new Map<ProcessId, AbortController>();
  // RATIONALE: Tracks the active promises of background syscall workers so that
  // dispose() can await them all before clearing the tempDir, preventing ENOENT
  // errors when checkpoint files are written after cleanup.
  private readonly activeSyscallPromises = new Set<Promise<void>>();
  private readonly queuedRuns = new Map<string, AgentKernelRunRecord>();
  private readonly runRecords = new Map<string, AgentKernelRunRecord>();

  constructor(options: AgentKernelServiceOptions) {
    this.runners = options.runners;
    this.resourceGovernor = options.resourceGovernor ?? new RuntimeResourceGovernor();
    this.runRecordStore = new AgentKernelRunRecordStore(options.dataDir);
    const loadedRecords = this.runRecordStore.load();
    let prunedLegacyLiveRecord = false;
    for (const record of loadedRecords) {
      if (!isTerminalAgentTurnRun(record)) {
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
        new CoalescingCheckpointStore(new JsonFileCheckpointStore(options.dataDir)),
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
        priority: input.priority,
        input: {
          runId,
          agentId: input.agentId,
          userMessage: input.userMessage,
          threadKey: input.threadKey,
          options: input.options,
          taskState: input.taskState,
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
    this.publishActivity(input.agentId);
    return { runId };
  }

  async reserveQueuedTurn(input: AgentKernelTurnInput): Promise<{ runId: string }> {
    await this.initialize();
    const runId = input.runId ?? ulid();
    const threadKey = input.threadKey?.trim() ? input.threadKey : 'default';
    const now = Date.now();
    this.queuedRuns.set(runId, {
      runId,
      agentId: input.agentId,
      threadKey,
      processStatus: 'waiting',
      phase: 'pending',
      controlState: 'queued',
      createdAt: now,
      updatedAt: now,
    });
    this.publishActivity(input.agentId);
    return { runId };
  }

  async executeTurn(input: AgentKernelTurnInput): Promise<TurnResult> {
    const started = await this.startTurn(input);
    return await this.waitForRun(started.runId);
  }

  /**
   * Wait for a run to complete, with an automatic timeout that force-kills
   * stuck processes. Default timeout is 60 minutes.
   */
  async waitForRun(runId: string, timeoutMs = 60 * 60_000): Promise<TurnResult> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const completionPromise = this.waitForCompletion(runId).finally(() => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    });
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        timeoutId = null;
        this.forceTimeoutRun(runId);
        reject(new Error(`Agent run timed out after ${timeoutMs / 1000}s (runId: ${runId})`));
      }, timeoutMs);
    });
    return await Promise.race([completionPromise, timeoutPromise]);
  }

  /**
   * Cancel a kernel process that is in 'ready' state (created by startTurn but
   * not yet pumped). Marks the run as AGENT_TURN_CANCELLED and deletes the
   * kernel process so the pump never executes it.
   *
   * Returns the cancelled record, or null if the run is not in 'ready' state.
   */
  cancelReadyRun(runId: string): AgentKernelRunRecord | null {
    const pid = asProcessId(runId);
    const snapshot = this.kernel.getSnapshot(pid);
    if (!snapshot || snapshot.status !== 'ready') {
      return null;
    }
    const cancelledRecord: AgentKernelRunRecord = {
      runId,
      agentId: snapshot.metadata.agentId ?? '',
      threadKey: '',
      processStatus: 'error',
      phase: 'error',
      controlState: 'error',
      createdAt: snapshot.createdAt,
      updatedAt: Date.now(),
      error: {
        code: 'AGENT_TURN_CANCELLED',
        message: 'Queued run was cancelled before kernel start.',
        retryable: false,
      },
    };
    this.rememberRunRecord(cancelledRecord);
    void this.kernel
      .deleteProcess(pid)
      .catch(() => {})
      .finally(() => {
        this.publishActivity(cancelledRecord.agentId);
      });
    this.completeRun(runId, { ok: false, message: 'Run cancelled before execution.' });
    this.activeSyscalls.delete(pid);
    this.abortSyscall(pid);
    return cancelledRecord;
  }

  /**
   * Force-complete a stuck run with a timeout error, releasing all waiters
   * and unblocking the per-agent queue.
   */
  forceTimeoutRun(runId: string): void {
    const pid = asProcessId(runId);
    const snapshot = this.kernel.getSnapshot(pid);
    if (snapshot) {
      const runner = this.runners.get(snapshot.metadata.agentId ?? '');
      runner?.forceReset(runId);
      // Mark as error in runRecords so future waiters see it immediately
      const errorRecord: AgentKernelRunRecord = {
        runId,
        agentId: snapshot.metadata.agentId ?? '',
        threadKey: '',
        processStatus: 'error',
        phase: 'error',
        controlState: 'error',
        createdAt: snapshot.createdAt,
        updatedAt: Date.now(),
        error: {
          code: 'AGENT_TURN_TIMEOUT',
          message: 'Agent run timed out and was force-killed.',
          retryable: true,
        },
      };
      this.rememberRunRecord(errorRecord);
      // Delete the kernel process so the pump doesn't keep it alive
      void this.kernel
        .deleteProcess(pid)
        .catch(() => {})
        .finally(() => {
          this.publishActivity(errorRecord.agentId);
        });
    }
    // Resolve all completion waiters with the error
    this.completeRun(runId, {
      ok: false,
      message: 'Agent run timed out and was force-killed.',
    });
    this.activeSyscalls.delete(pid);
    this.abortSyscall(pid);
    logger.warn('Force-killed timed-out agent run', { runId });
  }

  async dispose(): Promise<void> {
    // RATIONALE: Do NOT set disposed=true immediately. Background syscall workers
    // (LLM / tool calls) run through multiple pump rounds; if disposed=true is set
    // first, schedulePump() becomes a no-op and those workers stall mid-flight.
    // Instead, wait for every live kernel process to reach a terminal state
    // (done / error / suspended all call completeRun, which resolves waiters), then
    // mark disposed and cancel any remaining timer.
    //
    // A 5-second per-run timeout is used so that a hung process in tests never
    // blocks afterEach indefinitely.
    const DRAIN_TIMEOUT_MS = 5_000;
    for (const controller of this.syscallAbortControllers.values()) {
      controller.abort();
    }
    const liveRunIds = this.kernel
      .listSnapshots()
      .filter((s) => s.processType === this.runtime.type)
      .map((s) => String(s.pid));
    if (liveRunIds.length > 0) {
      await Promise.allSettled(
        liveRunIds.map((runId) =>
          Promise.race([
            this.waitForCompletion(runId).catch(() => undefined),
            new Promise<void>((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS)),
          ]),
        ),
      );
    }
    const inFlightSyscalls = Array.from(this.activeSyscallPromises);
    if (inFlightSyscalls.length > 0) {
      await Promise.allSettled(
        inFlightSyscalls.map((promise) =>
          Promise.race([
            promise,
            new Promise<void>((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS)),
          ]),
        ),
      );
    }
    this.disposed = true;
    for (const timer of this.textFlushTimers.values()) {
      clearTimeout(timer);
    }
    this.textFlushTimers.clear();
    this.pendingText.clear();
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
      .filter((record) => deriveAgentTurnControlState(record) !== 'suspended')
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
      controlState: current.controlState,
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
        controlState: record.controlState,
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
      controlState: 'error',
      updatedAt: Date.now(),
      error: {
        code: 'AGENT_TURN_CANCELLED',
        message: 'Queued run was cancelled before kernel start.',
        retryable: false,
      },
    };
    this.rememberRunRecord(cancelledRecord);
    this.publishActivity(cancelledRecord.agentId);
    return cancelledRecord;
  }

  async abortTurn(runId: string, message: string): Promise<void> {
    await this.initialize();
    const snapshot = this.kernel.getSnapshot(asProcessId(runId));
    let activityAgentId = snapshot?.metadata.agentId ?? '';
    if (snapshot) {
      try {
        const state = this.snapshotToState(snapshot);
        const agentId = state?.agentId ?? snapshot.metadata.agentId ?? '';
        activityAgentId = agentId;
        const runner = this.runners.get(agentId);
        if (runner && state) {
          runner.syncRuntimeState(
            state.threadKey,
            runId,
            state.runnerState.toolResultCache,
            state.runnerState.promptLayerHashes,
            state.runnerState.cachedSystemPrompt,
            state.runnerState.defaultThreadKey,
            'kernel',
          );
          runner.forceReset(runId);
        }
        this.rememberRunRecord({
          runId,
          agentId,
          threadKey: state?.threadKey ?? '',
          processStatus: 'error',
          phase: 'error',
          controlState: 'error',
          createdAt: snapshot.createdAt,
          updatedAt: Date.now(),
          error: {
            code: 'AGENT_TURN_ABORTED',
            message,
            retryable: false,
          },
        });
      } catch {
        // Best effort: abort should still complete even if state restore fails.
      }
      await this.kernel.deleteProcess(snapshot.pid);
      this.activeSyscalls.delete(snapshot.pid);
      this.abortSyscall(snapshot.pid);
      this.publishActivity(activityAgentId);
    }
    this.completeRun(runId, { ok: false, message });
  }

  async cancelRun(
    runId: string,
    options?: {
      cancelPending?: (agentId: string, runId: string) => void;
      activeMessage?: string;
    },
  ): Promise<AgentCancelRunResult | null> {
    await this.initialize();
    const current = this.getRun(runId);
    if (!current) {
      return null;
    }
    const controlState = deriveAgentTurnControlState(current);
    if (controlState === 'queued') {
      options?.cancelPending?.(current.agentId, runId);
      const cancelled = await this.cancelQueuedTurn(runId);
      return {
        cancelled: Boolean(cancelled),
        runId,
        mode: 'queued',
        run: cancelled ?? current,
      };
    }
    if (controlState === 'ready') {
      const cancelled = this.cancelReadyRun(runId);
      return {
        cancelled: Boolean(cancelled),
        runId,
        mode: 'ready',
        run: cancelled ?? current,
      };
    }
    if (options?.activeMessage) {
      await this.abortTurn(runId, options.activeMessage);
      return {
        cancelled: true,
        runId,
        mode: 'active',
        run: this.getRun(runId) ?? current,
      };
    }
    return {
      cancelled: false,
      runId,
      mode: 'noop',
      run: current,
      reason: 'Only queued runs can be cancelled currently.',
    };
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
    this.publishActivity(record.agentId);
    return record;
  }

  subscribeActivity(listener: (agentId: string) => void): () => void {
    this.activitySubscribers.add(listener);
    return () => {
      this.activitySubscribers.delete(listener);
    };
  }

  subscribeRun(runId: string, listener: (chunk: StreamChunk) => void): () => void {
    const subscriberSet = this.subscribers.get(runId) ?? new Set();
    subscriberSet.add(listener);
    this.subscribers.set(runId, subscriberSet);
    return () => {
      const current = this.subscribers.get(runId);
      current?.delete(listener);
      if (current && current.size === 0) {
        this.subscribers.delete(runId);
      }
    };
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
    const unsubscribe = this.subscribeRun(started.runId, pushChunk);

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
      unsubscribe();
    }
  }

  private publishChunk(runId: string, chunk: StreamChunk): void {
    const listeners = this.subscribers.get(runId);
    if (!listeners) {
      return;
    }
    if (chunk.type === 'text_delta' && chunk.text) {
      this.pendingText.set(runId, `${this.pendingText.get(runId) ?? ''}${chunk.text}`);
      if (!this.textFlushTimers.has(runId)) {
        this.textFlushTimers.set(
          runId,
          setTimeout(() => {
            this.textFlushTimers.delete(runId);
            this.flushPendingText(runId);
          }, STREAM_TEXT_FLUSH_MS),
        );
      }
      return;
    }
    this.flushPendingText(runId);
    this.publishChunkImmediately(listeners, chunk);
  }

  private flushPendingText(runId: string): void {
    const timer = this.textFlushTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.textFlushTimers.delete(runId);
    }
    const text = this.pendingText.get(runId);
    if (!text) {
      return;
    }
    this.pendingText.delete(runId);
    const listeners = this.subscribers.get(runId);
    if (listeners) {
      this.publishChunkImmediately(listeners, { type: 'text_delta', text });
    }
  }

  private publishChunkImmediately(
    listeners: Set<(chunk: StreamChunk) => void>,
    chunk: StreamChunk,
  ): void {
    for (const listener of listeners) {
      listener(chunk);
    }
  }

  private publishActivity(agentId?: string): void {
    if (!agentId) {
      return;
    }
    for (const listener of this.activitySubscribers) {
      listener(agentId);
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
    //  (a) Multiple agents' calls can run concurrently up to the shared
    //      RuntimeResourceGovernor lane limits.
    //  (b) A new agent that starts while an LLM is in flight gets its own tick
    //      pump started immediately, rather than waiting for the slow LLM.
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
      const p = this.runSyscallBackground(snapshot).finally(() => {
        this.activeSyscallPromises.delete(p);
      });
      this.activeSyscallPromises.add(p);
    }
  }

  private async runSyscallBackground(snapshot: KernelProcessSnapshot): Promise<void> {
    const abortController = new AbortController();
    this.syscallAbortControllers.set(snapshot.pid, abortController);
    try {
      const pendingSyscall = snapshot.pendingSyscall;
      if (!pendingSyscall) {
        return;
      }
      // Emit progress chunk so channels / UIs can show which tool is running.
      if (pendingSyscall.kind === 'tool.call') {
        const rawCalls = pendingSyscall.payload.toolCalls;
        if (Array.isArray(rawCalls)) {
          const toolNames = rawCalls
            .map((t: unknown) =>
              t !== null && typeof t === 'object' && 'name' in t
                ? String((t as { name: unknown }).name)
                : '',
            )
            .filter(Boolean);
          if (toolNames.length > 0) {
            this.publishChunk(String(snapshot.pid), {
              type: 'progress',
              message: `🔧 执行工具：${toolNames.join(', ')}`,
            });
          }
        }
      }
      const state = this.runtime.deserialize(snapshot.state);
      const execute = (): Promise<
        Awaited<ReturnType<AgentTurnProcessRuntime['executePendingSyscall']>>
      > => this.runtime.executePendingSyscall(state, pendingSyscall, Date.now());
      const lane = this.resourceLaneFor(pendingSyscall.kind);
      const priority = this.resourcePriorityFor(snapshot.priority);
      const resolution = lane
        ? await this.resourceGovernor.run(
            {
              lane,
              agentId: snapshot.metadata.agentId ?? 'unknown',
              priority,
              signal: abortController.signal,
            },
            execute,
          )
        : await execute();
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
      if (this.syscallAbortControllers.get(snapshot.pid) === abortController) {
        this.syscallAbortControllers.delete(snapshot.pid);
      }
      // Wake up a tick pump to advance the now-resolved process.
      this.schedulePump(0);
    }
  }

  private abortSyscall(pid: ProcessId): void {
    this.syscallAbortControllers.get(pid)?.abort();
  }

  private resourceLaneFor(
    kind: NonNullable<KernelProcessSnapshot['pendingSyscall']>['kind'],
  ): ResourceLane | null {
    if (kind === 'llm.generate') {
      return 'llm';
    }
    if (kind === 'tool.call') {
      return 'tool';
    }
    return null;
  }

  private resourcePriorityFor(priority: KernelProcessSnapshot['priority']):
    | 'interactive'
    | 'recovery'
    | 'workflow'
    | 'scheduler' {
    if (priority === 'critical' || priority === 'high') {
      return 'interactive';
    }
    if (priority === 'low') {
      return 'scheduler';
    }
    return 'workflow';
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
      previousRecord &&
      isSuspendedAgentTurnRun(previousRecord) &&
      previousRecord.updatedAt === snapshot.updatedAt
    ) {
      return;
    }
    const state = this.snapshotToState(snapshot);
    const agentId = state?.agentId ?? snapshot.metadata.agentId ?? '';
    const suspendMsg = state?.error?.message ?? 'Agent turn suspended';
    this.publishChunk(runId, { type: 'text_delta', text: `⚠️ ${suspendMsg}` });
    this.publishChunk(runId, { type: 'error', message: suspendMsg });
    this.completeRun(runId, { ok: false, message: suspendMsg });
    this.publishActivity(agentId);
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
      const agentId = state?.agentId ?? snapshot.metadata.agentId ?? '';
      if (!state) {
        this.completeRun(runId, { ok: false, message: 'Agent turn state is unavailable' });
        await this.kernel.deleteProcess(snapshot.pid);
        this.publishActivity(agentId);
        return;
      }
      this.rememberRunRecord(
        {
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
        },
        false,
      );
      // RATIONALE: await the save before firing completion waiters so that tests
      // reading the persisted file after waitForArchivedRun always find the record.
      await this.runRecordStore.save(this.runRecords.values());
      if (state.phase === 'done' && state.result) {
        this.completeRun(runId, { ok: true, result: state.result });
      } else {
        const failMsg = state.error?.message ?? 'Agent turn failed';
        const displayMsg = failMsg.length > 300 ? `${failMsg.slice(0, 300)}…` : failMsg;
        this.publishChunk(runId, { type: 'text_delta', text: `⚠️ 任务执行失败：${displayMsg}` });
        this.publishChunk(runId, { type: 'error', message: failMsg });
        this.completeRun(runId, { ok: false, message: failMsg });
      }
      await this.kernel.deleteProcess(snapshot.pid);
      this.publishActivity(agentId);
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
    return record ? getAgentTurnCompletionOutcome(record) : null;
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
    return deriveAgentTurnRunRecord(snapshot, this.snapshotToState(snapshot));
  }

  private rememberRunRecord(record: AgentKernelRunRecord, persist = true): AgentKernelRunRecord {
    if (!shouldRetainAgentTurnRunRecord(record)) {
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
    if (persist && isTerminalAgentTurnRun(record)) {
      void this.runRecordStore.save(this.runRecords.values());
    }
    return record;
  }
}

const agentKernelServices = new WeakMap<object, Promise<AgentKernelService>>();

export async function getAgentKernelService(ctx: {
  dataDir: string;
  runners: Map<string, AgentRunner>;
  resourceGovernor?: RuntimeResourceGovernor;
}): Promise<AgentKernelService> {
  const existing = agentKernelServices.get(ctx);
  if (existing) {
    return existing;
  }
  const created = (async () => {
    const service = new AgentKernelService({
      dataDir: ctx.dataDir,
      runners: ctx.runners,
      resourceGovernor: ctx.resourceGovernor,
    });
    await service.initialize();
    return service;
  })();
  agentKernelServices.set(ctx, created);
  return created;
}
