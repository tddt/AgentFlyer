import { describe, expect, it } from 'vitest';
import {
  buildSchedulerRunningTaskSignature,
  shouldRefreshSchedulerHistory,
} from './scheduler-running-sync.js';
import type { RunningTaskInfo } from './types.js';

function runningTask(overrides: Partial<RunningTaskInfo> = {}): RunningTaskInfo {
  return {
    taskId: 'task-a',
    taskName: 'Task A',
    startedAt: 100,
    agentRunId: 'run-a',
    status: 'running',
    resumable: false,
    ...overrides,
  };
}

describe('scheduler-running-sync', () => {
  it('builds a stable signature regardless of task ordering', () => {
    const first = buildSchedulerRunningTaskSignature([
      runningTask({ taskId: 'task-b', startedAt: 200, agentRunId: 'run-b' }),
      runningTask({ taskId: 'task-a', startedAt: 100, agentRunId: 'run-a' }),
    ]);
    const second = buildSchedulerRunningTaskSignature([
      runningTask({ taskId: 'task-a', startedAt: 100, agentRunId: 'run-a' }),
      runningTask({ taskId: 'task-b', startedAt: 200, agentRunId: 'run-b' }),
    ]);

    expect(first).toBe(second);
  });

  it('refreshes open history when the watched task enters or leaves the live set', () => {
    expect(
      shouldRefreshSchedulerHistory('task-a', [], [runningTask()]),
    ).toBe(true);
    expect(
      shouldRefreshSchedulerHistory('task-a', [runningTask()], []),
    ).toBe(true);
  });

  it('ignores unrelated running-task changes for history refresh', () => {
    expect(
      shouldRefreshSchedulerHistory(
        'task-a',
        [runningTask({ taskId: 'task-b' })],
        [runningTask({ taskId: 'task-c' })],
      ),
    ).toBe(false);
  });
});