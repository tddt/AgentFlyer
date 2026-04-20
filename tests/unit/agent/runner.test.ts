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

  // ── Happy-path & utility tests ─────────────────────────────────────────────

  it('returns text output on a simple text-only turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-text-turn-'));
    tempDirs.push(dir);

    class TextProvider implements LLMProvider {
      readonly id = 'text';
      supports(): boolean { return true; }
      async countTokens(): Promise<number> { return 0; }
      async *run(_params: RunParams): AsyncIterable<StreamChunk> {
        yield { type: 'text_delta', text: 'Hello, ' };
        yield { type: 'text_delta', text: 'world!' };
        yield { type: 'done', inputTokens: 5, outputTokens: 10, stopReason: 'end_turn' };
      }
    }

    const runner = new AgentRunner(createAgentConfig(), {
      provider: new TextProvider(),
      toolRegistry: new ToolRegistry(),
      sessionStore: new SessionStore(dir),
      metaStore: new SessionMetaStore(dir),
    });

    const result = await runner.runTurn('say hi');

    expect(result.text).toBe('Hello, world!');
    expect(result.inputTokens).toBe(5);
    expect(result.outputTokens).toBe(10);
    expect(result.text).not.toContain('任务执行失败');
  });

  it('streams text chunks via turn() generator on a simple turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-gen-'));
    tempDirs.push(dir);

    class SimpleProvider implements LLMProvider {
      readonly id = 'simple';
      supports(): boolean { return true; }
      async countTokens(): Promise<number> { return 0; }
      async *run(_params: RunParams): AsyncIterable<StreamChunk> {
        yield { type: 'text_delta', text: 'chunk1' };
        yield { type: 'text_delta', text: 'chunk2' };
        yield { type: 'done', inputTokens: 2, outputTokens: 4, stopReason: 'end_turn' };
      }
    }

    const runner = new AgentRunner(createAgentConfig(), {
      provider: new SimpleProvider(),
      toolRegistry: new ToolRegistry(),
      sessionStore: new SessionStore(dir),
      metaStore: new SessionMetaStore(dir),
    });

    const deltas: string[] = [];
    const gen = runner.turn('go');
    let next = await gen.next();
    while (!next.done) {
      if (next.value.type === 'text_delta') deltas.push(next.value.text);
      next = await gen.next();
    }

    expect(deltas).toEqual(['chunk1', 'chunk2']);
    expect(next.value.text).toBe('chunk1chunk2');
  });

  it('setThread() isolates turns into a new session key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-thread-'));
    tempDirs.push(dir);

    class EchoProvider implements LLMProvider {
      readonly id = 'echo';
      supports(): boolean { return true; }
      async countTokens(): Promise<number> { return 0; }
      async *run(_params: RunParams): AsyncIterable<StreamChunk> {
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'done', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' };
      }
    }

    const sessionStore = new SessionStore(dir);
    const runner = new AgentRunner(createAgentConfig(), {
      provider: new EchoProvider(),
      toolRegistry: new ToolRegistry(),
      sessionStore,
      metaStore: new SessionMetaStore(dir),
    });

    const keyBefore = runner.currentSessionKey;
    await runner.runTurn('thread 1 message');

    runner.setThread('thread-b');
    const keyAfter = runner.currentSessionKey;
    expect(keyAfter).not.toBe(keyBefore);

    await runner.runTurn('thread 2 message');

    // Each session file exists separately
    const historyThread1 = await sessionStore.readAll(keyBefore);
    const historyThread2 = await sessionStore.readAll(keyAfter);
    expect(historyThread1.length).toBeGreaterThan(0);
    expect(historyThread2.length).toBeGreaterThan(0);
    // Making sure they don't overlap
    expect(historyThread1.length).not.toBe(historyThread2.length + 100); // different sessions
  });

  it('serializeState() / restoreState() preserve thread and cache context', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-serialize-'));
    tempDirs.push(dir);

    class QuickProvider implements LLMProvider {
      readonly id = 'quick';
      supports(): boolean { return true; }
      async countTokens(): Promise<number> { return 0; }
      async *run(_params: RunParams): AsyncIterable<StreamChunk> {
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' };
      }
    }

    const runner = new AgentRunner(createAgentConfig(), {
      provider: new QuickProvider(),
      toolRegistry: new ToolRegistry(),
      sessionStore: new SessionStore(dir),
      metaStore: new SessionMetaStore(dir),
    });

    runner.setThread('custom-thread');
    await runner.runTurn('first');

    const state = runner.serializeState();
    expect(state.threadKey).toBe('custom-thread');

    // Restore into a fresh runner
    const runner2 = new AgentRunner(createAgentConfig(), {
      provider: new QuickProvider(),
      toolRegistry: new ToolRegistry(),
      sessionStore: new SessionStore(dir),
      metaStore: new SessionMetaStore(dir),
    });
    runner2.restoreState(state);

    expect(runner2.currentSessionKey).toBe(runner.currentSessionKey);
    expect(runner2.isRunning).toBe(false);
  });
});

