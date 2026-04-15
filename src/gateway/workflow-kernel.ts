import { ulid } from 'ulid';
import { executeAgentTurnViaKernel } from '../agent/kernel-turn-executor.js';
import type { AgentRunner } from '../agent/runner.js';
import {
  AgentKernel,
  JsonFileCheckpointStore,
  ScopedCheckpointStore,
} from '../core/kernel/index.js';
import { createLogger } from '../core/logger.js';
import { asProcessId } from '../core/types.js';
import { AgentQueueRegistry } from './agent-queue.js';
import type { WorkflowDef, WorkflowRunRecord, WorkflowStepResult } from './workflow-backend.js';
import {
  type WorkflowProcessInput,
  WorkflowProcessRuntime,
  type WorkflowProcessState,
} from './workflow-process-runtime.js';

const logger = createLogger('gateway:workflow-kernel');
const DEFAULT_WORKFLOW_AGENT_STEP_TIMEOUT_MS = 300_000;

/** Structured event pushed over the SSE stream for a running workflow step. */
export type RunStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_call'; name: string; id: string };

/** Per-run SSE broadcaster: buffers events for replay + notifies live subscribers. */
class WorkflowRunStreamBroadcaster {
  private buffer: RunStreamEvent[] = [];
  private readonly listeners = new Set<(event: RunStreamEvent) => void>();

  push(event: RunStreamEvent): void {
    this.buffer.push(event);
    for (const listener of this.listeners) listener(event);
  }

  subscribe(onEvent: (event: RunStreamEvent) => void): () => void {
    this.listeners.add(onEvent);
    // Replay existing buffer so late subscribers get partial output
    for (const event of this.buffer) onEvent(event);
    return () => this.listeners.delete(onEvent);
  }

  /** Clear buffer and listeners when a new step starts. */
  clear(): void {
    this.buffer = [];
    this.listeners.clear();
  }
}

export interface WorkflowKernelCallbacks {
  onRunComplete(workflow: WorkflowDef, run: WorkflowRunRecord): Promise<void>;
  findArchivedRun?(runId: string): Promise<WorkflowRunRecord | null> | WorkflowRunRecord | null;
}

export interface WorkflowKernelServiceOptions {
  dataDir: string;
  runners: Map<string, AgentRunner>;
  callbacks: WorkflowKernelCallbacks;
  workflowAgentStepTimeoutMs?: number;
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

function cloneRun(run: WorkflowRunRecord): WorkflowRunRecord {
  return {
    ...run,
    stepResults: cloneStepResults(run.stepResults),
  };
}

export class WorkflowKernelService {
  private readonly kernel: AgentKernel;
  private readonly runtime: WorkflowProcessRuntime;
  private readonly callbacks: WorkflowKernelCallbacks;
  private readonly liveRunners: Map<string, AgentRunner>;
  private readonly workflowAgentQueues = new AgentQueueRegistry();
  private readonly cancelRequested = new Set<string>();
  private readonly forcedRunStates = new Map<string, WorkflowRunRecord>();
  private readonly runnerSnapshots = new Map<string, Map<string, AgentRunner>>();
  private readonly finalizing = new Set<string>();
  private readonly completionWaiters = new Map<string, Array<(run: WorkflowRunRecord) => void>>();
  private readonly streamBroadcasters = new Map<string, WorkflowRunStreamBroadcaster>();
  private initPromise: Promise<void> | null = null;
  private pumpPromise: Promise<void> | null = null;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduledPumpAt: number | null = null;

