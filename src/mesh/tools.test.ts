import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LLMProvider, RunParams } from '../agent/llm/provider.js';
import { AgentRunner } from '../agent/runner.js';
import { ToolRegistry } from '../agent/tools/registry.js';
import { SessionMetaStore } from '../core/session/meta.js';
import { SessionStore } from '../core/session/store.js';
import type { StreamChunk } from '../core/types.js';
import { asAgentId } from '../core/types.js';
import { MeshBus } from './bus.js';
import { MeshTaskDispatcher } from './tools.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentflyer-mesh-dispatcher-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeProvider implements LLMProvider {
  readonly id = 'fake';

  async *run(_params: RunParams): AsyncIterable<StreamChunk> {
    yield { type: 'text_delta', text: 'mesh dispatcher finished' };
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

async function waitForTaskStatus(
  dispatcher: MeshTaskDispatcher,
  taskId: string,
  status: 'done' | 'error',
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = dispatcher.getTask(taskId as never);
    if (task?.status === status) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Task ${taskId} did not reach status ${status}`);
}

describe('MeshTaskDispatcher persistence', () => {
  it('persists completed tasks to mesh-dispatcher-tasks.json', async () => {
    const dataDir = await createTempDir();
    const dispatcher = new MeshTaskDispatcher(new MeshBus(), { dataDir });
    dispatcher.registerRunner(asAgentId('agent-main'), createRunner(dataDir));

    const taskId = await dispatcher.spawn(asAgentId('agent-main'), 'finish this task');
    await waitForTaskStatus(dispatcher, taskId, 'done');

    const raw = await readFile(join(dataDir, 'mesh-dispatcher-tasks.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Array<{ taskId: string; status: string; output?: string }>;
    const entry = parsed.find((item) => item.taskId === taskId);
    expect(entry?.status).toBe('done');
    expect(entry?.output).toContain('mesh dispatcher finished');
  });

  it('marks unfinished persisted tasks as interrupted on startup', async () => {
    const dataDir = await createTempDir();
    await writeFile(
      join(dataDir, 'mesh-dispatcher-tasks.json'),
      JSON.stringify(
        [
          {
            taskId: 'task-restart',
            agentId: 'agent-main',
            instruction: 'resume me',
            status: 'running',
            createdAt: Date.now() - 5000,
            updatedAt: Date.now() - 1000,
          },
        ],
        null,
        2,
      ),
      'utf-8',
    );

    const dispatcher = new MeshTaskDispatcher(new MeshBus(), { dataDir });
    const restored = dispatcher.getTask('task-restart' as never);

    expect(restored?.status).toBe('error');
    expect(restored?.error).toContain('gateway restart');

    const raw = await readFile(join(dataDir, 'mesh-dispatcher-tasks.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Array<{ taskId: string; status: string; error?: string }>;
    const entry = parsed.find((item) => item.taskId === 'task-restart');
    expect(entry?.status).toBe('error');
    expect(entry?.error).toContain('gateway restart');
  });
});
