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
});