  constructor(options: WorkflowKernelServiceOptions) {
    this.callbacks = options.callbacks;
    this.liveRunners = options.runners;
    const workflowAgentStepTimeoutMs =
      options.workflowAgentStepTimeoutMs ?? DEFAULT_WORKFLOW_AGENT_STEP_TIMEOUT_MS;
    const service = this;
    this.kernel = new AgentKernel({
      checkpointStore: new ScopedCheckpointStore(
        new JsonFileCheckpointStore(options.dataDir),
        'workflow.run',
      ),
    });
    this.runtime = new WorkflowProcessRuntime({
      async runAgentStep(request) {
        const runners = service.runnerSnapshots.get(request.runId) ?? service.liveRunners;
        const runner = runners.get(request.agentId);
        if (!runner) {
          throw new Error(`Agent not found: ${request.agentId}`);
        }

        // Ensure a fresh broadcaster per step (clear old tokens between steps)
        let broadcaster = service.streamBroadcasters.get(request.runId);
        if (!broadcaster) {
          broadcaster = new WorkflowRunStreamBroadcaster();
          service.streamBroadcasters.set(request.runId, broadcaster);
        } else {
          broadcaster.clear();
        }

        const seenToolIds = new Set<string>();
        const execute = async (): Promise<string> => {
          const result = await executeAgentTurnViaKernel({
            runners: new Map([[request.agentId, runner]]),
            dataDir: options.dataDir,
            timeoutMs: workflowAgentStepTimeoutMs,
            onChunk: (chunk) => {
              if (chunk.type === 'text_delta' && chunk.text) {
                request.onToken?.(chunk.text);
                broadcaster.push({ type: 'token', text: chunk.text });
              } else if (chunk.type === 'tool_use_delta' && !seenToolIds.has(chunk.id)) {
                seenToolIds.add(chunk.id);
                broadcaster.push({ type: 'tool_call', name: chunk.name, id: chunk.id });
              }
            },
            input: {
              agentId: request.agentId,
              userMessage: request.message,
              threadKey: request.threadKey,
            },
          });
          return result.text || '';
        };
        return await service.workflowAgentQueues.for(request.agentId).enqueue(execute);
      },
      onToken(_runId, _stepId, _token) {
        // Tokens are forwarded via broadcaster in runAgentStep above;
        // this handler is here for completeness if other code paths use it.
      },
    });
    this.kernel.registerProcessRuntime(this.runtime);
  }

  async initialize(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = (async () => {
      const restored = await this.kernel.restoreFromCheckpoints();
      if (restored > 0) {
        logger.info('Restored workflow checkpoints', { restored });
      }
      await this.reconcileSnapshots();
      this.scheduleNextPump();
    })();
    return this.initPromise;
  }

  async startWorkflow(workflow: WorkflowDef, input: string): Promise<WorkflowRunRecord> {
    await this.initialize();
    const runId = ulid();
    this.runnerSnapshots.set(runId, new Map(this.liveRunners));
    const snapshot = await this.kernel.createProcess<WorkflowProcessInput>({
      processType: this.runtime.type,
      processId: asProcessId(runId),
      input: {
        runId,
        workflow,
        input,
      },
      metadata: {
        workflowId: workflow.id,
        workflowName: workflow.name,
      },
    });
    const run = this.snapshotToRun(snapshot);
    if (!run) {
      throw new Error(`Failed to initialize workflow run: ${runId}`);
    }
    this.schedulePump(0);
    return run;
  }

  getRun(runId: string): WorkflowRunRecord | null {
    const forced = this.forcedRunStates.get(runId);
    if (forced) {
      return cloneRun(forced);
    }
    const snapshot = this.kernel.getSnapshot(asProcessId(runId));
    return snapshot ? this.snapshotToRun(snapshot) : null;
  }

  listRuns(): WorkflowRunRecord[] {
    const liveRuns = this.kernel
      .listSnapshots()
      .filter((snapshot) => snapshot.processType === this.runtime.type)
      .flatMap((snapshot) => {
        const run = this.snapshotToRun(snapshot);
        return run ? [run] : [];
      });
    const forcedRunIds = new Set(this.forcedRunStates.keys());
    const mergedLiveRuns = liveRuns.filter((run) => !forcedRunIds.has(run.runId));
    return [
      ...Array.from(this.forcedRunStates.values()).map((run) => cloneRun(run)),
      ...mergedLiveRuns,
    ];
  }

