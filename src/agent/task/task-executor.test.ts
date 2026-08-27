import { describe, expect, it } from 'vitest';
import { createTaskRunState } from './task-run-state.js';
import { TaskExecutor } from './task-executor.js';

describe('TaskExecutor', () => {
  it('checkpoints progress and continues after a turn without full acceptance', async () => {
    const state = createTaskRunState(
      {
        taskId: 'task-executor-1',
        goal: 'Implement and verify a change',
        acceptanceCriteria: ['Focused test passes'],
      },
      100,
    );
    const checkpoints: string[] = [];
    const executor = new TaskExecutor({
      save: async (nextState) => {
        checkpoints.push(nextState.status);
      },
      runTurn: async () => ({
        status: 'done',
        hasProgress: true,
        acceptanceCriteriaSatisfied: false,
        evidence: [
          {
            kind: 'note' as const,
            description: 'Implementation started',
            value: 'source changed',
            recordedAt: 110,
          },
        ],
      }),
    });

    const result = await executor.run(state, 110);

    expect(result.decision).toEqual({
      action: 'continue',
      reason: 'Acceptance criteria are not satisfied',
    });
    expect(result.state.status).toBe('running');
    expect(result.state.evidence).toHaveLength(1);
    expect(checkpoints).toEqual(['running', 'running']);
  });

  it('keeps executing turns until acceptance is satisfied', async () => {
    const state = createTaskRunState(
      {
        taskId: 'task-executor-2',
        goal: 'Implement and verify a change',
        acceptanceCriteria: ['Focused test passes'],
      },
      100,
    );
    let turnCount = 0;
    const executor = new TaskExecutor({
      save: async () => {},
      runTurn: async () => {
        turnCount += 1;
        return {
          status: 'done' as const,
          hasProgress: true,
          acceptanceCriteriaSatisfied: turnCount === 2,
        };
      },
    });

    const result = await executor.runUntilTerminal(state, 110);

    expect(turnCount).toBe(2);
    expect(result.decision.action).toBe('complete');
    expect(result.state.status).toBe('completed');
  });
});