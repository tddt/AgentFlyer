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

  it('suspends on delegated agent suspension and resumes the same delegated run', async () => {
    const calls: Array<{ delegatedRunId?: string }> = [];
    const workflow = createWorkflow({
      steps: [
        {
          id: 'agent-step',
          type: 'agent',
          agentId: 'agent-main',
          messageTemplate: 'hello',
          condition: 'on_success',
        },
      ],
    });

    const runtime = new WorkflowProcessRuntime({
      async runAgentStep(request) {
        calls.push({ delegatedRunId: request.delegatedRunId });
        if (!request.delegatedRunId) {
          throw Object.assign(new Error('quota blocked'), {
            delegatedAgentId: 'agent-main',
            delegatedRunId: 'delegated-run-1',
            delegatedRunStatus: 'suspended' as const,
          });
        }
        return {
          output: 'agent success',
          delegatedAgentId: 'agent-main',
          delegatedRunId: request.delegatedRunId,
          delegatedRunStatus: 'done' as const,
        };
      },
    });

    const suspended = await runtime.step(
      runtime.createInitialState({ runId: 'run-suspend', workflow, input: '' }),
      {
        pid: 'pid-suspend' as never,
        now: 35,
        runCount: 0,
        retryCount: 0,
        metadata: {},
      },
    );

    expect(suspended.signal).toBe('SUSPENDED');
    expect(suspended.state.run.status).toBe('suspended');
    expect(suspended.state.run.stepResults[0]?.delegatedRunId).toBe('delegated-run-1');
    expect(suspended.state.run.stepResults[0]?.delegatedRunStatus).toBe('suspended');

    const resumed = await runtime.step(suspended.state, {
      pid: 'pid-suspend' as never,
      now: 36,
      runCount: 1,
      retryCount: 0,
      metadata: {},
    });

    expect(resumed.signal).toBe('DONE');
    expect(resumed.state.run.status).toBe('done');
    expect(resumed.state.run.stepResults).toHaveLength(1);
    expect(resumed.state.run.stepResults[0]?.output).toBe('agent success');
    expect(resumed.state.run.stepResults[0]?.delegatedRunId).toBe('delegated-run-1');
    expect(resumed.state.run.stepResults[0]?.delegatedRunStatus).toBe('done');
    expect(calls).toEqual([{ delegatedRunId: undefined }, { delegatedRunId: 'delegated-run-1' }]);
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

  it('executes multi_source super nodes by fanning out participant agents before coordinator synthesis', async () => {
    const calls: Array<{ agentId: string; stepId: string; message: string; threadKey: string }> =
      [];
    const workflow = createWorkflow({
      steps: [
        {
          id: 'collect',
          type: 'multi_source',
          agentId: 'coordinator-agent',
          participantAgentIds: ['source-a', 'source-b'],
          superNodePrompts: ['政策监管', '市场竞争'],
          messageTemplate: '围绕机器人行业做全维度采集',
          condition: 'on_success',
        },
      ],
    });

    const runtime = new WorkflowProcessRuntime({
      async runAgentStep(request) {
        calls.push(request);
        if (request.agentId === 'coordinator-agent') {
          expect(request.message).toContain('行业信息整合包');
          expect(request.message).toContain('source-a');
          expect(request.message).toContain('source-b');
          return '行业信息整合包：完成';
        }

        return `子结果:${request.agentId}`;
      },
    });

    const result = await runtime.step(
      runtime.createInitialState({ runId: 'run-super-node', workflow, input: 'ignored' }),
      {
        pid: 'pid-super-node' as never,
        now: 50,
        runCount: 0,
        retryCount: 0,
        metadata: {},
      },
    );

    expect(result.signal).toBe('DONE');
    expect(result.state.run.stepResults[0]?.output).toBe('行业信息整合包：完成');
    expect(result.state.run.stepResults[0]?.superNodeTrace).toEqual({
      type: 'multi_source',
      parentRunId: 'run-super-node',
      parentStepId: 'collect',
      participantExecution: 'fresh',
      coordinatorAttempt: 1,
      coordinatorAgentId: 'coordinator-agent',
      coordinatorLineage: {
        parentRunId: 'run-super-node',
        parentStepId: 'collect',
        childStepId: 'collect:coordinator',
        threadKey: 'workflow:run-super-node:step0:coordinator',
        role: 'coordinator',
      },
      coordinatorStatus: 'done',
      coordinatorStartedAt: expect.any(Number),
      coordinatorFinishedAt: expect.any(Number),
      participantResults: [
        {
          agentId: 'source-a',
          status: 'done',
          prompt: '政策监管',
          startedAt: expect.any(Number),
          finishedAt: expect.any(Number),
          lineage: {
            parentRunId: 'run-super-node',
            parentStepId: 'collect',
            childStepId: 'collect:participant:1',
            threadKey: 'workflow:run-super-node:step0:participant-1',
            role: 'participant',
            participantIndex: 1,
          },
          output: '子结果:source-a',
        },
        {
          agentId: 'source-b',
          status: 'done',
          prompt: '市场竞争',
          startedAt: expect.any(Number),
          finishedAt: expect.any(Number),
          lineage: {
            parentRunId: 'run-super-node',
            parentStepId: 'collect',
            childStepId: 'collect:participant:2',
            threadKey: 'workflow:run-super-node:step0:participant-2',
            role: 'participant',
            participantIndex: 2,
          },
          output: '子结果:source-b',
        },
      ],
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]?.agentId).toBe('source-a');
    expect(calls[1]?.agentId).toBe('source-b');
    expect(calls[2]?.agentId).toBe('coordinator-agent');
    expect(calls[0]?.threadKey).toContain('participant-1');
    expect(calls[2]?.threadKey).toContain('coordinator');
  });

  it('preserves participant trace when a debate super node participant fails', async () => {
    const workflow = createWorkflow({
      steps: [
        {
          id: 'debate-step',
          type: 'debate',
          agentId: 'coordinator-agent',
          participantAgentIds: ['pro-agent', 'con-agent'],
          superNodePrompts: ['支持推进', '谨慎反对'],
          messageTemplate: '是否推进海外扩张',
          condition: 'on_success',
        },
      ],
    });

    const runtime = new WorkflowProcessRuntime({
      async runAgentStep(request) {
        if (request.agentId === 'con-agent') {
          throw new Error('evidence missing');
        }
        if (request.agentId === 'coordinator-agent') {
          return 'should not run';
        }
        return `子结果:${request.agentId}`;
      },
    });

    const result = await runtime.step(
      runtime.createInitialState({ runId: 'run-super-node-error', workflow, input: 'ignored' }),
      {
        pid: 'pid-super-node-error' as never,
        now: 60,
        runCount: 0,
        retryCount: 0,
        metadata: {},
      },
    );

    expect(result.signal).toBe('ERROR');
    expect(result.state.run.stepResults[0]?.error).toContain("participant 'con-agent' failed");
    expect(result.state.run.stepResults[0]?.superNodeTrace).toEqual({
      type: 'debate',
      parentRunId: 'run-super-node-error',
      parentStepId: 'debate-step',
      participantExecution: 'fresh',
      coordinatorAttempt: 1,
      coordinatorAgentId: 'coordinator-agent',
      coordinatorLineage: {
        parentRunId: 'run-super-node-error',
        parentStepId: 'debate-step',
        childStepId: 'debate-step:coordinator',
        threadKey: 'workflow:run-super-node-error:step0:coordinator',
        role: 'coordinator',
      },
      participantResults: [
        {
          agentId: 'pro-agent',
          status: 'done',
          prompt: '支持推进',
          startedAt: expect.any(Number),
          finishedAt: expect.any(Number),
          lineage: {
            parentRunId: 'run-super-node-error',
            parentStepId: 'debate-step',
            childStepId: 'debate-step:participant:1',
            threadKey: 'workflow:run-super-node-error:step0:participant-1',
            role: 'participant',
            participantIndex: 1,
          },
          output: '子结果:pro-agent',
        },
        {
          agentId: 'con-agent',
          status: 'error',
          prompt: '谨慎反对',
          startedAt: expect.any(Number),
          finishedAt: expect.any(Number),
          lineage: {
            parentRunId: 'run-super-node-error',
            parentStepId: 'debate-step',
            childStepId: 'debate-step:participant:2',
            threadKey: 'workflow:run-super-node-error:step0:participant-2',
            role: 'participant',
            participantIndex: 2,
          },
          error: 'evidence missing',
        },
      ],
    });
  });

  it('retries only coordinator work for super nodes after participant success', async () => {
    const calls: Array<{ agentId: string; threadKey: string }> = [];
    let coordinatorAttempts = 0;
    const workflow = createWorkflow({
      steps: [
        {
          id: 'decide',
          type: 'decision',
          agentId: 'coordinator-agent',
          participantAgentIds: ['planner-a', 'planner-b'],
          superNodePrompts: ['目标拆解', '资源约束'],
          messageTemplate: '制定季度推进方案',
          condition: 'on_success',
          maxRetries: 1,
        },
      ],
    });

    const runtime = new WorkflowProcessRuntime({
      async runAgentStep(request) {
        calls.push({ agentId: request.agentId, threadKey: request.threadKey });
        if (request.agentId === 'coordinator-agent') {
          coordinatorAttempts += 1;
          if (coordinatorAttempts === 1) {
            throw new Error('coordinator boom');
          }
          return '结构化决策方案：完成';
        }
        return `子结果:${request.agentId}`;
      },
    });

    const retry = await runtime.step(
      runtime.createInitialState({ runId: 'run-super-node-retry', workflow, input: 'ignored' }),
      {
        pid: 'pid-super-node-retry' as never,
        now: 80,
        runCount: 0,
        retryCount: 0,
        metadata: {},
      },
    );

    expect(retry.signal).toBe('RETRYABLE_ERROR');
    expect(retry.state.currentAttempt).toBe(1);
    expect(retry.state.retrySuperNodeTrace).toMatchObject({
      type: 'decision',
      participantExecution: 'fresh',
      coordinatorAttempt: 1,
      coordinatorStatus: 'error',
      participantResults: [
        { agentId: 'planner-a', status: 'done' },
        { agentId: 'planner-b', status: 'done' },
      ],
    });

    const done = await runtime.step(retry.state, {
      pid: 'pid-super-node-retry' as never,
      now: 81,
      runCount: 1,
      retryCount: 1,
      metadata: {},
    });

    expect(done.signal).toBe('DONE');
    expect(done.state.run.stepResults[0]?.output).toBe('结构化决策方案：完成');
    expect(done.state.run.stepResults[0]?.superNodeTrace).toMatchObject({
      type: 'decision',
      parentRunId: 'run-super-node-retry',
      parentStepId: 'decide',
      participantExecution: 'reused',
      coordinatorAttempt: 2,
      coordinatorStatus: 'done',
      participantResults: [
        {
          agentId: 'planner-a',
          lineage: {
            parentRunId: 'run-super-node-retry',
            parentStepId: 'decide',
            childStepId: 'decide:participant:1',
            threadKey: 'workflow:run-super-node-retry:step0:participant-1',
            role: 'participant',
            participantIndex: 1,
          },
        },
        {
          agentId: 'planner-b',
          lineage: {
            parentRunId: 'run-super-node-retry',
            parentStepId: 'decide',
            childStepId: 'decide:participant:2',
            threadKey: 'workflow:run-super-node-retry:step0:participant-2',
            role: 'participant',
            participantIndex: 2,
          },
        },
      ],
    });
    expect(calls).toEqual([
      { agentId: 'planner-a', threadKey: 'workflow:run-super-node-retry:step0:participant-1' },
      { agentId: 'planner-b', threadKey: 'workflow:run-super-node-retry:step0:participant-2' },
      {
        agentId: 'coordinator-agent',
        threadKey: 'workflow:run-super-node-retry:step0:coordinator',
      },
      {
        agentId: 'coordinator-agent',
        threadKey: 'workflow:run-super-node-retry:step0:coordinator',
      },
    ]);
  });

  it('resumes suspended coordinator without rerunning super node participants', async () => {
    const calls: Array<{ agentId: string; delegatedRunId?: string; threadKey: string }> = [];
    const workflow = createWorkflow({
      steps: [
        {
          id: 'review',
          type: 'risk_review',
          agentId: 'coordinator-agent',
          participantAgentIds: ['risk-a', 'risk-b'],
          superNodePrompts: ['合规风险', '经营风险'],
          messageTemplate: '评估季度经营方案风险',
          condition: 'on_success',
        },
      ],
    });

    const runtime = new WorkflowProcessRuntime({
      async runAgentStep(request) {
        calls.push({
          agentId: request.agentId,
          delegatedRunId: request.delegatedRunId,
          threadKey: request.threadKey,
        });
        if (request.agentId === 'coordinator-agent') {
          if (!request.delegatedRunId) {
            throw Object.assign(new Error('coordinator waiting approval'), {
              delegatedAgentId: 'coordinator-agent',
              delegatedRunId: 'coord-run-1',
              delegatedRunStatus: 'suspended' as const,
            });
          }
          return {
            output: '风险审核报告：完成',
            delegatedAgentId: 'coordinator-agent',
            delegatedRunId: request.delegatedRunId,
            delegatedRunStatus: 'done' as const,
          };
        }
        return `子结果:${request.agentId}`;
      },
    });

    const suspended = await runtime.step(
      runtime.createInitialState({ runId: 'run-super-node-suspend', workflow, input: 'ignored' }),
      {
        pid: 'pid-super-node-suspend' as never,
        now: 90,
        runCount: 0,
        retryCount: 0,
        metadata: {},
      },
    );

    expect(suspended.signal).toBe('SUSPENDED');
    expect(suspended.state.retrySuperNodeTrace).toMatchObject({
      type: 'risk_review',
      participantExecution: 'fresh',
      coordinatorAttempt: 1,
      coordinatorDelegatedRunId: 'coord-run-1',
      coordinatorDelegatedRunStatus: 'suspended',
      participantResults: [
        { agentId: 'risk-a', status: 'done' },
        { agentId: 'risk-b', status: 'done' },
      ],
    });
    expect(suspended.state.run.stepResults[0]?.delegatedRunId).toBe('coord-run-1');
    expect(suspended.state.run.stepResults[0]?.delegatedRunStatus).toBe('suspended');

    const resumed = await runtime.step(suspended.state, {
      pid: 'pid-super-node-suspend' as never,
      now: 91,
      runCount: 1,
      retryCount: 0,
      metadata: {},
    });

    expect(resumed.signal).toBe('DONE');
    expect(resumed.state.run.stepResults[0]?.output).toBe('风险审核报告：完成');
    expect(resumed.state.run.stepResults[0]?.superNodeTrace).toMatchObject({
      type: 'risk_review',
      participantExecution: 'reused',
      coordinatorAttempt: 2,
      coordinatorDelegatedRunId: 'coord-run-1',
      coordinatorDelegatedRunStatus: 'done',
    });
    expect(calls).toEqual([
      {
        agentId: 'risk-a',
        delegatedRunId: undefined,
        threadKey: 'workflow:run-super-node-suspend:step0:participant-1',
      },
      {
        agentId: 'risk-b',
        delegatedRunId: undefined,
        threadKey: 'workflow:run-super-node-suspend:step0:participant-2',
      },
      {
        agentId: 'coordinator-agent',
        delegatedRunId: undefined,
        threadKey: 'workflow:run-super-node-suspend:step0:coordinator',
      },
      {
        agentId: 'coordinator-agent',
        delegatedRunId: 'coord-run-1',
        threadKey: 'workflow:run-super-node-suspend:step0:coordinator',
      },
    ]);
  });

  it('resumes suspended participant without rerunning completed participants', async () => {
    const calls: Array<{ agentId: string; delegatedRunId?: string; threadKey: string }> = [];
    const workflow = createWorkflow({
      steps: [
        {
          id: 'collect',
          type: 'multi_source',
          agentId: 'coordinator-agent',
          participantAgentIds: ['source-a', 'source-b'],
          superNodePrompts: ['政策监管', '市场竞争'],
          messageTemplate: '围绕机器人行业做全维度采集',
          condition: 'on_success',
        },
      ],
    });

    const runtime = new WorkflowProcessRuntime({
      async runAgentStep(request) {
        calls.push({
          agentId: request.agentId,
          delegatedRunId: request.delegatedRunId,
          threadKey: request.threadKey,
        });
        if (request.agentId === 'source-a') {
          if (!request.delegatedRunId) {
            throw Object.assign(new Error('source-a waiting approval'), {
              delegatedAgentId: 'source-a',
              delegatedRunId: 'participant-run-1',
              delegatedRunStatus: 'suspended' as const,
            });
          }
          return {
            output: '子结果:source-a',
            delegatedAgentId: 'source-a',
            delegatedRunId: request.delegatedRunId,
            delegatedRunStatus: 'done' as const,
          };
        }
        if (request.agentId === 'coordinator-agent') {
          return '行业信息整合包：完成';
        }
        return '子结果:source-b';
      },
    });

    const suspended = await runtime.step(
      runtime.createInitialState({
        runId: 'run-super-node-participant-suspend',
        workflow,
        input: 'ignored',
      }),
      {
        pid: 'pid-super-node-participant-suspend' as never,
        now: 92,
        runCount: 0,
        retryCount: 0,
        metadata: {},
      },
    );

    expect(suspended.signal).toBe('SUSPENDED');
    expect(suspended.state.retrySuperNodeTrace).toMatchObject({
      type: 'multi_source',
      participantExecution: 'fresh',
      coordinatorAttempt: 1,
      participantResults: [
        {
          agentId: 'source-a',
          status: 'suspended',
          delegatedRunId: 'participant-run-1',
          delegatedRunStatus: 'suspended',
        },
        {
          agentId: 'source-b',
          status: 'done',
        },
      ],
    });
    expect(suspended.state.run.stepResults[0]?.delegatedRunId).toBe('participant-run-1');
    expect(suspended.state.run.stepResults[0]?.delegatedRunStatus).toBe('suspended');

    const resumed = await runtime.step(suspended.state, {
      pid: 'pid-super-node-participant-suspend' as never,
      now: 93,
      runCount: 1,
      retryCount: 0,
      metadata: {},
    });

    expect(resumed.signal).toBe('DONE');
    expect(resumed.state.run.stepResults[0]?.output).toBe('行业信息整合包：完成');
    expect(resumed.state.run.stepResults[0]?.superNodeTrace).toMatchObject({
      type: 'multi_source',
      participantExecution: 'reused',
      coordinatorAttempt: 1,
      participantResults: [
        {
          agentId: 'source-a',
          status: 'done',
          delegatedRunId: 'participant-run-1',
          delegatedRunStatus: 'done',
        },
        {
          agentId: 'source-b',
          status: 'done',
        },
      ],
      coordinatorStatus: 'done',
    });
    expect(calls).toEqual([
      {
        agentId: 'source-a',
        delegatedRunId: undefined,
        threadKey: 'workflow:run-super-node-participant-suspend:step0:participant-1',
      },
      {
        agentId: 'source-b',
        delegatedRunId: undefined,
        threadKey: 'workflow:run-super-node-participant-suspend:step0:participant-2',
      },
      {
        agentId: 'source-a',
        delegatedRunId: 'participant-run-1',
        threadKey: 'workflow:run-super-node-participant-suspend:step0:participant-1',
      },
      {
        agentId: 'coordinator-agent',
        delegatedRunId: undefined,
        threadKey: 'workflow:run-super-node-participant-suspend:step0:coordinator',
      },
    ]);
  });

  it('carries structured failure context into the next step for non-fatal super node errors', async () => {
    const workflow = createWorkflow({
      steps: [
        {
          id: 'collect',
          type: 'multi_source',
          agentId: 'coordinator-agent',
          participantAgentIds: ['source-a', 'source-b'],
          superNodePrompts: ['市场动向', '用户反馈'],
          messageTemplate: '{{input}}',
          condition: 'any',
        },
        {
          id: 'after-error',
          type: 'transform',
          messageTemplate: '',
          transformCode:
            '`continued:${prev_output.includes("participantResults")}:${prev_output.includes("source-b")}:${prev_output.includes("boom")}`',
          condition: 'on_success',
        },
      ],
    });

    const runtime = new WorkflowProcessRuntime({
      async runAgentStep(request) {
        if (request.agentId === 'source-a') {
          throw new Error('boom');
        }
        if (request.agentId === 'source-b') {
          return '子结果:source-b';
        }
        return 'should not run';
      },
    });

    const first = await runtime.step(
      runtime.createInitialState({
        runId: 'run-super-node-continue',
        workflow,
        input: '行业主题',
      }),
      {
        pid: 'pid-super-node-continue' as never,
        now: 70,
        runCount: 0,
        retryCount: 0,
        metadata: {},
      },
    );

    expect(first.signal).toBe('YIELD');
    expect(first.state.run.stepResults[0]?.error).toContain("participant 'source-a' failed");

    const second = await runtime.step(first.state, {
      pid: 'pid-super-node-continue' as never,
      now: 71,
      runCount: 1,
      retryCount: 0,
      metadata: {},
    });

    expect(second.signal).toBe('DONE');
    expect(second.state.run.stepResults[1]?.output).toBe('continued:true:true:true');
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