  async cancelRun(runId: string): Promise<WorkflowRunRecord | null> {
    await this.initialize();
    const current = this.getRun(runId);
    if (!current) {
      return null;
    }
    if (current.status !== 'running') {
      return current;
    }
    const cancelled = {
      ...cloneRun(current),
      status: 'cancelled' as const,
      finishedAt: Date.now(),
    };
    this.cancelRequested.add(runId);
    this.forcedRunStates.set(runId, cloneRun(cancelled));
    this.schedulePump(0);
    return cancelled;
  }

  async waitForCompletion(runId: string): Promise<WorkflowRunRecord> {
    const current = this.getRun(runId);
    if (current && current.status !== 'running') {
      return current;
    }
    const archived = await this.callbacks.findArchivedRun?.(runId);
    if (archived) {
      return cloneRun(archived);
    }
    return await new Promise<WorkflowRunRecord>((resolve) => {
      const waiters = this.completionWaiters.get(runId) ?? [];
      waiters.push(resolve);
      this.completionWaiters.set(runId, waiters);
    });
  }

  /**
   * Subscribe to real-time streamed text tokens for a running step.
   * Returns an unsubscribe function. Replays any already-buffered tokens immediately.
   */
  subscribeToStreamOutput(runId: string, onToken: (event: RunStreamEvent) => void): () => void {
    let broadcaster = this.streamBroadcasters.get(runId);
    if (!broadcaster) {
      broadcaster = new WorkflowRunStreamBroadcaster();
      this.streamBroadcasters.set(runId, broadcaster);
    }
    return broadcaster.subscribe(onToken);
  }

  /**
   * Fork a prior run, re-executing from a specific step onwards.
   * Prior step results before `fromStepId` are preserved unchanged.
   */
  async retryFromStep(
    workflow: WorkflowDef,
    priorRun: WorkflowRunRecord,
    fromStepId: string,
  ): Promise<WorkflowRunRecord> {
    await this.initialize();
    const newRunId = ulid();
    this.runnerSnapshots.set(newRunId, new Map(this.liveRunners));
    const snapshot = await this.kernel.createProcess<WorkflowProcessInput>({
      processType: this.runtime.type,
      processId: asProcessId(newRunId),
      input: {
        runId: newRunId,
        workflow,
        input: priorRun.input,
        _fork: { priorRun, fromStepId },
      },
      metadata: {
        workflowId: workflow.id,
        workflowName: workflow.name,
      },
    });
    const run = this.snapshotToRun(snapshot);
    if (!run) {
      throw new Error(`Failed to initialize forked workflow run: ${newRunId}`);
    }
    this.schedulePump(0);
    return run;
  }

