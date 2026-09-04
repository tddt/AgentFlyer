import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentKernel } from './agent-kernel.js';
import { CoalescingCheckpointStore, JsonFileCheckpointStore } from './checkpoint-store.js';
import type { CheckpointStore, KernelProcessSnapshot, ProcessRuntime } from './types.js';
import type { ProcessId } from '../types.js';

const tempDirs: string[] = [];

class RecordingCheckpointStore implements CheckpointStore {
  readonly saves: KernelProcessSnapshot[] = [];
  private readonly snapshots = new Map<ProcessId, KernelProcessSnapshot>();

  async save(snapshot: KernelProcessSnapshot): Promise<void> {
    this.saves.push(snapshot);
    this.snapshots.set(snapshot.pid, snapshot);
  }

  async load(pid: ProcessId): Promise<KernelProcessSnapshot | null> {
    return this.snapshots.get(pid) ?? null;
  }

  async list(): Promise<KernelProcessSnapshot[]> {
    return Array.from(this.snapshots.values());
  }

  async delete(pid: ProcessId): Promise<void> {
    this.snapshots.delete(pid);
  }
}

class BlockingCheckpointStore extends RecordingCheckpointStore {
  private firstSaveStartedResolve: (() => void) | undefined;
  private releaseFirstSaveResolve: (() => void) | undefined;
  readonly firstSaveStarted = new Promise<void>((resolve) => {
    this.firstSaveStartedResolve = resolve;
  });
  readonly releaseFirstSave = new Promise<void>((resolve) => {
    this.releaseFirstSaveResolve = resolve;
  });

  override async save(snapshot: KernelProcessSnapshot): Promise<void> {
    this.firstSaveStartedResolve?.();
    this.firstSaveStartedResolve = undefined;
    await this.releaseFirstSave;
    await super.save(snapshot);
  }

  release(): void {
    this.releaseFirstSaveResolve?.();
  }
}

function checkpointSnapshot(pid: ProcessId, status: KernelProcessSnapshot['status']): KernelProcessSnapshot {
  return {
    pid,
    processType: 'test',
    version: 1,
    status,
    priority: 'normal',
    state: { status },
    createdAt: 1,
    updatedAt: status === 'done' ? 3 : 2,
    runCount: 1,
    retryCount: 0,
    metadata: {},
  };
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentflyer-kernel-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

interface CounterState {
  remaining: number;
  observedSyscall?: boolean;
}

const counterRuntime: ProcessRuntime<CounterState, { remaining: number }> = {
  type: 'counter',
  version: 1,
  createInitialState(input) {
    return { remaining: input.remaining };
  },
  async step(state, context) {
    if (context.lastSyscallResult?.requestId === 'syscall-1' && context.lastSyscallResult.ok) {
      return {
        signal: 'DONE',
        state: { ...state, observedSyscall: true },
      };
    }

    if (state.remaining <= 0) {
      return { signal: 'DONE', state };
    }

    if (state.remaining === 1) {
      return {
        signal: 'WAITING_SYSCALL',
        state,
        syscall: {
          id: 'syscall-1',
          kind: 'tool.call',
          operation: 'demo-tool',
          payload: { remaining: state.remaining },
          createdAt: context.now,
        },
      };
    }

    return {
      signal: 'YIELD',
      state: { remaining: state.remaining - 1 },
      nextRunAt: context.now,
    };
  },
  serialize(state) {
    return state;
  },
  deserialize(payload) {
    return payload as CounterState;
  },
};

describe('AgentKernel', () => {
  it('coalesces same-turn checkpoint saves and preserves delete ordering', async () => {
    const inner = new RecordingCheckpointStore();
    const store = new CoalescingCheckpointStore(inner);
    const pid = 'checkpoint-test' as ProcessId;
    const first = store.save(checkpointSnapshot(pid, 'ready'));
    const second = store.save(checkpointSnapshot(pid, 'done'));

    await Promise.all([first, second]);
    expect(inner.saves).toHaveLength(1);
    expect(inner.saves[0]?.status).toBe('done');

    await store.delete(pid);
    await expect(store.load(pid)).resolves.toBeNull();
  });

  it('serializes save-delete-save operations for one process', async () => {
    const inner = new BlockingCheckpointStore();
    const store = new CoalescingCheckpointStore(inner);
    const pid = 'checkpoint-ordering-test' as ProcessId;

    const firstSave = store.save(checkpointSnapshot(pid, 'ready'));
    await inner.firstSaveStarted;
    const deletion = store.delete(pid);
    const secondSave = store.save(checkpointSnapshot(pid, 'done'));

    inner.release();
    await Promise.all([firstSave, deletion, secondSave]);
    await expect(store.load(pid)).resolves.toMatchObject({ status: 'done' });
  });

  it('runs a process step-by-step and persists checkpoints', async () => {
    const dataDir = await createTempDir();
    const checkpointStore = new JsonFileCheckpointStore(dataDir);
    const kernel = new AgentKernel({ checkpointStore, now: () => 1000 });
    kernel.registerProcessRuntime(counterRuntime);

    const created = await kernel.createProcess({
      processType: 'counter',
      input: { remaining: 2 },
      priority: 'high',
      metadata: { origin: 'test' },
    });

    const first = await kernel.tick();
    expect(first.kind).toBe('executed');
    expect(first.signal).toBe('YIELD');

    const waiting = await kernel.tick();
    expect(waiting.signal).toBe('WAITING_SYSCALL');

    const waitingSnapshot = kernel.getSnapshot(created.pid);
    expect(waitingSnapshot?.status).toBe('waiting');
    expect(waitingSnapshot?.pendingSyscall?.id).toBe('syscall-1');

    await kernel.resolveSyscall(created.pid, {
      requestId: 'syscall-1',
      ok: true,
      payload: { accepted: true },
      resolvedAt: 1000,
    });

    const done = await kernel.tick();
    expect(done.signal).toBe('DONE');
    expect(kernel.getSnapshot(created.pid)?.status).toBe('done');

    const restored = new AgentKernel({ checkpointStore, now: () => 1000 });
    restored.registerProcessRuntime(counterRuntime);
    const count = await restored.restoreFromCheckpoints();
    expect(count).toBe(1);
    expect(restored.getSnapshot(created.pid)?.status).toBe('done');
  });

  it('marks uncaught runtime failures as process errors', async () => {
    const dataDir = await createTempDir();
    const checkpointStore = new JsonFileCheckpointStore(dataDir);
    const kernel = new AgentKernel({ checkpointStore, now: () => 2000 });

    kernel.registerProcessRuntime({
      type: 'failing',
      version: 1,
      createInitialState() {
        return { started: true };
      },
      async step() {
        throw new Error('boom');
      },
      serialize(state) {
        return state;
      },
      deserialize(payload) {
        return payload as { started: boolean };
      },
    });

    const created = await kernel.createProcess({
      processType: 'failing',
      input: undefined,
    });
    const result = await kernel.tick();
    expect(result.signal).toBe('ERROR');
    expect(kernel.getSnapshot(created.pid)?.status).toBe('error');
    expect(kernel.getSnapshot(created.pid)?.lastError?.code).toBe('UNCAUGHT_PROCESS_ERROR');
  });
});
