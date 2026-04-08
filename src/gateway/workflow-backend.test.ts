import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import type { AgentRunner } from '../agent/runner.js';
import { DeliverableStore } from './deliverables.js';
import type { RpcContext } from './rpc.js';
import {
  type WorkflowDef,
  dispatchWorkflowRpc,
  runWorkflowForScheduler,
  validateWorkflowDef,
} from './workflow-backend.js';

function createWorkflow(overrides?: Partial<WorkflowDef>): WorkflowDef {
  return {
    id: 'wf-kernel',
    name: 'Kernel Workflow',
    steps: [
      {
        id: 'agent-step',
        type: 'agent',
        agentId: 'agent-main',
        messageTemplate: 'hello {{input}}',
        condition: 'on_success',
      },
    ],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function createRunner(): AgentRunner {
  let threadKey = 'default';
  return {
    setThread(nextThreadKey: string) {
      threadKey = nextThreadKey;
      return undefined;
    },
    serializeState() {
      return {
        threadKey,
        promptLayerHashes: [],
        cachedSystemPrompt: null,
        toolResultCache: [],
      };
    },
    restoreState(state: { threadKey: string }) {
      threadKey = state.threadKey;
    },
    get currentSessionKey() {
      return `agent:agent-main:${threadKey}`;
    },
    async beginKernelTurn(runId: string, message: string) {
      return {
        runId,
        userMessage: message,
        options: undefined,
        model: 'fake-model',
        maxTokens: 256,
        systemPrompt: '',
        messages: [],
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalText: '',
        toolRounds: 0,
        toolFailureMessages: [],
        finalFailureMessage: null,
        finalFailureCode: undefined,
        recoverableStreamRetries: 0,
        toolLoopDetector: { lastEntry: null, consecutiveRepeats: 0 },
      };
    },
    async continueKernelTurn(state: {
      runId: string;
      userMessage: string;
      totalInputTokens: number;
      totalOutputTokens: number;
    }) {
      const text = `reply:${state.userMessage}`;
      return {
        state: {
          ...state,
          totalText: text,
        },
        chunks: [
          { type: 'text_delta', text },
          { type: 'done', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' },
        ],
        done: true,
        result: {
          sessionKey: `agent:agent-main:${threadKey}`,
          text,
          inputTokens: 1,
          outputTokens: 1,
        },
      };
    },
    async *turn(message: string) {
      yield {
        type: 'text_delta',
        text: `reply:${message}`,
      };
      return {
        sessionKey: `agent:agent-main:${threadKey}`,
        text: `reply:${message}`,
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  } as unknown as AgentRunner;
}

function createBlockingRunner(unblock: Promise<void>): AgentRunner {
  let threadKey = 'default';
  let released = false;
  const waitForRelease = async (): Promise<void> => {
    if (released) {
      return;
    }
    await unblock;
    released = true;
  };
  return {
    setThread(nextThreadKey: string) {
      threadKey = nextThreadKey;
      return undefined;
    },
    serializeState() {
      return {
        threadKey,
        promptLayerHashes: [],
        cachedSystemPrompt: null,
        toolResultCache: [],
      };
    },
    restoreState(state: { threadKey: string }) {
      threadKey = state.threadKey;
    },
    get currentSessionKey() {
      return `agent:agent-main:${threadKey}`;
    },
    async beginKernelTurn(runId: string, message: string) {
      return {
        runId,
        userMessage: message,
        options: undefined,
        model: 'fake-model',
        maxTokens: 256,
        systemPrompt: '',
        messages: [],
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalText: '',
        toolRounds: 0,
        toolFailureMessages: [],
        finalFailureMessage: null,
        finalFailureCode: undefined,
        recoverableStreamRetries: 0,
        toolLoopDetector: { lastEntry: null, consecutiveRepeats: 0 },
      };
    },
    async continueKernelTurn(state: {
      runId: string;
      userMessage: string;
      totalInputTokens: number;
      totalOutputTokens: number;
    }) {
      await waitForRelease();
      const text = `reply:${state.userMessage}`;
      return {
        state: {
          ...state,
          totalText: text,
        },
        chunks: [
          { type: 'text_delta', text },
          { type: 'done', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' },
        ],
        done: true,
        result: {
          sessionKey: `agent:agent-main:${threadKey}`,
          text,
          inputTokens: 1,
          outputTokens: 1,
        },
      };
    },
  } as unknown as AgentRunner;
}

function createRpcContext(dataDir: string, runner: AgentRunner = createRunner()): RpcContext {
  return {
    runners: new Map([['agent-main', runner]]),
    gatewayVersion: 'test',
    startedAt: 0,
    dataDir,
    getConfig: () => ({}) as never,
    saveAndReload: async () => ({ reloaded: [] }),
    scheduler: {} as never,
    shutdown: async () => undefined,
    reload: async () => ({ reloaded: [] }),
    listSkills: () => [],
    sessionStore: {} as never,
    metaStore: {} as never,
    contentStore: {
      async list() {
        return [];
      },
    } as never,
    deliverableStore: new DeliverableStore(dataDir),
    channels: new Map(),
    runningTasks: new Map(),
  };
}

async function writeWorkflows(dataDir: string, workflows: WorkflowDef[]): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'workflows.json'), JSON.stringify(workflows, null, 2), 'utf-8');
}

async function waitForWorkflowStatus(
  ctx: RpcContext,
  runId: string,
  maxAttempts = 40,
): Promise<{ status: string; stepResults: Array<{ output?: string; error?: string }> }> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await dispatchWorkflowRpc('workflow.runStatus', 2, { runId }, ctx);
    const run = response.result as {
      status: string;
      stepResults: Array<{ output?: string; error?: string }>;
    } | null;
    if (run && run.status !== 'running') {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Workflow ${runId} did not finish in time`);
}

async function waitForCheckpointCleanup(dataDir: string): Promise<void> {
  const checkpointDir = join(dataDir, 'kernel-checkpoints');
  for (let attempt = 0; attempt < 40; attempt++) {
    const checkpointFiles = await readdir(checkpointDir).catch(() => []);
    if (checkpointFiles.length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Checkpoint cleanup did not finish in time');
}

describe('workflow-backend kernel integration', () => {
  it('rejects invalid workflow graphs before saving', async () => {
    const dataDir = join(process.cwd(), `.tmp-workflow-backend-test-invalid-save-${ulid()}`);
    const ctx = createRpcContext(dataDir);
    const invalid = createWorkflow({
      steps: [
        {
          id: 'first',
          type: 'agent',
          agentId: 'agent-main',
          messageTemplate: 'hello',
          condition: 'on_success',
          nextStepId: 'missing-step',
        },
      ],
    });

    expect(validateWorkflowDef(invalid)).toBe(
      "nextStepId for step 'first' targets unknown step 'missing-step'",
    );

    const response = await dispatchWorkflowRpc('workflow.save', 10, invalid, ctx);

    expect(response.error?.message).toBe(
      "nextStepId for step 'first' targets unknown step 'missing-step'",
    );
  });

  it('rejects invalid workflow publication targets before saving', async () => {
    const dataDir = join(process.cwd(), `.tmp-workflow-backend-test-publication-target-${ulid()}`);
    const ctx = createRpcContext(dataDir);

    const blankThreadKey = createWorkflow({
      id: 'wf-publication-target-blank-thread',
      publicationTargets: [{ channelId: 'chat', threadKey: '   ' }],
    });
    expect(validateWorkflowDef(blankThreadKey)).toBe(
      "workflow publication target 'chat' requires threadKey",
    );

    const duplicateTarget = createWorkflow({
      id: 'wf-publication-target-duplicate',
      publicationTargets: [
        { channelId: 'chat', threadKey: 'ops' },
        { channelId: 'chat', threadKey: 'ops', agentId: 'agent-main' },
      ],
    });
    expect(validateWorkflowDef(duplicateTarget)).toBe(
      "workflow publicationTargets contains duplicate target 'chat:ops'",
    );

    const response = await dispatchWorkflowRpc('workflow.save', 10.5, blankThreadKey, ctx);

    expect(response.error?.message).toBe("workflow publication target 'chat' requires threadKey");
  });

  it('rejects invalid workflow publication channels before saving', async () => {
    const dataDir = join(process.cwd(), `.tmp-workflow-backend-test-publication-channel-${ulid()}`);
    const ctx = createRpcContext(dataDir);

    const blankChannelId = createWorkflow({
      id: 'wf-publication-channel-blank',
      publicationChannels: ['chat', '   '],
    });
    expect(validateWorkflowDef(blankChannelId)).toBe(
      'workflow publicationChannels contains blank channelId',
    );

    const duplicateChannelId = createWorkflow({
      id: 'wf-publication-channel-duplicate',
      publicationChannels: ['chat', 'chat'],
    });
    expect(validateWorkflowDef(duplicateChannelId)).toBe(
      "workflow publicationChannels contains duplicate channelId 'chat'",
    );

    const response = await dispatchWorkflowRpc('workflow.save', 10.6, duplicateChannelId, ctx);

    expect(response.error?.message).toBe(
      "workflow publicationChannels contains duplicate channelId 'chat'",
    );
  });

  it('rejects persisted workflow cycles before execution', async () => {
    const dataDir = join(process.cwd(), `.tmp-workflow-backend-test-cycle-run-${ulid()}`);
    const workflow = createWorkflow({
      id: 'wf-cycle',
      steps: [
        {
          id: 'first',
          type: 'agent',
          agentId: 'agent-main',
          messageTemplate: 'hello {{input}}',
          condition: 'on_success',
          nextStepId: 'second',
        },
        {
          id: 'second',
          type: 'transform',
          messageTemplate: '',
          transformCode: '`second`',
          condition: 'on_success',
          nextStepId: 'first',
        },
      ],
    });
    await writeWorkflows(dataDir, [workflow]);
    const ctx = createRpcContext(dataDir);

    const response = await dispatchWorkflowRpc(
      'workflow.run',
      11,
      { workflowId: workflow.id, input: 'loop' },
      ctx,
    );

    expect(response.error?.message).toBe(
      "Invalid workflow definition: workflow graph contains a cycle at step 'first'",
    );
  });

  it('rejects workflows that contain unreachable steps', async () => {
    const dataDir = join(process.cwd(), `.tmp-workflow-backend-test-unreachable-${ulid()}`);
    const ctx = createRpcContext(dataDir);
    const invalid = createWorkflow({
      id: 'wf-unreachable',
      steps: [
        {
          id: 'first',
          type: 'agent',
          agentId: 'agent-main',
          messageTemplate: 'hello',
          condition: 'on_success',
          nextStepId: '$end',
        },
        {
          id: 'orphan',
          type: 'transform',
          messageTemplate: '',
          transformCode: '`orphan`',
          condition: 'on_success',
        },
      ],
    });

    expect(validateWorkflowDef(invalid)).toBe('workflow graph contains unreachable steps: orphan');

    const response = await dispatchWorkflowRpc('workflow.save', 12, invalid, ctx);

    expect(response.error?.message).toBe('workflow graph contains unreachable steps: orphan');
  });

  it('rejects invalid branch expressions before saving', async () => {
    const dataDir = join(process.cwd(), `.tmp-workflow-backend-test-branch-expr-${ulid()}`);
    const ctx = createRpcContext(dataDir);
    const invalid = createWorkflow({
      id: 'wf-branch-expr',
      steps: [
        {
          id: 'first',
          type: 'agent',
          agentId: 'agent-main',
          messageTemplate: 'hello',
          condition: 'on_success',
        },
        {
          id: 'branch',
          type: 'condition',
          messageTemplate: '',
          condition: 'on_success',
          branches: [{ expression: 'output.(', goto: '$end' }],
        },
      ],
    });

    expect(validateWorkflowDef(invalid)).toContain(
      "branch expression for step 'branch' is invalid:",
    );

    const response = await dispatchWorkflowRpc('workflow.save', 13, invalid, ctx);

    expect(response.error?.message).toContain("branch expression for step 'branch' is invalid:");
  });

  it('rejects invalid transform expressions before saving', async () => {
    const dataDir = join(process.cwd(), `.tmp-workflow-backend-test-transform-expr-${ulid()}`);
    const ctx = createRpcContext(dataDir);
    const invalid = createWorkflow({
      id: 'wf-transform-expr',
      steps: [
        {
          id: 'broken-transform',
          type: 'transform',
          messageTemplate: '',
          transformCode: 'input =>',
          condition: 'on_success',
        },
      ],
    });

    expect(validateWorkflowDef(invalid)).toContain(
      "transformCode for step 'broken-transform' is invalid:",
    );

    const response = await dispatchWorkflowRpc('workflow.save', 14, invalid, ctx);

    expect(response.error?.message).toContain(
      "transformCode for step 'broken-transform' is invalid:",
    );
  });

  it('rejects condition branches that can never match', async () => {
    const dataDir = join(process.cwd(), `.tmp-workflow-backend-test-branch-never-${ulid()}`);
    const ctx = createRpcContext(dataDir);
    const invalid = createWorkflow({
      id: 'wf-branch-never',
      steps: [
        {
          id: 'branch',
          type: 'condition',
          messageTemplate: '',
          condition: 'on_success',
          branches: [{ expression: 'false', goto: '$end' }],
        },
      ],
    });

    expect(validateWorkflowDef(invalid)).toBe(
      "condition step 'branch' contains branch #1 that can never match",
    );

    const response = await dispatchWorkflowRpc('workflow.save', 15, invalid, ctx);

    expect(response.error?.message).toBe(
      "condition step 'branch' contains branch #1 that can never match",
    );
  });

  it('rejects branches after an always-true condition branch', async () => {
    const dataDir = join(process.cwd(), `.tmp-workflow-backend-test-branch-always-${ulid()}`);
    const ctx = createRpcContext(dataDir);
    const invalid = createWorkflow({
      id: 'wf-branch-always',
      steps: [
        {
          id: 'branch',
          type: 'condition',
          messageTemplate: '',
          condition: 'on_success',
          branches: [
            { expression: 'true', goto: '$end' },
            { expression: "output.includes('fallback')", goto: '$end' },
          ],
        },
      ],
    });

    expect(validateWorkflowDef(invalid)).toBe(
      "condition step 'branch' contains unreachable branch #2 after an always-true branch",
    );

    const response = await dispatchWorkflowRpc('workflow.save', 16, invalid, ctx);

    expect(response.error?.message).toBe(
      "condition step 'branch' contains unreachable branch #2 after an always-true branch",
    );
  });

  it('rejects invalid output variable regex before saving', async () => {
    const dataDir = join(process.cwd(), `.tmp-workflow-backend-test-output-regex-${ulid()}`);
    const ctx = createRpcContext(dataDir);
    const invalid = createWorkflow({
      id: 'wf-output-regex',
      steps: [
        {
          id: 'first',
          type: 'agent',
          agentId: 'agent-main',
          messageTemplate: 'hello',
          condition: 'on_success',
          outputs: [{ name: 'price', regex: '(' }],
        },
      ],
    });

    expect(validateWorkflowDef(invalid)).toContain(
      "output regex 'price' for step 'first' is invalid:",
    );

    const response = await dispatchWorkflowRpc('workflow.save', 17, invalid, ctx);

    expect(response.error?.message).toContain("output regex 'price' for step 'first' is invalid:");
  });

  it('rejects invalid output variable definitions before saving', async () => {
    const dataDir = join(process.cwd(), `.tmp-workflow-backend-test-output-def-${ulid()}`);
    const ctx = createRpcContext(dataDir);

    const blankName = createWorkflow({
      id: 'wf-output-blank-name',
      steps: [
        {
          id: 'first',
          type: 'agent',
          agentId: 'agent-main',
          messageTemplate: 'hello',
          condition: 'on_success',
          outputs: [{ name: '   ', jsonPath: '$.value' }],
        },
      ],
    });
    expect(validateWorkflowDef(blankName)).toBe("output variable for step 'first' requires name");

    const duplicateNames = createWorkflow({
      id: 'wf-output-duplicate-name',
      steps: [
        {
          id: 'first',
          type: 'agent',
          agentId: 'agent-main',
          messageTemplate: 'hello',
          condition: 'on_success',
          outputs: [
            { name: 'title', jsonPath: '$.title' },
            { name: 'title', regex: '(title)' },
          ],
        },
      ],
    });
    expect(validateWorkflowDef(duplicateNames)).toBe(
      "step 'first' contains duplicate output variable 'title'",
    );

    const missingExtractor = createWorkflow({
      id: 'wf-output-missing-extractor',
      steps: [
        {
          id: 'first',
          type: 'agent',
          agentId: 'agent-main',
          messageTemplate: 'hello',
          condition: 'on_success',
          outputs: [{ name: 'title' }],
        },
      ],
    });
    expect(validateWorkflowDef(missingExtractor)).toBe(
      "output variable 'title' for step 'first' requires one extractor",
    );

    const multipleExtractors = createWorkflow({
      id: 'wf-output-multi-extractor',
      steps: [
        {
          id: 'first',
          type: 'agent',
          agentId: 'agent-main',
          messageTemplate: 'hello',
          condition: 'on_success',
          outputs: [{ name: 'title', jsonPath: '$.title', regex: '(title)' }],
        },
      ],
    });
    expect(validateWorkflowDef(multipleExtractors)).toBe(
      "output variable 'title' for step 'first' must use exactly one extractor",
    );

    const response = await dispatchWorkflowRpc('workflow.save', 18, missingExtractor, ctx);

    expect(response.error?.message).toBe(
      "output variable 'title' for step 'first' requires one extractor",
    );
  });

  it('runs workflow.run through the kernel and persists the completed run', async () => {
    const dataDir = join(process.cwd(), `.tmp-workflow-backend-test-run-${ulid()}`);
    const workflow = createWorkflow();
    await writeWorkflows(dataDir, [workflow]);
    const ctx = createRpcContext(dataDir);

    const response = await dispatchWorkflowRpc(
      'workflow.run',
      1,
      { workflowId: workflow.id, input: 'world' },
      ctx,
    );
    const runId = (response.result as { runId: string }).runId;
    const final = await waitForWorkflowStatus(ctx, runId);

    expect(final.status).toBe('done');
    expect(final.stepResults[0]?.output).toBe('reply:hello world');

    const runStatus = await dispatchWorkflowRpc('workflow.runStatus', 2, { runId }, ctx);
    expect((runStatus.result as { status: string }).status).toBe('done');

    const history = await dispatchWorkflowRpc('workflow.history', 3, {}, ctx);
    const runs = (history.result as { runs: Array<{ runId: string }> }).runs;
    expect(runs.some((run) => run.runId === runId)).toBe(true);

    await waitForCheckpointCleanup(dataDir);
  });

  it('keeps cancelled status visible before workflow finalize completes', async () => {
    const dataDir = join(process.cwd(), `.tmp-workflow-backend-test-cancel-visible-${ulid()}`);
    const workflow = createWorkflow({ id: 'wf-cancel-visible' });
    await writeWorkflows(dataDir, [workflow]);

    let releaseRunner!: () => void;
    const runnerRelease = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const ctx = createRpcContext(dataDir, createBlockingRunner(runnerRelease));

    const response = await dispatchWorkflowRpc(
      'workflow.run',
      300,
      { workflowId: workflow.id, input: 'cancel-me' },
      ctx,
    );
    const runId = (response.result as { runId: string }).runId;

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const status = await dispatchWorkflowRpc('workflow.runStatus', 301 + attempt, { runId }, ctx);
      if ((status.result as { status?: string } | null)?.status === 'running') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const cancelled = await dispatchWorkflowRpc('workflow.cancel', 350, { runId }, ctx);
    expect((cancelled.result as { cancelled: boolean }).cancelled).toBe(true);

    const immediateStatus = await dispatchWorkflowRpc('workflow.runStatus', 351, { runId }, ctx);
    expect((immediateStatus.result as { status: string }).status).toBe('cancelled');

    const immediateHistory = await dispatchWorkflowRpc('workflow.history', 352, {}, ctx);
    const immediateHistoryRun = (
      immediateHistory.result as { runs: WorkflowRunRecord[] }
    ).runs.find((run) => run.runId === runId);
    expect(immediateHistoryRun?.status).toBe('cancelled');

    releaseRunner();
    await waitForCheckpointCleanup(dataDir);

    const finalStatus = await dispatchWorkflowRpc('workflow.runStatus', 353, { runId }, ctx);
    expect((finalStatus.result as { status: string }).status).toBe('cancelled');
  });

  it('includes live running workflows in history without backend cache state', async () => {
    const dataDir = join(process.cwd(), `.tmp-workflow-backend-test-live-history-${ulid()}`);
    const workflow = createWorkflow({ id: 'wf-live-history' });
    await writeWorkflows(dataDir, [workflow]);

    let releaseRunner!: () => void;
    const runnerRelease = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const ctx = createRpcContext(dataDir, createBlockingRunner(runnerRelease));

    const response = await dispatchWorkflowRpc(
      'workflow.run',
      360,
      { workflowId: workflow.id, input: 'show-live-history' },
      ctx,
    );
    const runId = (response.result as { runId: string }).runId;

    const historyWhileRunning = await dispatchWorkflowRpc('workflow.history', 361, {}, ctx);
    const liveHistoryRun = (historyWhileRunning.result as { runs: WorkflowRunRecord[] }).runs.find(
      (run) => run.runId === runId,
    );
    expect(liveHistoryRun?.status).toBe('running');

    releaseRunner();
    const final = await waitForWorkflowStatus(ctx, runId, 120);
    expect(final.status).toBe('done');

    const historyAfterDone = await dispatchWorkflowRpc('workflow.history', 362, {}, ctx);
    const archivedHistoryRun = (historyAfterDone.result as { runs: WorkflowRunRecord[] }).runs.find(
      (run) => run.runId === runId,
    );
    expect(archivedHistoryRun?.status).toBe('done');
  });

  it('does not retain completed workflow runs in backend-only live state', async () => {
    const dataDir = join(process.cwd(), `.tmp-workflow-backend-test-no-live-cache-${ulid()}`);
    const workflow = createWorkflow({ id: 'wf-no-live-cache' });
    await writeWorkflows(dataDir, [workflow]);
    const ctx = createRpcContext(dataDir);

    for (let index = 0; index < 20; index += 1) {
      const response = await dispatchWorkflowRpc(
        'workflow.run',
        200 + index,
        { workflowId: workflow.id, input: `run-${index}` },
        ctx,
      );
      const runId = (response.result as { runId: string }).runId;
      const final = await waitForWorkflowStatus(ctx, runId, 120);
      expect(final.status).toBe('done');
    }

    const history = await dispatchWorkflowRpc('workflow.history', 363, {}, ctx);
    const runs = (history.result as { runs: WorkflowRunRecord[] }).runs;
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((run) => run.status === 'done')).toBe(true);
  });

  it('runs scheduler workflow execution through the kernel service', async () => {
    const dataDir = join(process.cwd(), `.tmp-workflow-backend-test-scheduler-${ulid()}`);
    const workflow = createWorkflow({ id: 'wf-scheduler' });
    await writeWorkflows(dataDir, [workflow]);
    const ctx = createRpcContext(dataDir);

    const result = await runWorkflowForScheduler(ctx, workflow.id, 'scheduler');

    expect(result.output).toBe('reply:hello scheduler');
    expect(result.workflowRunId).toBeTruthy();
  });
});
