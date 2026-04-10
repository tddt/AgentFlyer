import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LLMProvider } from '../../../src/agent/llm/provider.js';
import type { RunParams } from '../../../src/agent/llm/provider.js';
import { AgentRunner } from '../../../src/agent/runner.js';
import { ToolRegistry } from '../../../src/agent/tools/registry.js';
import type { AgentConfig } from '../../../src/core/config/schema.js';
import { SessionMetaStore } from '../../../src/core/session/meta.js';
import { SessionStore } from '../../../src/core/session/store.js';
import type { StreamChunk } from '../../../src/core/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class StubProvider implements LLMProvider {
  readonly id = 'stub';
  private callCount = 0;

  supports(): boolean {
    return true;
  }

  async countTokens(): Promise<number> {
    return 0;
  }

  async *run(_params: RunParams): AsyncIterable<StreamChunk> {
    this.callCount += 1;
    if (this.callCount === 1) {
      yield {
        type: 'tool_use_delta',
        id: 'call-1',
        name: 'bash',
        inputJson: '{"command":"echo hi"}',
      };
      yield {
        type: 'done',
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'tool_use',
      };
      return;
    }

    yield { type: 'error', message: 'script execution was interrupted' };
  }
}

function createAgentConfig(): AgentConfig {
  return {
    id: 'main',
    name: 'Main',
    skills: [],
    mesh: {
      role: 'worker',
      capabilities: [],
      accepts: ['task', 'query', 'notification'],
      visibility: 'public',
      triggers: [],
    },
    owners: [],
    tools: { deny: [], approval: [] },
    persona: { language: 'zh-CN', outputDir: 'output' },
  };
}

