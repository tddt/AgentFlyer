import { describe, expect, it } from 'vitest';
import type { WorkflowDef } from './workflow-backend.js';
import { WorkflowProcessRuntime } from './workflow-process-runtime.js';

function createWorkflow(overrides?: Partial<WorkflowDef>): WorkflowDef {
  return {
    id: 'wf-1',
    name: 'Test Workflow',
    steps: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('WorkflowProcessRuntime', () => {
  it('executes transform and condition steps with branching and vars snapshots', async () => {
    const workflow = createWorkflow({
      steps: [
        {
          id: 'first',
          type: 'transform',
          messageTemplate: '',
          transformCode: '`hello`',
          condition: 'on_success',
          outputs: [{ name: 'greeting', regex: '(hello)' }],
        },
        {
          id: 'branch',
          type: 'condition',
          messageTemplate: '',
          condition: 'on_success',
          branches: [{ expression: "vars.first.greeting === 'hello'", goto: 'final' }],
        },
        {
          id: 'skipped',
          type: 'transform',
          messageTemplate: '',
          transformCode: '`skipped`',
          condition: 'on_success',
        },
        {
          id: 'final',
          type: 'transform',
          messageTemplate: '',
          transformCode: '`final:${vars.first.greeting}`',
          condition: 'on_success',
        },
      ],
    });

    const runtime = new WorkflowProcessRuntime();
    let state = runtime.createInitialState({ runId: 'run-1', workflow, input: 'ignored' });

    const first = await runtime.step(state, {
      pid: 'pid-1' as never,
      now: 10,
      runCount: 0,
      retryCount: 0,
      metadata: {},
    });
    expect(first.signal).toBe('YIELD');
    state = first.state;
    expect(state.currentStepId).toBe('branch');

    const second = await runtime.step(state, {
      pid: 'pid-1' as never,
      now: 11,
      runCount: 1,
      retryCount: 0,
      metadata: {},
    });
    expect(second.signal).toBe('YIELD');
    state = second.state;
    expect(state.currentStepId).toBe('final');

    const third = await runtime.step(state, {
      pid: 'pid-1' as never,
      now: 12,
      runCount: 2,
      retryCount: 0,
      metadata: {},
    });

    expect(third.signal).toBe('DONE');
    expect(third.state.run.status).toBe('done');
    expect(third.state.run.stepResults).toHaveLength(3);
    expect(third.state.run.stepResults[0]?.output).toBe('hello');
    expect(third.state.run.stepResults[1]?.output).toBe('→ final');
    expect(third.state.run.stepResults[2]?.output).toBe('final:hello');
    expect(third.state.run.stepResults[2]?.varsSnapshot?.['first.greeting']).toBe('hello');
    expect(third.state.currentStepId).toBeUndefined();
  });

  it('retries agent steps before succeeding', async () => {
    let attempts = 0;
    const workflow = createWorkflow({
      steps: [
        {
          id: 'agent-step',
          type: 'agent',
          agentId: 'agent-main',
          messageTemplate: 'hello',
          condition: 'on_success',
          maxRetries: 1,
        },
      ],
    });

    const runtime = new WorkflowProcessRuntime({
      async runAgentStep() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('temporary failure');
        }
        return 'agent success';
      },
    });

    const initial = runtime.createInitialState({ runId: 'run-2', workflow, input: 'ping' });
    const retry = await runtime.step(initial, {
      pid: 'pid-2' as never,
      now: 20,
      runCount: 0,
      retryCount: 0,
      metadata: {},
    });
    expect(retry.signal).toBe('RETRYABLE_ERROR');
    expect(retry.state.currentAttempt).toBe(1);

    const done = await runtime.step(retry.state, {
      pid: 'pid-2' as never,
      now: 21,
      runCount: 1,
      retryCount: 1,
      metadata: {},
    });
    expect(done.signal).toBe('DONE');
    expect(done.state.run.stepResults[0]?.output).toBe('agent success');
    expect(done.state.currentStepId).toBeUndefined();
  });

  it('fails workflow when an on_success step exhausts retries', async () => {
    const workflow = createWorkflow({
      steps: [
        {
          id: 'fatal',
          type: 'agent',
          agentId: 'agent-main',
          messageTemplate: 'hello',
          condition: 'on_success',
          maxRetries: 0,
        },
      ],
    });

    const runtime = new WorkflowProcessRuntime({
      async runAgentStep() {
        throw new Error('fatal failure');
      },
    });

    const result = await runtime.step(
      runtime.createInitialState({ runId: 'run-3', workflow, input: '' }),
      {
        pid: 'pid-3' as never,
        now: 30,
        runCount: 0,
        retryCount: 0,
        metadata: {},
      },
    );

    expect(result.signal).toBe('ERROR');
    expect(result.state.phase).toBe('error');
    expect(result.state.run.stepResults[0]?.error).toBe('fatal failure');
  });

  it('supports explicit nextStepId routing for non-condition steps', async () => {
    const workflow = createWorkflow({
      steps: [
        {
          id: 'first',
          type: 'transform',
          messageTemplate: '',
          transformCode: '`first`',
          condition: 'on_success',
          nextStepId: 'final',
        },
        {
          id: 'skipped',
          type: 'transform',
          messageTemplate: '',
          transformCode: '`skipped`',
          condition: 'on_success',
        },
        {
          id: 'final',
          type: 'transform',
          messageTemplate: '',
          transformCode: '`final`',
          condition: 'on_success',
          nextStepId: '$end',
        },
      ],
    });

    const runtime = new WorkflowProcessRuntime();
    let state = runtime.createInitialState({ runId: 'run-next', workflow, input: '' });

    const first = await runtime.step(state, {
      pid: 'pid-next' as never,
      now: 40,
      runCount: 0,
      retryCount: 0,
      metadata: {},
    });
    expect(first.signal).toBe('YIELD');
    expect(first.state.currentStepId).toBe('final');
    state = first.state;

    const second = await runtime.step(state, {
      pid: 'pid-next' as never,
      now: 41,
      runCount: 1,
      retryCount: 0,
      metadata: {},
    });

    expect(second.signal).toBe('DONE');
    expect(second.state.run.stepResults).toHaveLength(2);
    expect(second.state.run.stepResults[0]?.output).toBe('first');
    expect(second.state.run.stepResults[1]?.output).toBe('final');
  });

  it('restores legacy serialized state by resolving currentStepId from currentStepIndex', () => {
    const workflow = createWorkflow({
      steps: [
        {
          id: 'first',
          type: 'transform',
          messageTemplate: '',
          transformCode: '`hello`',
          condition: 'on_success',
        },
        {
          id: 'second',
          type: 'transform',
          messageTemplate: '',
          transformCode: '`world`',
          condition: 'on_success',
        },
      ],
    });

    const runtime = new WorkflowProcessRuntime();
    const initial = runtime.createInitialState({ runId: 'run-legacy', workflow, input: '' });
    const legacyState = {
      ...initial,
      currentStepIndex: 1,
    };
    (legacyState as { currentStepId?: string }).currentStepId = undefined;

    const restored = runtime.deserialize(legacyState);

    expect(restored.currentStepIndex).toBe(1);
    expect(restored.currentStepId).toBe('second');
  });
});