  /**
   * Skip a failed step in a running (or errored) run.
   * Creates a new forked run that starts from the step AFTER `stepId`,
   * preserving the failed step's error record in history.
   */
  async skipStep(runId: string, stepId: string): Promise<WorkflowRunRecord> {
    await this.initialize();
    const priorRun = this.getRun(runId) ?? (await this.callbacks.findArchivedRun?.(runId));
    if (!priorRun) {
      throw new Error(`Run not found: ${runId}`);
    }
    // Extract the workflow definition from the prior run's process state
    const snapshot = this.kernel.getSnapshot(asProcessId(runId));
    const state = snapshot
      ? (this.runtime.deserialize(snapshot.state) as WorkflowProcessState)
      : null;
    if (!state) {
      throw new Error(`Cannot skip step: run state not available for ${runId}`);
    }
    const workflow = state.workflow;
    const failedStepIndex = workflow.steps.findIndex((s) => s.id === stepId);
    if (failedStepIndex < 0) {
      throw new Error(`Step not found: ${stepId}`);
    }
    const nextStep = workflow.steps[failedStepIndex + 1];
    if (!nextStep) {
      throw new Error(`No step to continue to after ${stepId} (it was the last step)`);
    }
    // Get the failed step's existing result (or create a synthetic one)
    const failedResult: WorkflowStepResult =
      priorRun.stepResults.find((r) => r.stepId === stepId) ?? {
        stepId,
        error: 'Skipped by operator',
        finishedAt: Date.now(),
      };
    const newRunId = ulid();
    this.runnerSnapshots.set(newRunId, new Map(this.liveRunners));
    const newSnapshot = await this.kernel.createProcess<WorkflowProcessInput>({
      processType: this.runtime.type,
      processId: asProcessId(newRunId),
      input: {
        runId: newRunId,
        workflow,
        input: priorRun.input,
        _fork: { priorRun, fromStepId: nextStep.id, appendStepResult: failedResult },
      },
      metadata: {
        workflowId: workflow.id,
        workflowName: workflow.name,
      },
    });
    const run = this.snapshotToRun(newSnapshot);
    if (!run) {
      throw new Error(`Failed to initialize skipped-step workflow run: ${newRunId}`);
    }
    this.schedulePump(0);
    return run;
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
    await this.kernel.tick();
    await this.reconcileSnapshots();
  }

  private async reconcileSnapshots(): Promise<void> {
    const snapshots = this.kernel
      .listSnapshots()
      .filter((snapshot) => snapshot.processType === this.runtime.type);
    for (const snapshot of snapshots) {
      const runId = String(snapshot.pid);
      if (this.cancelRequested.has(runId) && snapshot.status !== 'running') {
        await this.finalizeSnapshot(snapshot, 'cancelled');
        continue;
      }
      if (snapshot.status === 'done' || snapshot.status === 'error') {
        await this.finalizeSnapshot(snapshot);
      }
    }
  }

  private async finalizeSnapshot(
    snapshot: ReturnType<AgentKernel['getSnapshot']> extends infer T ? Exclude<T, null> : never,
    forcedStatus?: WorkflowRunRecord['status'],
  ): Promise<void> {
    const runId = String(snapshot.pid);
    if (this.finalizing.has(runId)) {
      return;
    }
    this.finalizing.add(runId);
    try {
      const state = this.snapshotToState(snapshot);
      if (!state) {
        await this.kernel.deleteProcess(snapshot.pid);
        return;
      }
      const run = cloneRun(state.run);
      if (forcedStatus) {
        run.status = forcedStatus;
        run.finishedAt = run.finishedAt ?? Date.now();
      }
      await this.callbacks.onRunComplete(state.workflow, run);
      await this.kernel.deleteProcess(snapshot.pid);
      this.cancelRequested.delete(runId);
      this.forcedRunStates.delete(runId);
      this.runnerSnapshots.delete(runId);
      this.resolveCompletion(run);
    } finally {
      this.finalizing.delete(runId);
    }
  }

  private resolveCompletion(run: WorkflowRunRecord): void {
    const waiters = this.completionWaiters.get(run.runId);
    if (!waiters) {
      return;
    }
    this.completionWaiters.delete(run.runId);
    for (const resolve of waiters) {
      resolve(cloneRun(run));
    }
  }

  private snapshotToRun(
    snapshot: ReturnType<AgentKernel['getSnapshot']>,
  ): WorkflowRunRecord | null {
    const state = this.snapshotToState(snapshot);
    return state ? cloneRun(state.run) : null;
  }

  private snapshotToState(
    snapshot: ReturnType<AgentKernel['getSnapshot']>,
  ): WorkflowProcessState | null {
    if (!snapshot) {
      return null;
    }
    try {
      return this.runtime.deserialize(snapshot.state);
    } catch (error) {
      logger.error('Failed to deserialize workflow snapshot', {
        pid: snapshot.pid,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
