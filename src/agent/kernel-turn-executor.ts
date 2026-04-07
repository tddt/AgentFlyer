import { ulid } from 'ulid';
import {
  AgentKernel,
  type CheckpointStore,
  JsonFileCheckpointStore,
  type KernelProcessSnapshot,
  ScopedCheckpointStore,
} from '../core/kernel/index.js';
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
  private resolveRunnerFn: (agentId: string) => AgentRunner | undefined;

  constructor(runners: AgentRunnerResolver, checkpointStore: CheckpointStore) {
    this.resolveRunnerFn = (agentId) => resolveRunner(runners, agentId);
    this.kernel = new AgentKernel({ checkpointStore });
    this.runtime = new AgentTurnProcessRuntime((agentId) => this.resolveRunnerFn(agentId));
    this.kernel.registerProcessRuntime(this.runtime);
  }

  setRunnerResolver(runners: AgentRunnerResolver): void {
    this.resolveRunnerFn = (agentId) => resolveRunner(runners, agentId);
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
      if (snapshot.status !== 'suspended') {
        this.suspendedRuns.delete(String(snapshot.pid));
      }
      if (snapshot.status === 'done' || snapshot.status === 'error') {
        await this.finalizeSnapshot(snapshot);
      } else if (snapshot.status === 'suspended') {
        this.completeSuspendedSnapshot(snapshot);
      }
    }
  }

  private completeSuspendedSnapshot(snapshot: KernelProcessSnapshot): void {
    const runId = String(snapshot.pid);
    if (this.suspendedRuns.has(runId)) {
      return;
    }
    this.suspendedRuns.add(runId);
    const state = this.runtime.deserialize(snapshot.state) as AgentTurnProcessState;
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
      const state = this.runtime.deserialize(snapshot.state) as AgentTurnProcessState;
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
}

const sharedExecutors = new Map<string, Promise<AgentKernelTurnExecutor>>();

async function getExecutor(
  options: ExecuteAgentTurnViaKernelOptions,
): Promise<AgentKernelTurnExecutor> {
  if (!options.dataDir) {
    const executor = new AgentKernelTurnExecutor(options.runners, createCheckpointStore());
    await executor.initialize();
    return executor;
  }

  const key = options.dataDir;
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

export async function executeAgentTurnViaKernel(
  options: ExecuteAgentTurnViaKernelOptions,
): Promise<TurnResult> {
  const executor = await getExecutor(options);
  return await executor.executeTurn({
    ...options.input,
    runId: options.input.runId ?? ulid(),
  });
}
