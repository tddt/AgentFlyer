import { describe, expect, it, vi } from 'vitest';
import { executeDelegatedAgentRun } from './scheduled-agent-run.js';

describe('executeDelegatedAgentRun', () => {
  it('returns done with default output fallback when wait succeeds', async () => {
    const outcome = await executeDelegatedAgentRun({
      resolveRunId: async () => 'run-1',
      waitForResult: async () => ({ text: '' }),
      readRun: async () => null,
    });

    expect(outcome).toEqual({
      text: '(no output)',
      runId: 'run-1',
      runStatus: 'done',
    });
  });

  it('runs resume hook before waiting and reports run id to callers', async () => {
    const steps: string[] = [];
    const onRunState = vi.fn();
    const outcome = await executeDelegatedAgentRun({
      resolveRunId: async () => {
        steps.push('resolve');
        return 'run-resume';
      },
      beforeWait: async (runId) => {
        steps.push(`resume:${runId}`);
      },
      waitForResult: async (runId) => {
        steps.push(`wait:${runId}`);
        return { text: 'resumed ok' };
      },
      readRun: async () => null,
      onRunState,
    });

    expect(steps).toEqual(['resolve', 'resume:run-resume', 'wait:run-resume']);
    expect(onRunState).toHaveBeenCalledWith({ agentRunId: 'run-resume' });
    expect(outcome.runStatus).toBe('done');
  });

  it('returns suspended when the delegated run is still suspendable after a wait failure', async () => {
    const outcome = await executeDelegatedAgentRun({
      resolveRunId: async () => 'run-suspended',
      waitForResult: async () => {
        throw new Error('quota blocked');
      },
      readRun: async () => ({
        processStatus: 'suspended',
        phase: 'suspended',
        controlState: 'suspended',
        error: {
          code: 'AGENT_LLM_RESOURCE_BLOCKED',
          message: 'quota blocked, resume later',
          retryable: true,
        },
      }),
    });

    expect(outcome).toEqual({
      text: 'quota blocked, resume later',
      runId: 'run-suspended',
      runStatus: 'suspended',
    });
  });
});
