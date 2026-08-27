import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionMetaStore } from '../core/session/meta.js';
import { SessionStore } from '../core/session/store.js';
import { asSessionKey } from '../core/types.js';
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

class RecoverableThinkingSocketCloseProvider implements LLMProvider {
  readonly id = 'recoverable-thinking-socket-close';
  private attempts = 0;

  async *run(_params: RunParams): AsyncIterable<StreamChunk> {
    this.attempts += 1;
    if (this.attempts === 1) {
      yield { type: 'thinking_delta', thinking: '先分析一下...' };
      yield {
        type: 'error',
        message:
          'Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
      };
      return;
    }

    yield { type: 'text_delta', text: 'socket retry success' };
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

class LongRunningToolProvider implements LLMProvider {
  readonly id = 'long-running-tool';
  private round = 0;

  constructor(private readonly toolRounds: number) {}

  async *run(_params: RunParams): AsyncIterable<StreamChunk> {
    this.round += 1;
    if (this.round > this.toolRounds) {
      yield { type: 'text_delta', text: 'long task complete' };
      yield { type: 'done', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' };
      return;
    }

    const id = `tool-${this.round}`;
    yield { type: 'tool_use_start', id, name: 'progress_step' };
    yield {
      type: 'tool_use_delta',
      id,
      name: 'progress_step',
      inputJson: JSON.stringify({ step: this.round }),
    };
    yield { type: 'done', inputTokens: 1, outputTokens: 1, stopReason: 'tool_use' };
  }

  async countTokens(): Promise<number> {
    return 0;
  }

  supports(): boolean {
    return true;
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

  it('retries a transient socket-close stream failure even after thinking output', async () => {
    const dataDir = await createTempDir();
    const provider = new RecoverableThinkingSocketCloseProvider();
    const runner = createRunner(dataDir, provider);

    const result = await runner.runTurn('continue thinking');

    expect(provider.getAttemptCount()).toBe(2);
    expect(result.text).toContain('socket retry success');
    expect(result.text).not.toContain('任务执行失败');
  });

  it('allows a progressing task to complete beyond 60 tool rounds', async () => {
    const dataDir = await createTempDir();
    const provider = new LongRunningToolProvider(61);
    const registry = new ToolRegistry();
    registry.register({
      category: 'builtin',
      definition: {
        name: 'progress_step',
        description: 'record one completed task step',
        inputSchema: { type: 'object', properties: { step: { type: 'number' } } },
      },
      async handler(input) {
        return { isError: false, content: `completed ${(input as { step: number }).step}` };
      },
    });
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
        tools: { allow: [], deny: [], approval: [], maxRounds: 240 },
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

    const result = await runner.runTurn('complete all planned steps');

    expect(result.text).toContain('long task complete');
    expect(result.text).not.toContain('工具调用轮次已达到上限');
  });

  it('does not reuse a task-scoped system prompt for a later turn without taskContext', async () => {
    const dataDir = await createTempDir();
    const provider = new RecoverableRetryProvider();
    const runner = createRunner(dataDir, provider);

    const withTask = await runner.beginKernelTurn('run-with-task', 'hello', {
      taskContext: 'TASK_CONTEXT_ONLY_MARKER',
    });
    runner.forceReset('run-with-task');

    const withoutTask = await runner.beginKernelTurn('run-without-task', 'hello');

    expect(withTask.systemPrompt).toContain('TASK_CONTEXT_ONLY_MARKER');
    expect(withoutTask.systemPrompt).not.toContain('TASK_CONTEXT_ONLY_MARKER');
  });

  it('persists kernel turn output into the original session even if the runner thread changes later', async () => {
    const dataDir = await createTempDir();
    const provider = new RecoverableRetryProvider();
    const runner = createRunner(dataDir, provider);
    const sessionStore = new SessionStore(join(dataDir, 'sessions'));

    const executionState = await runner.beginKernelTurn('run-session-stable', 'hello');
    const originalSessionKey = executionState.sessionKey;

    runner.restoreState({
      ...runner.serializeState(),
      activeThreadKey: 'other-thread',
      defaultThreadKey: 'other-thread',
    });
    const otherSessionKey = runner.defaultSessionKey;

    await runner.applyKernelLlmGenerateSyscall(executionState, {
      requestId: 'req-1',
      ok: true,
      resolvedAt: Date.now(),
      payload: {
        chunks: [
          { type: 'text_delta', text: 'reply on original session' },
          {
            type: 'done',
            inputTokens: 1,
            outputTokens: 1,
            stopReason: 'end_turn',
          },
        ],
        recoverableStreamRetries: 0,
      },
    });

    const originalHistory = await sessionStore.readAll(originalSessionKey);
    const otherHistory = await sessionStore.readAll(otherSessionKey);

    expect(originalHistory.at(-1)?.content).toBe('reply on original session');
    expect(otherHistory).toEqual([]);
  });

  it('keeps the default thread stable after an explicit kernel thread completes', async () => {
    const dataDir = await createTempDir();
    const provider = new RecoverableRetryProvider();
    const runner = createRunner(dataDir, provider);

    runner.setDefaultThread('operator-default-thread');

    const executionState = await runner.beginKernelTurn(
      'run-explicit-kernel-thread',
      'hello',
      {},
      'kernel-thread-only',
    );

    expect(executionState.sessionKey).toContain('kernel-thread-only');
    expect(runner.activeSessionKey).toContain('kernel-thread-only');

    runner.forceReset(executionState.runId);

    expect(runner.defaultSessionKey).toContain('operator-default-thread');
    expect(runner.serializeState().defaultThreadKey).toBe('operator-default-thread');
  });

  it('drops poisoned Gemini thought-signature turns from stored history before a new turn starts', async () => {
    const dataDir = await createTempDir();
    const provider = new RecoverableRetryProvider();
    const runner = createRunner(dataDir, provider);
    const sessionStore = new SessionStore(join(dataDir, 'sessions'));
    const sessionKey = asSessionKey('agent:agent-main:default');

    await sessionStore.appendMany(sessionKey, [
      {
        id: 'msg-tool-use',
        sessionKey,
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'bash',
            input: { command: 'pwd' },
          },
        ],
        timestamp: Date.now() - 3,
      },
      {
        id: 'msg-tool-result',
        sessionKey,
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'D:/workspace',
          },
        ],
        timestamp: Date.now() - 2,
      },
      {
        id: 'msg-error',
        sessionKey,
        role: 'assistant',
        content:
          'Error: Error: 429 Function call is missing a thought_signature in functionCall parts.',
        timestamp: Date.now() - 1,
      },
    ]);

    const executionState = await runner.beginKernelTurn('run-drop-poisoned-history', 'fresh turn');

    expect(executionState.messages).toEqual([{ role: 'user', content: 'fresh turn' }]);
  });

