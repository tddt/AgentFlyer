import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunner } from '../agent/runner.js';
import type { WorkflowDef, WorkflowRunRecord } from './workflow-backend.js';
import { WorkflowKernelService } from './workflow-kernel.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentflyer-workflow-kernel-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createWorkflow(): WorkflowDef {
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
  } as unknown as AgentRunner;
}

function createHungRunner(): AgentRunner {
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
    async continueKernelTurn() {
      return await new Promise<never>(() => undefined);
    },
  } as unknown as AgentRunner;
}

function createQueuedRunner(): { runner: AgentRunner; release: () => void } {
  let threadKey = 'default';
  let activeRunId: string | null = null;
  let releaseCurrent!: () => void;
  let currentGate = Promise.resolve();

  const runner = {
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
        activeKernelRunId: activeRunId,
      };
    },
    restoreState(state: { threadKey: string; activeKernelRunId?: string | null }) {
      threadKey = state.threadKey;
      activeRunId = state.activeKernelRunId ?? null;
    },
    get currentSessionKey() {
      return `agent:agent-main:${threadKey}`;
    },
    get isRunning() {
      return activeRunId !== null;
    },
    forceReset() {
      activeRunId = null;
      currentGate = Promise.resolve();
    },
    async beginKernelTurn(runId: string, message: string) {
      if (activeRunId) {
        throw new Error("Agent 'agent-main' is already processing a turn");
      }
      activeRunId = runId;
      currentGate = new Promise<void>((resolve) => {
        releaseCurrent = resolve;
      });
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
    }) {
      await currentGate;
      activeRunId = null;
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

  return {
    runner,
    release: () => releaseCurrent(),
  };
}

function workflowRunsFile(dataDir: string): string {
  return join(dataDir, 'workflow-runs.json');
}

async function readPersistedRuns(dataDir: string): Promise<WorkflowRunRecord[]> {
  try {
    return JSON.parse(await readFile(workflowRunsFile(dataDir), 'utf-8')) as WorkflowRunRecord[];
  } catch {
    return [];
  }
}

async function persistRun(dataDir: string, run: WorkflowRunRecord): Promise<void> {
  const existing = await readPersistedRuns(dataDir);
  const filtered = existing.filter((entry) => entry.runId !== run.runId);
  await writeFile(workflowRunsFile(dataDir), JSON.stringify([run, ...filtered], null, 2), 'utf-8');
}

describe('WorkflowKernelService archived completion', () => {
  it('uses a per-run runner snapshot even if live runners are reloaded mid-run', async () => {
    const dataDir = await createTempDir();
    const workflow = createWorkflow();
    const sharedRunners = new Map([['agent-main', createRunner()]]);
    const callbacks = {
      async onRunComplete(_workflow: WorkflowDef, run: WorkflowRunRecord) {
        await persistRun(dataDir, run);
      },
      async findArchivedRun(runId: string) {
        const runs = await readPersistedRuns(dataDir);
        return runs.find((run) => run.runId === runId) ?? null;
      },
    };

    const service = new WorkflowKernelService({
      dataDir,
      runners: sharedRunners,
      callbacks,
    });
    await service.initialize();

    const started = await service.startWorkflow(workflow, 'world');
    sharedRunners.delete('agent-main');

    const completed = await service.waitForCompletion(started.runId);
    expect(completed.status).toBe('done');
    expect(completed.stepResults[0]?.output).toBe('reply:hello world');
  });

  it('resolves archived completion outcomes after service restart', async () => {
    const dataDir = await createTempDir();
    const workflow = createWorkflow();
    const callbacks = {
      async onRunComplete(_workflow: WorkflowDef, run: WorkflowRunRecord) {
        await persistRun(dataDir, run);
      },
      async findArchivedRun(runId: string) {
        const runs = await readPersistedRuns(dataDir);
        return runs.find((run) => run.runId === runId) ?? null;
      },
    };

    const firstService = new WorkflowKernelService({
      dataDir,
      runners: new Map([['agent-main', createRunner()]]),
      callbacks,
    });
    await firstService.initialize();

    const started = await firstService.startWorkflow(workflow, 'world');
    const completed = await firstService.waitForCompletion(started.runId);
    expect(completed.status).toBe('done');
    expect(completed.stepResults[0]?.output).toBe('reply:hello world');

    const restartedService = new WorkflowKernelService({
      dataDir,
      runners: new Map([['agent-main', createRunner()]]),
      callbacks,
    });
    await restartedService.initialize();

    const restored = await restartedService.waitForCompletion(started.runId);
    expect(restored.status).toBe('done');
    expect(restored.stepResults[0]?.output).toBe('reply:hello world');
  });

  it('fails the workflow step when the delegated agent turn exceeds the timeout budget', async () => {
    const dataDir = await createTempDir();
    const workflow = createWorkflow();
    const callbacks = {
      async onRunComplete(_workflow: WorkflowDef, run: WorkflowRunRecord) {
        await persistRun(dataDir, run);
      },
      async findArchivedRun(runId: string) {
        const runs = await readPersistedRuns(dataDir);
        return runs.find((run) => run.runId === runId) ?? null;
      },
    };

    const service = new WorkflowKernelService({
      dataDir,
      runners: new Map([['agent-main', createHungRunner()]]),
      callbacks,
      workflowAgentStepTimeoutMs: 20,
    });
    await service.initialize();

    const started = await service.startWorkflow(workflow, 'world');
    const completed = await service.waitForCompletion(started.runId);

    expect(completed.status).toBe('error');
    expect(completed.stepResults[0]?.error).toContain(
      "Agent 'agent-main' turn timed out after 20ms",
    );
  });

  it('serializes concurrent workflow turns for the same agent instead of failing busy', async () => {
    const dataDir = await createTempDir();
    const workflow = createWorkflow();
    const queued = createQueuedRunner();
    const callbacks = {
      async onRunComplete(_workflow: WorkflowDef, run: WorkflowRunRecord) {
        await persistRun(dataDir, run);
      },
      async findArchivedRun(runId: string) {
        const runs = await readPersistedRuns(dataDir);
        return runs.find((run) => run.runId === runId) ?? null;
      },
    };

    const service = new WorkflowKernelService({
      dataDir,
      runners: new Map([['agent-main', queued.runner]]),
      callbacks,
      workflowAgentStepTimeoutMs: 5_000,
    });
    await service.initialize();

    const firstStarted = await service.startWorkflow(workflow, 'first');
    const secondStarted = await service.startWorkflow(workflow, 'second');

    const firstCompletion = service.waitForCompletion(firstStarted.runId);
    const secondCompletion = service.waitForCompletion(secondStarted.runId);

    await new Promise((resolve) => setTimeout(resolve, 30));
    queued.release();
    await firstCompletion;

    await new Promise((resolve) => setTimeout(resolve, 30));
    queued.release();
    const secondCompleted = await secondCompletion;

    expect(secondCompleted.status).toBe('done');
    expect(secondCompleted.stepResults[0]?.output).toBe('reply:hello second');
  });
});
