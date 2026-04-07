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

function createRpcContext(dataDir: string): RpcContext {
  return {
    runners: new Map([['agent-main', createRunner()]]),
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
): Promise<{ status: string; stepResults: Array<{ output?: string; error?: string }> }> {
  for (let attempt = 0; attempt < 40; attempt++) {
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

    const response = await dispatchWorkflowRpc('workflow.save', 15, invalid, ctx);

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

    const response = await dispatchWorkflowRpc('workflow.save', 16, missingExtractor, ctx);

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

    const history = await dispatchWorkflowRpc('workflow.history', 3, {}, ctx);
    const runs = (history.result as { runs: Array<{ runId: string }> }).runs;
    expect(runs.some((run) => run.runId === runId)).toBe(true);

    await waitForCheckpointCleanup(dataDir);
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