  it('runs a direct turn on an explicit thread without mutating the default thread', async () => {
    const dataDir = await createTempDir();
    const provider = new RecoverableRetryProvider();
    const runner = createRunner(dataDir, provider);

    runner.setDefaultThread('operator-default-thread');

    const result = await runner.runTurn('hello explicit direct thread', {
      threadKey: 'direct-explicit-thread',
    });

    expect(result.sessionKey).toContain('direct-explicit-thread');
    expect(runner.defaultSessionKey).toContain('operator-default-thread');
    expect(runner.sessionKeyForThread('direct-explicit-thread')).toContain(
      'direct-explicit-thread',
    );
    expect(runner.serializeState().defaultThreadKey).toBe('operator-default-thread');
  });

  it('does not restore thread or session state from tool syscall cache updates', async () => {
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

    runner.replaceToolsForCategory('builtin', [
      {
        category: 'builtin',
        definition: {
          name: 'read_file',
          description: 'read',
          inputSchema: { type: 'object', properties: {} },
        },
        async handler() {
          return { isError: false, content: 'cached-read' };
        },
      },
    ]);

    const executionState = await runner.beginKernelTurn('run-tool-cache-only', 'hello');
    executionState.pendingToolCalls = [
      { id: 'tool-1', name: 'read_file', inputJson: '{"path":"alpha"}' },
    ];

    const resolution = await runner.executeKernelToolCallSyscall(
      executionState,
      { id: 'req-tool-1', kind: 'tool.call' } as never,
      Date.now(),
    );

    runner.restoreState({
      ...runner.serializeState(),
      activeThreadKey: 'other-thread-after-tool-call',
      defaultThreadKey: 'other-thread-after-tool-call',
    });

    await runner.applyKernelToolCallSyscall(executionState, resolution);

    expect(runner.defaultSessionKey).toContain('other-thread-after-tool-call');
  });