describe('AgentRunner', () => {
  it('surfaces a final failure reply when follow-up generation errors after a tool run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-runner-'));
    tempDirs.push(dir);

    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      category: 'builtin',
      definition: { name: 'bash', description: 'bash', inputSchema: {} },
      handler: async () => ({ isError: true, content: 'script terminated by signal SIGTERM' }),
    });

    const runner = new AgentRunner(createAgentConfig(), {
      provider: new StubProvider(),
      toolRegistry,
      sessionStore: new SessionStore(dir),
      metaStore: new SessionMetaStore(dir),
    });

    const deltas: string[] = [];
    const gen = runner.turn('run the script');
    let next = await gen.next();
    while (!next.done) {
      if (next.value.type === 'text_delta') deltas.push(next.value.text);
      next = await gen.next();
    }

    expect(next.value.text).toContain('任务执行失败');
    expect(next.value.text).toContain('script execution was interrupted');
    expect(deltas.join('')).toContain('任务执行失败');
  });

  it('blocks repeated no-progress tool loops with a visible failure reply', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-loop-'));
    tempDirs.push(dir);

    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      category: 'builtin',
      definition: { name: 'loop_tool', description: 'loop', inputSchema: {} },
      handler: async () => ({ isError: false, content: 'still waiting' }),
    });

    class LoopProvider implements LLMProvider {
      readonly id = 'loop';

      supports(): boolean {
        return true;
      }

      async countTokens(): Promise<number> {
        return 0;
      }

      async *run(_params: RunParams): AsyncIterable<StreamChunk> {
        yield { type: 'tool_use_delta', id: 'loop-call', name: 'loop_tool', inputJson: '{}' };
        yield {
          type: 'done',
          inputTokens: 1,
          outputTokens: 1,
          stopReason: 'tool_use',
        };
      }
    }

    const runner = new AgentRunner(createAgentConfig(), {
      provider: new LoopProvider(),
      toolRegistry,
      sessionStore: new SessionStore(dir),
      metaStore: new SessionMetaStore(dir),
    });

    const result = await runner.runTurn('check status');

    expect(result.text).toContain('无进展循环');
    expect(result.text).toContain('loop_tool');
  });

  it('retries once when a recoverable stream error happens before any output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-retry-'));
    tempDirs.push(dir);

    class RecoverableProvider implements LLMProvider {
      readonly id = 'recoverable';
      calls = 0;

      supports(): boolean {
        return true;
      }

      async countTokens(): Promise<number> {
        return 0;
      }

      async *run(_params: RunParams): AsyncIterable<StreamChunk> {
        this.calls += 1;
        if (this.calls === 1) {
          yield { type: 'error', message: 'fetch failed: 503 Service Unavailable' };
          return;
        }
        yield { type: 'text_delta', text: 'recovered after retry' };
        yield { type: 'done', inputTokens: 2, outputTokens: 3, stopReason: 'end_turn' };
      }
    }

    const provider = new RecoverableProvider();
    const runner = new AgentRunner(createAgentConfig(), {
      provider,
      toolRegistry: new ToolRegistry(),
      sessionStore: new SessionStore(dir),
      metaStore: new SessionMetaStore(dir),
    });

    const result = await runner.runTurn('say hi');

    expect(provider.calls).toBe(2);
    expect(result.text).toContain('recovered after retry');
    expect(result.text).not.toContain('任务执行失败');
  });

  it('does not retry recoverable errors after partial text and appends a visible failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-partial-error-'));
    tempDirs.push(dir);

    class PartialFailureProvider implements LLMProvider {
      readonly id = 'partial-failure';
      calls = 0;

      supports(): boolean {
        return true;
      }

      async countTokens(): Promise<number> {
        return 0;
      }

      async *run(_params: RunParams): AsyncIterable<StreamChunk> {
        this.calls += 1;
        yield { type: 'text_delta', text: 'partial output' };
        yield { type: 'error', message: '503 upstream timeout' };
      }
    }

    const provider = new PartialFailureProvider();
    const runner = new AgentRunner(createAgentConfig(), {
      provider,
      toolRegistry: new ToolRegistry(),
      sessionStore: new SessionStore(dir),
      metaStore: new SessionMetaStore(dir),
    });

    const result = await runner.runTurn('continue');

    expect(provider.calls).toBe(1);
    expect(result.text).toContain('partial output');
    expect(result.text).toContain('任务执行失败');
    expect(result.text).toContain('AI 服务暂时不可用');
  });

  it('maps context overflow provider errors to a stable user-facing failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-overflow-'));
    tempDirs.push(dir);

    class OverflowProvider implements LLMProvider {
      readonly id = 'overflow';

      supports(): boolean {
        return true;
      }

      async countTokens(): Promise<number> {
        return 0;
      }

      async *run(_params: RunParams): AsyncIterable<StreamChunk> {
        yield { type: 'error', message: 'context length exceeded maximum tokens for this model' };
      }
    }

    const runner = new AgentRunner(createAgentConfig(), {
      provider: new OverflowProvider(),
      toolRegistry: new ToolRegistry(),
      sessionStore: new SessionStore(dir),
      metaStore: new SessionMetaStore(dir),
    });

    const result = await runner.runTurn('overflow');

    expect(result.text).toContain('任务执行失败');
    expect(result.text).toContain('上下文超限');
    expect(result.text).not.toContain('context length exceeded');
  });

  it('maps rate limit provider errors to a stable user-facing failure after retry exhaustion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-rate-limit-'));
    tempDirs.push(dir);

    class RateLimitProvider implements LLMProvider {
      readonly id = 'rate-limit';
      calls = 0;

      supports(): boolean {
        return true;
      }

      async countTokens(): Promise<number> {
        return 0;
      }

      async *run(_params: RunParams): AsyncIterable<StreamChunk> {
        this.calls += 1;
        yield { type: 'error', message: '429 rate limit exceeded for requests per min' };
      }
    }

    const provider = new RateLimitProvider();
    const runner = new AgentRunner(createAgentConfig(), {
      provider,
      toolRegistry: new ToolRegistry(),
      sessionStore: new SessionStore(dir),
      metaStore: new SessionMetaStore(dir),
    });

    const result = await runner.runTurn('retry later');

    expect(provider.calls).toBe(2);
    expect(result.text).toContain('任务执行失败');
    expect(result.text).toContain('速率限制');
    expect(result.text).not.toContain('429 rate limit exceeded');
  });

  it('persists structured error codes into session meta', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-meta-code-'));
    tempDirs.push(dir);

    const metaStore = new SessionMetaStore(dir);
    class MetaErrorProvider implements LLMProvider {
      readonly id = 'meta-error';

      supports(): boolean {
        return true;
      }

      async countTokens(): Promise<number> {
        return 0;
      }

      async *run(_params: RunParams): AsyncIterable<StreamChunk> {
        yield { type: 'error', message: '429 rate limit exceeded for requests per min' };
      }
    }

    const runner = new AgentRunner(createAgentConfig(), {
      provider: new MetaErrorProvider(),
      toolRegistry: new ToolRegistry(),
      sessionStore: new SessionStore(dir),
      metaStore,
    });

    await runner.runTurn('persist meta error code');
    const meta = await metaStore.get(runner.currentSessionKey);

    expect(meta?.status).toBe('suspended');
    expect(meta?.errorCode).toBe('rate_limit');
    expect(meta?.error).toContain('速率限制');
  });

  it('surfaces a failure when the tool round cap is exhausted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-tool-cap-'));
    tempDirs.push(dir);

    let toolExecutions = 0;
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      category: 'builtin',
      definition: { name: 'progress_tool', description: 'progress', inputSchema: {} },
      handler: async () => {
        toolExecutions += 1;
        return { isError: false, content: `step ${toolExecutions}` };
      },
    });

    class EndlessToolProvider implements LLMProvider {
      readonly id = 'endless-tool';

      supports(): boolean {
        return true;
      }

      async countTokens(): Promise<number> {
        return 0;
      }

      async *run(_params: RunParams): AsyncIterable<StreamChunk> {
        yield {
          type: 'tool_use_delta',
          id: `call-${toolExecutions + 1}`,
          name: 'progress_tool',
          inputJson: '{}',
        };
        yield { type: 'done', inputTokens: 1, outputTokens: 1, stopReason: 'tool_use' };
      }
    }

    const runner = new AgentRunner(
      {
        ...createAgentConfig(),
        tools: { ...createAgentConfig().tools, maxRounds: 20 },
      },
      {
        provider: new EndlessToolProvider(),
        toolRegistry,
        sessionStore: new SessionStore(dir),
        metaStore: new SessionMetaStore(dir),
      },
    );

    const result = await runner.runTurn('keep going');

    expect(toolExecutions).toBe(20);
    expect(result.text).toContain('任务执行失败');
    expect(result.text).toContain('工具调用轮次已达到上限');
    expect(result.text).not.toContain('任务执行完毕');
  });
});
