import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionMetaStore } from '../core/session/meta.js';
import { SessionStore } from '../core/session/store.js';
import type { StreamChunk } from '../core/types.js';
import { executeAgentTurnViaKernel } from './kernel-turn-executor.js';
import type { LLMProvider, RunParams } from './llm/provider.js';
import { AgentRunner } from './runner.js';
import { ToolRegistry } from './tools/registry.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentflyer-kernel-turn-executor-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeProvider implements LLMProvider {
  constructor(private readonly responseText: string) {}

  readonly id = 'fake';

  async *run(_params: RunParams): AsyncIterable<StreamChunk> {
    yield { type: 'text_delta', text: this.responseText };
    yield {
      type: 'done',
      inputTokens: 1,
      outputTokens: 2,
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

class HangingProvider implements LLMProvider {
  readonly id = 'hanging';

  async *run(_params: RunParams): AsyncIterable<StreamChunk> {
    await new Promise<never>(() => undefined);
  }

  async countTokens(): Promise<number> {
    return 0;
  }

  supports(): boolean {
    return true;
  }
}

function createRunner(dataDir: string, agentId = 'agent-main', provider?: LLMProvider): AgentRunner {
  return new AgentRunner(
    {
      id: agentId,
      name: agentId === 'agent-main' ? 'Agent Main' : 'Agent Alt',
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
      provider: provider ?? new FakeProvider(`hello from ${agentId}`),
      toolRegistry: new ToolRegistry(),
      sessionStore: new SessionStore(join(dataDir, 'sessions')),
      metaStore: new SessionMetaStore(join(dataDir, 'sessions')),
      skillsText: '',
    },
  );
}

describe('executeAgentTurnViaKernel', () => {
  it('runs a single agent turn through the kernel helper', async () => {
    const dataDir = await createTempDir();
    const runner = createRunner(dataDir);

    const result = await executeAgentTurnViaKernel({
      runners: new Map([['agent-main', runner]]),
      dataDir,
      input: {
        agentId: 'agent-main',
        userMessage: 'hello',
        threadKey: 'executor-thread',
      },
    });

    expect(result.text).toContain('hello from agent-main');
    expect(result.sessionKey).toContain('executor-thread');
  });

  it('reuses one shared executor per dataDir across multiple agents', async () => {
    const dataDir = await createTempDir();
    const mainRunner = createRunner(dataDir, 'agent-main');
    const altRunner = createRunner(dataDir, 'agent-alt');
    const runners = new Map([
      ['agent-main', mainRunner],
      ['agent-alt', altRunner],
    ]);

    const [mainResult, altResult] = await Promise.all([
      executeAgentTurnViaKernel({
        runners,
        dataDir,
        input: {
          agentId: 'agent-main',
          userMessage: 'hello main',
          threadKey: 'executor-main',
        },
      }),
      executeAgentTurnViaKernel({
        runners,
        dataDir,
        input: {
          agentId: 'agent-alt',
          userMessage: 'hello alt',
          threadKey: 'executor-alt',
        },
      }),
    ]);

    expect(mainResult.text).toContain('hello from agent-main');
    expect(mainResult.sessionKey).toContain('executor-main');
    expect(altResult.text).toContain('hello from agent-alt');
    expect(altResult.sessionKey).toContain('executor-alt');
  });

  it('keeps concurrent narrow runner maps isolated per agent', async () => {
    const dataDir = await createTempDir();
    const mainRunner = createRunner(dataDir, 'agent-main');
    const altRunner = createRunner(dataDir, 'agent-alt');

    const [mainResult, altResult] = await Promise.all([
      executeAgentTurnViaKernel({
        runners: new Map([['agent-main', mainRunner]]),
        dataDir,
        input: {
          agentId: 'agent-main',
          userMessage: 'hello main narrow',
          threadKey: 'executor-main-narrow',
        },
      }),
      executeAgentTurnViaKernel({
        runners: new Map([['agent-alt', altRunner]]),
        dataDir,
        input: {
          agentId: 'agent-alt',
          userMessage: 'hello alt narrow',
          threadKey: 'executor-alt-narrow',
        },
      }),
    ]);

    expect(mainResult.text).toContain('hello from agent-main');
    expect(mainResult.sessionKey).toContain('executor-main-narrow');
    expect(altResult.text).toContain('hello from agent-alt');
    expect(altResult.sessionKey).toContain('executor-alt-narrow');
  });

  it('aborts timed out kernel turns and releases the runner lease', async () => {
    const dataDir = await createTempDir();
    const runner = createRunner(dataDir, 'agent-main', new HangingProvider());

    await expect(
      executeAgentTurnViaKernel({
        runners: new Map([['agent-main', runner]]),
        dataDir,
        timeoutMs: 20,
        input: {
          agentId: 'agent-main',
          userMessage: 'hang forever',
          threadKey: 'executor-timeout',
        },
      }),
    ).rejects.toThrow("Agent 'agent-main' turn timed out after 20ms");

    expect(runner.isRunning).toBe(false);
  });
});