describe('AgentRunner kernel API', () => {
  class KernelProvider implements LLMProvider {
    readonly id = 'kernel';
    supports(): boolean { return true; }
    async countTokens(): Promise<number> { return 0; }
    async *run(_params: RunParams): AsyncIterable<StreamChunk> {
      yield { type: 'done', inputTokens: 0, outputTokens: 0, stopReason: 'end_turn' };
    }
  }

  function makeKernelRunner(dir: string): AgentRunner {
    return new AgentRunner(createAgentConfig(), {
      provider: new KernelProvider(),
      toolRegistry: new ToolRegistry(),
      sessionStore: new SessionStore(dir),
      metaStore: new SessionMetaStore(dir),
    });
  }

  it('beginKernelTurn returns state with runId and user message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-kernel-'));
    tempDirs.push(dir);
    const runner = makeKernelRunner(dir);

    const state = await runner.beginKernelTurn('run-1', 'hello kernel');

    expect(state.runId).toBe('run-1');
    expect(state.userMessage).toBe('hello kernel');
    expect(state.messages.at(-1)).toMatchObject({ role: 'user', content: 'hello kernel' });
    expect(runner.isRunning).toBe(true);
  });

  it('beginKernelTurn throws when agent is already running', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-kernel-busy-'));
    tempDirs.push(dir);
    const runner = makeKernelRunner(dir);

    await runner.beginKernelTurn('run-A', 'first');

    await expect(runner.beginKernelTurn('run-B', 'second')).rejects.toThrow(
      "Agent 'main' is already processing a turn",
    );
  });

  it('continueKernelTurn returns llm.generate syscall with done:false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-kernel-continue-'));
    tempDirs.push(dir);
    const runner = makeKernelRunner(dir);

    const state = await runner.beginKernelTurn('run-2', 'continue me');
    const result = await runner.continueKernelTurn(state);

    expect(result.done).toBe(false);
    expect(result.syscall?.kind).toBe('llm.generate');
    expect(result.state.runId).toBe('run-2');
  });

  it('continueKernelTurn throws on runId lease mismatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-kernel-mismatch-'));
    tempDirs.push(dir);
    const runner = makeKernelRunner(dir);

    await runner.beginKernelTurn('run-3', 'mismatch test');

    const wrongState = { runId: 'run-WRONG', messages: [], model: 'x', maxTokens: 100,
      systemPrompt: '', userMessage: '', options: {}, totalInputTokens: 0,
      totalOutputTokens: 0, totalCacheReadTokens: 0, totalText: '',
      toolRounds: 0, toolFailureMessages: [], finalFailureMessage: null,
      finalFailureCode: undefined, recoverableStreamRetries: 0,
      toolLoopDetector: { lastEntry: null, consecutiveRepeats: 0 },
      pendingToolCalls: undefined };

    await expect(runner.continueKernelTurn(wrongState)).rejects.toThrow(
      "kernel lease mismatch for run 'run-WRONG'",
    );
  });

  it('continueKernelTurn throws when pending tool calls are present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-kernel-pending-'));
    tempDirs.push(dir);
    const runner = makeKernelRunner(dir);

    const state = await runner.beginKernelTurn('run-4', 'pending test');
    const stateWithCalls = {
      ...state,
      pendingToolCalls: [{ id: 'tc-1', name: 'bash', inputJson: '{}' }],
    };

    await expect(runner.continueKernelTurn(stateWithCalls)).rejects.toThrow(
      "waiting for tool syscall resolution for run 'run-4'",
    );
  });

  it('resumeKernelTurn returns llm.generate when no pending tool calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-kernel-resume-'));
    tempDirs.push(dir);
    const runner = makeKernelRunner(dir);

    const state = await runner.beginKernelTurn('run-5', 'resume test');
    const result = await runner.resumeKernelTurn(state);

    expect(result.done).toBe(false);
    expect(result.syscall?.kind).toBe('llm.generate');
  });

  it('resumeKernelTurn returns tool.call syscall when pending tool calls present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-kernel-toolcall-'));
    tempDirs.push(dir);
    const runner = makeKernelRunner(dir);

    const state = await runner.beginKernelTurn('run-6', 'tool call test');
    const stateWithCalls = {
      ...state,
      pendingToolCalls: [{ id: 'tc-2', name: 'bash', inputJson: '{"command":"ls"}' }],
    };

    const result = await runner.resumeKernelTurn(stateWithCalls);

    expect(result.done).toBe(false);
    expect(result.syscall?.kind).toBe('tool.call');
  });

  it('resumeKernelTurn throws on runId lease mismatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-kernel-resume-mismatch-'));
    tempDirs.push(dir);
    const runner = makeKernelRunner(dir);

    await runner.beginKernelTurn('run-7', 'resume mismatch');

    const wrongState = { runId: 'run-WRONG', messages: [], model: 'x', maxTokens: 100,
      systemPrompt: '', userMessage: '', options: {}, totalInputTokens: 0,
      totalOutputTokens: 0, totalCacheReadTokens: 0, totalText: '',
      toolRounds: 0, toolFailureMessages: [], finalFailureMessage: null,
      finalFailureCode: undefined, recoverableStreamRetries: 0,
      toolLoopDetector: { lastEntry: null, consecutiveRepeats: 0 },
      pendingToolCalls: undefined };

    await expect(runner.resumeKernelTurn(wrongState)).rejects.toThrow(
      "kernel lease mismatch for run 'run-WRONG'",
    );
  });
});

