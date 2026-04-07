import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentKernel } from './agent-kernel.js';
import { JsonFileCheckpointStore } from './checkpoint-store.js';
import type { ProcessRuntime } from './types.js';

const tempDirs: string[] = [];

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