  it('carries prompt cache through serialized runner state', async () => {
    const dataDir = await createTempDir();
    const provider = new RecoverableRetryProvider();
    const runner = createRunner(dataDir, provider);

    await runner.beginKernelTurn('run-build-cache', 'hello');
    runner.forceReset('run-build-cache');

    expect(runner.serializeState()).toEqual({
      activeThreadKey: 'default',
      defaultThreadKey: 'default',
      toolResultCache: [],
      promptLayerHashes: expect.arrayContaining([
        expect.objectContaining({ index: 0 }),
        expect.objectContaining({ index: 1 }),
        expect.objectContaining({ index: 2 }),
        expect.objectContaining({ index: 3 }),
      ]),
      cachedSystemPrompt: expect.any(String),
    });
  });

  it('rejects setDefaultThread while a turn is active or beginning', async () => {
    const dataDir = await createTempDir();
    const provider = new RecoverableRetryProvider();
    const runner = createRunner(dataDir, provider);

    const beginPromise = runner.beginKernelTurn('run-begin-stable', 'hello during begin');
    expect(() => runner.setDefaultThread('thread-switched-during-begin')).toThrow(
      "Agent 'agent-main' cannot change default thread while a turn is active",
    );

    const executionState = await beginPromise;
    expect(() => runner.setDefaultThread('thread-switched-after-begin')).toThrow(
      "Agent 'agent-main' cannot change default thread while a turn is active",
    );

    runner.forceReset(executionState.runId);
    expect(() => runner.setDefaultThread('thread-allowed-after-reset')).not.toThrow();
  });

  it('rejects a concurrent turn before shared runner state can be reused', async () => {
    const dataDir = await createTempDir();
    const provider = new RecoverableRetryProvider();
    const runner = createRunner(dataDir, provider);

    const firstTurn = runner.beginKernelTurn('run-concurrent-first', 'first turn');
    await expect(runner.beginKernelTurn('run-concurrent-second', 'second turn')).rejects.toThrow(
      "Agent 'agent-main' is already processing a turn",
    );

    const executionState = await firstTurn;
    expect(executionState.runId).toBe('run-concurrent-first');
    runner.forceReset(executionState.runId);
  });

  it('syncs runner lease mode explicitly without inferring from runId', async () => {
    const dataDir = await createTempDir();
    const provider = new RecoverableRetryProvider();
    const runner = createRunner(dataDir, provider);

    runner.setDefaultThread('operator-default-thread');

    runner.syncRuntimeState(
      'queued-thread',
      'run-queued',
      [],
      [],
      null,
      'operator-default-thread',
      'idle',
    );
    expect(runner.isRunning).toBe(false);
    expect(runner.activeSessionKey).toBeNull();
    expect(runner.defaultSessionKey).toContain('operator-default-thread');

    runner.syncRuntimeState(
      'kernel-thread',
      'run-live',
      [],
      [],
      null,
      'operator-default-thread',
      'kernel',
    );
    expect(runner.isRunning).toBe(true);
    expect(runner.activeSessionKey).toContain('kernel-thread');
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

  it('defers category replacement until the active run completes', async () => {
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
          name: 'mcp_first',
          description: 'first',
          inputSchema: { type: 'object', properties: {} },
        },
        async handler() {
          return { isError: false, content: 'first-ok' };
        },
      },
    ];
    const secondTools: RegisteredTool[] = [
      {
        category: 'mcp',
        definition: {
          name: 'mcp_second',
          description: 'second',
          inputSchema: { type: 'object', properties: {} },
        },
        async handler() {
          return { isError: false, content: 'second-ok' };
        },
      },
    ];

    runner.replaceToolsForCategory('mcp', firstTools);
    const executionState = await runner.beginKernelTurn('run-defer-tools', 'hello');

    runner.replaceToolsForCategory('mcp', secondTools);
    expect(runner.listTools().map((tool) => tool.name)).toEqual(['mcp_first']);

    runner.forceReset(executionState.runId);
    expect(runner.listTools().map((tool) => tool.name)).toEqual(['mcp_second']);
  });

  it('rejects clearHistory while a turn is active', async () => {
    const dataDir = await createTempDir();
    const provider = new RecoverableRetryProvider();
    const runner = createRunner(dataDir, provider);

    const executionState = await runner.beginKernelTurn('run-clear-active', 'hello');

    await expect(runner.clearHistory('default')).rejects.toThrow(
      "Agent 'agent-main' cannot clear history while a turn is active",
    );

    runner.forceReset(executionState.runId);
    await expect(runner.clearHistory('default')).resolves.toBeUndefined();
  });
});
