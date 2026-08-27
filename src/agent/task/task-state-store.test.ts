import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRunState, transitionTaskRun } from './task-run-state.js';
import { JsonTaskRunStateStore } from './task-state-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('JsonTaskRunStateStore', () => {
  it('restores the latest task state after a process restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agentflyer-task-state-'));
    tempDirs.push(dataDir);
    const state = createTaskRunState(
      {
        taskId: 'persistent-task',
        goal: 'Keep task progress',
        acceptanceCriteria: ['State can be restored'],
      },
      100,
    );
    const store = new JsonTaskRunStateStore(dataDir);
    await store.save(transitionTaskRun(state, { action: 'start', runId: 'run-1' }, 110));

    const restored = await new JsonTaskRunStateStore(dataDir).load('persistent-task');

    expect(restored).toMatchObject({
      taskId: 'persistent-task',
      status: 'running',
      currentRunId: 'run-1',
      updatedAt: 110,
    });
  });
});