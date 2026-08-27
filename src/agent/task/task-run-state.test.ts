import { describe, expect, it } from 'vitest';
import {
  createTaskRunState,
  decideTaskContinuation,
  recordTaskEvidence,
  transitionTaskRun,
} from './task-run-state.js';

describe('task run state', () => {
  it('creates a resumable task with an explicit acceptance contract', () => {
    const state = createTaskRunState(
      {
        taskId: 'task-1',
        goal: 'Add a health endpoint',
        acceptanceCriteria: ['GET /health returns 200', 'The endpoint has a test'],
      },
      100,
    );

    expect(state).toMatchObject({
      taskId: 'task-1',
      goal: 'Add a health endpoint',
      phase: 'planning',
      status: 'queued',
      acceptanceCriteria: [
        { description: 'GET /health returns 200', completed: false },
        { description: 'The endpoint has a test', completed: false },
      ],
      evidence: [],
      retryCount: 0,
      updatedAt: 100,
    });
  });

  it('does not complete a task when a turn stops without acceptance evidence', () => {
    const decision = decideTaskContinuation({
      turnStatus: 'done',
      acceptanceCriteriaSatisfied: false,
      hasProgress: true,
      retryCount: 0,
      maxRetries: 2,
    });

    expect(decision).toEqual({
      action: 'continue',
      reason: 'Acceptance criteria are not satisfied',
    });
  });

  it('persists evidence and resumes from a serialized state', () => {
    const initial = createTaskRunState(
      {
        taskId: 'task-2',
        goal: 'Fix the failing test',
        plan: ['Inspect the failure', 'Apply the smallest fix'],
        acceptanceCriteria: ['The focused test passes'],
      },
      200,
    );
    const withEvidence = recordTaskEvidence(initial, {
      kind: 'test',
      description: 'Focused test passed',
      value: '1 passed',
      recordedAt: 210,
    });
    const suspended = transitionTaskRun(
      withEvidence,
      {
        action: 'suspend',
        reason: 'Waiting for approval',
      },
      220,
    );

    const restored = JSON.parse(JSON.stringify(suspended)) as typeof suspended;
    expect(restored).toEqual({
      ...suspended,
      status: 'suspended',
      blockedReason: 'Waiting for approval',
      evidence: [
        {
          kind: 'test',
          description: 'Focused test passed',
          value: '1 passed',
          recordedAt: 210,
        },
      ],
      updatedAt: 220,
    });
  });
});
