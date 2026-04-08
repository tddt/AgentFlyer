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
import type { WorkflowDef, WorkflowRunRecord, WorkflowStepResult } from './workflow-backend.js';
import {
  type WorkflowProcessInput,
  WorkflowProcessRuntime,
  type WorkflowProcessState,
} from './workflow-process-runtime.js';

const logger = createLogger('gateway:workflow-kernel');

export interface WorkflowKernelCallbacks {
  onRunComplete(workflow: WorkflowDef, run: WorkflowRunRecord): Promise<void>;
  findArchivedRun?(runId: string): Promise<WorkflowRunRecord | null> | WorkflowRunRecord | null;
}

export interface WorkflowKernelServiceOptions {
  dataDir: string;
  runners: Map<string, AgentRunner>;
  callbacks: WorkflowKernelCallbacks;
}

function cloneStepResults(stepResults: WorkflowStepResult[]): WorkflowStepResult[] {
  return stepResults.map((step) => ({
    ...step,
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
  private readonly cancelRequested = new Set<string>();
  private readonly forcedRunStates = new Map<string, WorkflowRunRecord>();
  private readonly finalizing = new Set<string>();
  private readonly completionWaiters = new Map<string, Array<(run: WorkflowRunRecord) => void>>();
  private initPromise: Promise<void> | null = null;
  private pumpPromise: Promise<void> | null = null;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduledPumpAt: number | null = null;

  constructor(options: WorkflowKernelServiceOptions) {
    this.callbacks = options.callbacks;
    this.kernel = new AgentKernel({
      checkpointStore: new ScopedCheckpointStore(
        new JsonFileCheckpointStore(options.dataDir),
        'workflow.run',
      ),
    });
    this.runtime = new WorkflowProcessRuntime({
      async runAgentStep(request) {
        const runner = options.runners.get(request.agentId);
        if (!runner) {
          throw new Error(`Agent not found: ${request.agentId}`);
        }
        const result = await executeAgentTurnViaKernel({
          runners: new Map([[request.agentId, runner]]),
          dataDir: options.dataDir,
          input: {
            agentId: request.agentId,
            userMessage: request.message,
            threadKey: request.threadKey,
          },
        });
        return result.text || '';
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
