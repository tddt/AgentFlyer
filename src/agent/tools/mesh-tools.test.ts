import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionMetaStore } from '../../core/session/meta.js';
import { SessionStore } from '../../core/session/store.js';
import type { StreamChunk } from '../../core/types.js';
import type { LLMProvider, RunParams } from '../llm/provider.js';
import { AgentRunner } from '../runner.js';
import { createMeshTools } from './mesh-tools.js';
import { ToolRegistry } from './registry.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentflyer-mesh-tools-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeProvider implements LLMProvider {
  readonly id = 'fake';

  async *run(_params: RunParams): AsyncIterable<StreamChunk> {
    yield { type: 'text_delta', text: 'mesh task finished' };
    yield {
      type: 'done',
      inputTokens: 1,
      outputTokens: 1,
      stopReason: 'end_turn',
    };
  }

  async countTokens(): Promise<number> {
    return 0;
  }

  supports(): boolean {
    return true;
  }
}

function createRunner(dataDir: string, agentId = 'agent-main'): AgentRunner {
  return new AgentRunner(
    {
      id: agentId,
      name: 'Agent Main',
      mentionAliases: [],
      workspace: dataDir,
      skills: [],
      model: 'fake-model',
      mesh: {
        role: 'worker',
        capabilities: [],
        accepts: ['task', 'query', 'notification'],
        visibility: 'public',
        triggers: [],
      },
      owners: [],
      tools: { allow: [], deny: [], approval: [], maxRounds: 4 },
      persona: { language: 'zh-CN', outputDir: 'output' },
    },
    {
      provider: new FakeProvider(),
      toolRegistry: new ToolRegistry(),
      sessionStore: new SessionStore(join(dataDir, 'sessions')),
      metaStore: new SessionMetaStore(join(dataDir, 'sessions')),
      skillsText: '',
    },
  );
}

function getToolHandler(name: string, dataDir: string, runners?: Map<string, AgentRunner>) {
  const tools = createMeshTools(
    runners ?? new Map([['agent-main', createRunner(dataDir)]]),
    dataDir,
  );
  const tool = tools.find((entry) => entry.definition.name === name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }
  return tool.handler;
}

describe('createMeshTools persistence', () => {
  it('persists spawned tasks to mesh-tasks.json', async () => {
    const dataDir = await createTempDir();
    const spawn = getToolHandler('mesh_spawn', dataDir);
    const status = getToolHandler('mesh_status', dataDir);

    const spawned = await spawn({ agent_id: 'agent-main', message: 'do work' });
    expect(spawned.isError).toBe(false);
    const taskId = /ID: (.+)/u.exec(spawned.content)?.[1];
    expect(taskId).toBeTruthy();

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const current = await status({ task_id: taskId });
      if (current.content.includes('Status: done')) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const raw = await readFile(join(dataDir, 'mesh-tasks.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Array<{ taskId: string; status: string; result?: string }>;
    expect(parsed.some((entry) => entry.taskId === taskId && entry.status === 'done')).toBe(true);
    expect(parsed.find((entry) => entry.taskId === taskId)?.result).toContain('mesh task finished');
  });

  it('marks unfinished persisted tasks as interrupted on startup', async () => {
    const dataDir = await createTempDir();
    await writeFile(
      join(dataDir, 'mesh-tasks.json'),
      JSON.stringify(
        [
          {
            taskId: 'task-restart',
            agentId: 'agent-main',
            message: 'resume me',
            threadKey: 'mesh-spawn-task-restart',
            status: 'running',
            startedAt: Date.now() - 5000,
            timeoutMs: 10000,
          },
        ],
        null,
        2,
      ),
      'utf-8',
    );

    const status = getToolHandler('mesh_status', dataDir);
    const result = await status({ task_id: 'task-restart' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Task interrupted by gateway restart before completion.');

    const raw = await readFile(join(dataDir, 'mesh-tasks.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Array<{
      taskId: string;
      status: string;
      error?: string;
      doneAt?: number;
    }>;
    const entry = parsed.find((item) => item.taskId === 'task-restart');
    expect(entry?.status).toBe('error');
    expect(entry?.error).toContain('gateway restart');
    expect(typeof entry?.doneAt).toBe('number');
  });
});

describe('mesh_send end-to-end routing', () => {
  it('routes a task to a worker agent and returns the worker response', async () => {
    const dataDir = await createTempDir();
    const runners = new Map([
      ['coordinator', createRunner(dataDir, 'coordinator')],
      ['worker-1', createRunner(dataDir, 'worker-1')],
    ]);
    const send = getToolHandler('mesh_send', dataDir, runners);

    const result = await send({ agent_id: 'worker-1', message: 'compute something' });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('mesh task finished');
  });

  it('returns error immediately when target agent is not found', async () => {
    const dataDir = await createTempDir();
    const runners = new Map<string, import('../runner.js').AgentRunner>();
    const send = getToolHandler('mesh_send', dataDir, runners);

    const result = await send({ agent_id: 'nonexistent', message: 'hello' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('nonexistent');
  });

  it('returns error immediately when target agent is busy', async () => {
    const dataDir = await createTempDir();

    class HangingProvider implements LLMProvider {
      readonly id = 'hanging';
      supports(): boolean { return true; }
      async countTokens(): Promise<number> { return 0; }
      async *run(_params: RunParams): AsyncIterable<StreamChunk> {
        await new Promise(() => undefined);
        yield { type: 'done', inputTokens: 0, outputTokens: 0, stopReason: 'end_turn' };
      }
    }

    const busyRunner = new AgentRunner(
      {
        id: 'busy-agent', name: 'Busy', skills: [],
        mesh: { role: 'worker', capabilities: [], accepts: ['task'], visibility: 'public', triggers: [] },
        owners: [], tools: { deny: [], approval: [] },
        persona: { language: 'zh-CN', outputDir: 'output' },
      },
      {
        provider: new HangingProvider(),
        toolRegistry: new ToolRegistry(),
        sessionStore: new SessionStore(join(dataDir, 'sessions')),
        metaStore: new SessionMetaStore(join(dataDir, 'sessions')),
        skillsText: '',
      },
    );

    // Start a turn without awaiting — runner becomes busy
    void busyRunner.runTurn('busy work');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const runners = new Map([['busy-agent', busyRunner]]);
    const send = getToolHandler('mesh_send', dataDir, runners);

    const result = await send({ agent_id: 'busy-agent', message: 'hello' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('busy');

    busyRunner.forceReset();
  });
});

describe('mesh_plan parallel orchestration', () => {
  it('dispatches sub-tasks to multiple agents in parallel and reports outcomes', async () => {
    const dataDir = await createTempDir();
    const runners = new Map([
      ['agent-a', createRunner(dataDir, 'agent-a')],
      ['agent-b', createRunner(dataDir, 'agent-b')],
    ]);
    const plan = getToolHandler('mesh_plan', dataDir, runners);

    const result = await plan({
      goal: 'gather information',
      tasks: [
        { agent_id: 'agent-a', instruction: 'do task A' },
        { agent_id: 'agent-b', instruction: 'do task B' },
      ],
      parallel: true,
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('agent-a');
    expect(result.content).toContain('agent-b');
    expect(result.content).toContain('mesh task finished');
  });

  it('returns error when tasks array is empty', async () => {
    const dataDir = await createTempDir();
    const plan = getToolHandler('mesh_plan', dataDir);

    const result = await plan({ goal: 'empty', tasks: [] });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('at least one task');
  });
});
