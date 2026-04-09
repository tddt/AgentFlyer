import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionMetaStore } from '../core/session/meta.js';
import { SessionStore } from '../core/session/store.js';
import type { StreamChunk } from '../core/types.js';
import type { LLMProvider, RunParams } from './llm/provider.js';
import { AgentRunner } from './runner.js';
import type { RegisteredTool } from './tools/registry.js';
import { ToolRegistry } from './tools/registry.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentflyer-runner-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class RecoverableRetryProvider implements LLMProvider {
  readonly id = 'recoverable-retry';
  private attempts = 0;

  async *run(_params: RunParams): AsyncIterable<StreamChunk> {
    this.attempts += 1;
    if (this.attempts === 1) {
      yield { type: 'error', message: 'temporarily overloaded, please retry' };
      return;
    }

    yield { type: 'text_delta', text: 'retry success' };
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

  getAttemptCount(): number {
    return this.attempts;
  }
}

function createRunner(dataDir: string, provider: LLMProvider): AgentRunner {
  return new AgentRunner(
    {
      id: 'agent-main',
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
      provider,
      toolRegistry: new ToolRegistry(),
      sessionStore: new SessionStore(join(dataDir, 'sessions')),
      metaStore: new SessionMetaStore(join(dataDir, 'sessions')),
      skillsText: '',
    },
  );
}

describe('AgentRunner recoverable stream retry', () => {
  it('retries a recoverable pre-output stream error and returns only the successful output', async () => {
    const dataDir = await createTempDir();
    const provider = new RecoverableRetryProvider();
    const runner = createRunner(dataDir, provider);

    const result = await runner.runTurn('say hello');

    expect(provider.getAttemptCount()).toBe(2);
    expect(result.text).toContain('retry success');
    expect(result.text).not.toContain('任务执行失败');
  });

  it('replaces tools for a category without rebuilding the runner', async () => {
    const dataDir = await createTempDir();
    const provider = new RecoverableRetryProvider();
    const registry = new ToolRegistry();
    const runner = new AgentRunner(
      {
        id: 'agent-main',
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
        provider,
        toolRegistry: registry,
        sessionStore: new SessionStore(join(dataDir, 'sessions')),
        metaStore: new SessionMetaStore(join(dataDir, 'sessions')),
        skillsText: '',
      },
    );

    const firstTools: RegisteredTool[] = [
      {
        category: 'mcp',
        definition: {
          name: 'mcp_github_search',
          description: 'search',
          inputSchema: { type: 'object', properties: {} },
        },
        async handler() {
          return { isError: false, content: 'search-ok' };
        },
      },
    ];
    const secondTools: RegisteredTool[] = [
      {
        category: 'mcp',
        definition: {
          name: 'mcp_github_issue',
          description: 'issue',
          inputSchema: { type: 'object', properties: {} },
        },
        async handler() {
          return { isError: false, content: 'issue-ok' };
        },
      },
    ];

    runner.replaceToolsForCategory('mcp', firstTools);
    expect(runner.listTools().map((tool) => tool.name)).toEqual(['mcp_github_search']);
    await expect(registry.execute('mcp_github_search', {})).resolves.toEqual({
      isError: false,
      content: 'search-ok',
    });

    runner.replaceToolsForCategory('mcp', secondTools);
    expect(runner.listTools().map((tool) => tool.name)).toEqual(['mcp_github_issue']);
    await expect(registry.execute('mcp_github_search', {})).resolves.toEqual({
      isError: true,
      content: 'Unknown tool: mcp_github_search',
    });
    await expect(registry.execute('mcp_github_issue', {})).resolves.toEqual({
      isError: false,
      content: 'issue-ok',
    });
  });
});