describe('AgentRunner utilities', () => {
  it('listTools() returns all registered tool names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-listtools-'));
    tempDirs.push(dir);

    class DummyProvider implements LLMProvider {
      readonly id = 'dummy';
      supports(): boolean { return true; }
      async countTokens(): Promise<number> { return 0; }
      async *run(_params: RunParams): AsyncIterable<StreamChunk> {
        yield { type: 'done', inputTokens: 0, outputTokens: 0, stopReason: 'end_turn' };
      }
    }

    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      category: 'builtin',
      definition: { name: 'tool_alpha', description: 'alpha', inputSchema: {} },
      handler: async () => ({ isError: false, content: 'a' }),
    });
    toolRegistry.register({
      category: 'builtin',
      definition: { name: 'tool_beta', description: 'beta', inputSchema: {} },
      handler: async () => ({ isError: false, content: 'b' }),
    });

    const runner = new AgentRunner(createAgentConfig(), {
      provider: new DummyProvider(),
      toolRegistry,
      sessionStore: new SessionStore(dir),
      metaStore: new SessionMetaStore(dir),
    });

    const tools = runner.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('tool_alpha');
    expect(names).toContain('tool_beta');
  });

  it('isRunning is false before any turn and after completion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-isrunning-'));
    tempDirs.push(dir);

    class FastProvider implements LLMProvider {
      readonly id = 'fast';
      supports(): boolean { return true; }
      async countTokens(): Promise<number> { return 0; }
      async *run(_params: RunParams): AsyncIterable<StreamChunk> {
        yield { type: 'done', inputTokens: 0, outputTokens: 0, stopReason: 'end_turn' };
      }
    }

    const runner = new AgentRunner(createAgentConfig(), {
      provider: new FastProvider(),
      toolRegistry: new ToolRegistry(),
      sessionStore: new SessionStore(dir),
      metaStore: new SessionMetaStore(dir),
    });

    expect(runner.isRunning).toBe(false);
    await runner.runTurn('ping');
    expect(runner.isRunning).toBe(false);
  });

  it('forceReset() clears stuck running state without throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-forcereset-'));
    tempDirs.push(dir);

    class NeverReturnsProvider implements LLMProvider {
      readonly id = 'never';
      supports(): boolean { return true; }
      async countTokens(): Promise<number> { return 0; }
      async *run(_params: RunParams): AsyncIterable<StreamChunk> {
        yield { type: 'done', inputTokens: 0, outputTokens: 0, stopReason: 'end_turn' };
      }
    }

    const runner = new AgentRunner(createAgentConfig(), {
      provider: new NeverReturnsProvider(),
      toolRegistry: new ToolRegistry(),
      sessionStore: new SessionStore(dir),
      metaStore: new SessionMetaStore(dir),
    });

    // forceReset on a non-running runner is a no-op (does not throw)
    expect(() => runner.forceReset()).not.toThrow();
    expect(runner.isRunning).toBe(false);
  });

  it('persists messages across multiple turns in the same thread', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentflyer-multiturn-'));
    tempDirs.push(dir);

    let callCount = 0;
    class CountingProvider implements LLMProvider {
      readonly id = 'counting';
      supports(): boolean { return true; }
      async countTokens(): Promise<number> { return 0; }
      async *run(params: RunParams): AsyncIterable<StreamChunk> {
        callCount += 1;
        const userCount = params.messages.filter((m) => m.role === 'user').length;
        yield { type: 'text_delta', text: `turn${callCount}:msgs${userCount}` };
        yield { type: 'done', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' };
      }
    }

    const sessionStore = new SessionStore(dir);
    const runner = new AgentRunner(createAgentConfig(), {
      provider: new CountingProvider(),
      toolRegistry: new ToolRegistry(),
      sessionStore,
      metaStore: new SessionMetaStore(dir),
    });

    await runner.runTurn('first');
    const result2 = await runner.runTurn('second');

    // Second turn includes both user messages in the prompt
    expect(result2.text).toContain('turn2');
    expect(result2.text).toContain('msgs2');
  });
});
