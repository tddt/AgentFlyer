/**
 * Unit tests for src/gateway/rpc.ts — dispatchRpc method routing.
 *
 * Strategy:
 *  - Mock `agent-kernel.js` so getAgentKernelService returns a lightweight stub.
 *  - Mock heavy side-effectful imports (mcp/index, memory/search, scheduler/*).
 *  - Build a minimal RpcContext via makeCtx() helper.
 *  - Focus on method routing, param validation, and error serialisation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Agent-kernel mock (factory must not reference external variables) ────────
vi.mock('../../../src/gateway/agent-kernel.js', () => ({
  getAgentKernelService: vi.fn(),
}));

// ─── MCP mock ─────────────────────────────────────────────────────────────────
vi.mock('../../../src/mcp/index.js', () => ({
  readMcpServerHistory: vi.fn().mockResolvedValue([]),
  summarizeMcpServerHistory: vi.fn().mockReturnValue([]),
  buildMcpServerOperatorAttention: vi.fn().mockReturnValue({ servers: [], summary: '' }),
  formatMcpAttentionSummary: vi.fn().mockReturnValue(''),
}));

// ─── Memory search mock ───────────────────────────────────────────────────────
vi.mock('../../../src/memory/search.js', () => ({
  searchMemory: vi.fn().mockResolvedValue([]),
}));

// ─── Scheduler history mock ───────────────────────────────────────────────────
vi.mock('../../../src/scheduler/task-history.js', () => ({
  readScheduledTaskHistory: vi.fn().mockResolvedValue([]),
  appendScheduledTaskHistoryRecord: vi.fn().mockResolvedValue(undefined),
  buildScheduledTaskExecutionSummaryById: vi.fn().mockReturnValue(new Map()),
}));

// ─── Workflow backend mock ────────────────────────────────────────────────────
vi.mock('../../../src/gateway/workflow-backend.js', () => ({
  readWorkflowsFile: vi.fn().mockResolvedValue([]),
  dispatchWorkflowRpc: vi
    .fn()
    .mockResolvedValue({ id: 'x', result: { workflows: [] } }),
  diagnoseWorkflowValidation: vi.fn().mockReturnValue([]),
  diagnoseWorkflowGraph: vi.fn().mockReturnValue([]),
  runWorkflowForScheduler: vi.fn().mockResolvedValue({ output: 'done', workflowRunId: 'wfr-1' }),
}));

// ─── Skills registry mock ─────────────────────────────────────────────────────
vi.mock('../../../src/skills/registry.js', () => ({
  scanSkillsDir: vi.fn().mockResolvedValue([]),
}));

// Import SUT after mocks
import type { RpcContext } from '../../../src/gateway/rpc.js';
import { buildErrorResponse, dispatchRpc } from '../../../src/gateway/rpc.js';
import { getAgentKernelService } from '../../../src/gateway/agent-kernel.js';

// ─── Shared mock kernel — configured in beforeEach via vi.mocked() ────────────
const mockKernel = {
  executeTurn: vi.fn(),
  getLatestLiveRunForAgent: vi.fn(),
  getQueuedRunsForAgent: vi.fn(),
  getRun: vi.fn(),
  cancelQueuedTurn: vi.fn(),
  resumeTurn: vi.fn(),
  reserveQueuedTurn: vi.fn(),
  startTurn: vi.fn(),
  initialize: vi.fn(),
};

// ─── Minimal runner stub ──────────────────────────────────────────────────────
function makeRunner(toolNames: string[] = []) {
  return {
    listTools: () =>
      toolNames.map((name) => ({
        name,
        description: `${name} tool`,
        category: 'test',
      })),
    clearHistory: vi.fn().mockResolvedValue(undefined),
    isRunning: false,
  };
}

// ─── Minimal RpcContext factory ───────────────────────────────────────────────
function makeCtx(overrides: Partial<RpcContext> = {}): RpcContext {
  return {
    runners: new Map(),
    gatewayVersion: '1.2.0-test',
    startedAt: Date.now() - 5000,
    dataDir: '/tmp/rpc-test',
    getConfig: () => ({} as import('../../../src/core/config/schema.js').Config),
    saveAndReload: vi.fn().mockResolvedValue({ reloaded: [] }),
    scheduler: { cancel: vi.fn(), schedule: vi.fn(), get: vi.fn() } as never,
    shutdown: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue({ reloaded: ['agent-1'] }),
    listSkills: () => [],
    sessionStore: {
      readAll: vi.fn().mockResolvedValue([]),
      overwrite: vi.fn().mockResolvedValue(undefined),
    } as never,
    metaStore: {
      listAll: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
    } as never,
    contentStore: { list: vi.fn().mockResolvedValue([]), get: vi.fn().mockResolvedValue(null) } as never,
    deliverableStore: { upsert: vi.fn(), get: vi.fn(), list: vi.fn() } as never,
    channels: new Map(),
    runningTasks: new Map(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('dispatchRpc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Wire up getAgentKernelService to return our shared mock kernel
    vi.mocked(getAgentKernelService).mockResolvedValue(mockKernel as never);
    // Apply sensible default return values
    mockKernel.executeTurn.mockResolvedValue({ text: 'mock reply', inputTokens: 10, outputTokens: 5 });
    mockKernel.getLatestLiveRunForAgent.mockReturnValue(null);
    mockKernel.getQueuedRunsForAgent.mockReturnValue([]);
    mockKernel.getRun.mockReturnValue(undefined);
    mockKernel.cancelQueuedTurn.mockResolvedValue(true);
    mockKernel.resumeTurn.mockResolvedValue({ runId: 'run-1', phase: 'done' });
    mockKernel.reserveQueuedTurn.mockResolvedValue({ runId: 'run-queued-1' });
    mockKernel.startTurn.mockResolvedValue({ runId: 'run-1', phase: 'pending' });
  });

  // ── gateway.ping ──────────────────────────────────────────────────────────

  it('gateway.ping returns pong with timestamp', async () => {
    const ctx = makeCtx();
    const res = await dispatchRpc({ id: 1, method: 'gateway.ping' }, ctx);
    expect(res.id).toBe(1);
    expect(res.result).toMatchObject({ pong: true });
    expect(typeof (res.result as { ts: number }).ts).toBe('number');
  });

  // ── gateway.status ────────────────────────────────────────────────────────

  it('gateway.status returns version, uptime, and agent count', async () => {
    const ctx = makeCtx({
      runners: new Map([['a1', makeRunner() as never], ['a2', makeRunner() as never]]),
    });
    const res = await dispatchRpc({ id: 2, method: 'gateway.status' }, ctx);
    const result = res.result as Record<string, unknown>;
    expect(result.version).toBe('1.2.0-test');
    expect(typeof result.uptime).toBe('number');
    expect(result.agents).toBe(2);
  });

  // ── agent.list ────────────────────────────────────────────────────────────

  it('agent.list returns agents with activity', async () => {
    const ctx = makeCtx({
      runners: new Map([['main', makeRunner(['search', 'write']) as never]]),
    });
    const res = await dispatchRpc({ id: 3, method: 'agent.list' }, ctx);
    const result = res.result as { agents: Array<{ agentId: string; activity: unknown }> };
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.agentId).toBe('main');
    expect(result.agents[0]?.activity).toMatchObject({ state: 'idle', busy: false });
  });

  // ── tool.list ─────────────────────────────────────────────────────────────

  it('tool.list aggregates tools across runners sorted by category+name', async () => {
    const ctx = makeCtx({
      runners: new Map([
        ['a1', makeRunner(['bash', 'search']) as never],
        ['a2', makeRunner(['search', 'write']) as never],
      ]),
    });
    const res = await dispatchRpc({ id: 4, method: 'tool.list' }, ctx);
    const tools = (res.result as { tools: Array<{ name: string; agentIds: string[] }> }).tools;
    // 'search' appears in both agents — must be deduplicated with both agentIds
    const searchTool = tools.find((t) => t.name === 'search');
    expect(searchTool).toBeDefined();
    expect(searchTool?.agentIds).toContain('a1');
    expect(searchTool?.agentIds).toContain('a2');
    // all 3 unique names present
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['bash', 'search', 'write']));
  });

  // ── channel.list ──────────────────────────────────────────────────────────

  it('channel.list returns empty list when no channels registered', async () => {
    const res = await dispatchRpc({ id: 5, method: 'channel.list' }, makeCtx());
    expect((res.result as { channels: unknown[] }).channels).toEqual([]);
  });

  it('channel.list returns channel descriptors', async () => {
    const ctx = makeCtx({
      channels: new Map([
        ['discord', { id: 'discord', name: 'Discord', sendAttachment: vi.fn() } as never],
      ]),
    });
    const res = await dispatchRpc({ id: 6, method: 'channel.list' }, ctx);
    const channels = (res.result as { channels: Array<{ id: string; supportsAttachment: boolean }> }).channels;
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ id: 'discord', supportsAttachment: true });
  });

  // ── mesh.status ───────────────────────────────────────────────────────────

  it('mesh.status returns empty agents when no registry', async () => {
    const res = await dispatchRpc({ id: 7, method: 'mesh.status' }, makeCtx());
    expect((res.result as { agents: unknown[] }).agents).toEqual([]);
  });

  it('mesh.status calls meshRegistry.list()', async () => {
    const meshRegistry = { list: vi.fn().mockReturnValue([{ id: 'worker', status: 'ready' }]) };
    const ctx = makeCtx({ meshRegistry: meshRegistry as never });
    const res = await dispatchRpc({ id: 8, method: 'mesh.status' }, ctx);
    expect((res.result as { agents: unknown[] }).agents).toHaveLength(1);
    expect(meshRegistry.list).toHaveBeenCalledOnce();
  });

  // ── federation.peers ──────────────────────────────────────────────────────

  it('federation.peers returns disabled when federation not configured', async () => {
    const res = await dispatchRpc({ id: 9, method: 'federation.peers' }, makeCtx());
    expect(res.result).toMatchObject({ enabled: false, peers: [] });
  });

  it('federation.peers returns peers when node available', async () => {
    const peer = { nodeId: 'n1', host: 'localhost', port: 8080, status: 'connected' };
    const ctx = makeCtx({
      getConfig: () => ({ federation: { enabled: true } } as never),
      federationNode: { listPeers: () => [peer] },
    });
    const res = await dispatchRpc({ id: 10, method: 'federation.peers' }, ctx);
    expect(res.result).toMatchObject({ enabled: true, peers: [peer] });
  });

  // ── config.get ────────────────────────────────────────────────────────────

  it('config.get returns current config', async () => {
    const cfg = { agents: [{ id: 'main', name: 'Main', model: 'gpt-4' }] };
    const ctx = makeCtx({ getConfig: () => cfg as never });
    const res = await dispatchRpc({ id: 11, method: 'config.get' }, ctx);
    expect(res.result).toEqual(cfg);
  });

  // ── config.save ───────────────────────────────────────────────────────────

  it('config.save forwards params to saveAndReload', async () => {
    const saveAndReload = vi.fn().mockResolvedValue({ reloaded: ['main'] });
    const ctx = makeCtx({ saveAndReload });
    const payload = { agents: [] };
    const res = await dispatchRpc({ id: 12, method: 'config.save', params: payload }, ctx);
    expect(saveAndReload).toHaveBeenCalled();
    expect((res.result as { reloaded: string[] }).reloaded).toEqual(['main']);
  });

  // ── agent.reload ──────────────────────────────────────────────────────────

  it('agent.reload delegates to ctx.reload', async () => {
    const reload = vi.fn().mockResolvedValue({ reloaded: ['agent-x'] });
    const ctx = makeCtx({ reload });
    const res = await dispatchRpc({ id: 13, method: 'agent.reload', params: { agentId: 'agent-x' } }, ctx);
    expect(reload).toHaveBeenCalledWith('agent-x');
    expect((res.result as { reloaded: string[] }).reloaded).toEqual(['agent-x']);
  });

  // ── agent.chat ────────────────────────────────────────────────────────────

  it('agent.chat returns reply from kernel executeTurn', async () => {
    mockKernel.executeTurn.mockResolvedValue({ text: ' Hello! ' });
    const ctx = makeCtx({
      runners: new Map([['main', makeRunner() as never]]),
    });
    const res = await dispatchRpc(
      { id: 14, method: 'agent.chat', params: { agentId: 'main', message: 'hi' } },
      ctx,
    );
    expect(res.error).toBeUndefined();
    expect((res.result as { reply: string }).reply).toBe('Hello!');
  });

  it('agent.chat returns 400 when agentId is missing', async () => {
    const res = await dispatchRpc(
      { id: 15, method: 'agent.chat', params: { message: 'hi' } },
      makeCtx(),
    );
    expect(res.error?.code).toBe(-32602);
  });

  it('agent.chat returns 404 when agent not found', async () => {
    const res = await dispatchRpc(
      { id: 16, method: 'agent.chat', params: { agentId: 'ghost', message: 'hi' } },
      makeCtx(),
    );
    expect(res.error?.code).toBe(404);
  });

  // ── agent.run ─────────────────────────────────────────────────────────────

  it('agent.run returns started run', async () => {
    mockKernel.startTurn.mockResolvedValue({ runId: 'run-42', phase: 'running' });
    const ctx = makeCtx({
      runners: new Map([['main', makeRunner() as never]]),
    });
    const res = await dispatchRpc(
      { id: 17, method: 'agent.run', params: { agentId: 'main', message: 'do something' } },
      ctx,
    );
    expect(res.error).toBeUndefined();
    expect((res.result as { runId: string }).runId).toBe('run-42');
  });

  it('agent.run returns 400 when message is missing', async () => {
    const ctx = makeCtx({ runners: new Map([['main', makeRunner() as never]]) });
    const res = await dispatchRpc(
      { id: 18, method: 'agent.run', params: { agentId: 'main' } },
      ctx,
    );
    expect(res.error?.code).toBe(-32602);
  });

  // ── agent.cancel ──────────────────────────────────────────────────────────

  it('agent.cancel returns 400 when runId is missing', async () => {
    const res = await dispatchRpc({ id: 19, method: 'agent.cancel', params: {} }, makeCtx());
    expect(res.error?.code).toBe(-32602);
  });

  it('agent.cancel returns 404 when run not found', async () => {
    mockKernel.getRun.mockReturnValue(undefined);
    const res = await dispatchRpc(
      { id: 20, method: 'agent.cancel', params: { runId: 'no-such-run' } },
      makeCtx(),
    );
    expect(res.error?.code).toBe(404);
  });

  it('agent.cancel cancels a queued run', async () => {
    mockKernel.getRun.mockReturnValue({
      runId: 'run-q',
      agentId: 'main',
      processStatus: 'waiting',
      phase: 'pending',
    });
    mockKernel.cancelQueuedTurn.mockResolvedValue(true);
    const res = await dispatchRpc(
      { id: 21, method: 'agent.cancel', params: { runId: 'run-q' } },
      makeCtx(),
    );
    expect(res.error).toBeUndefined();
    expect((res.result as { cancelled: boolean }).cancelled).toBe(true);
  });

  // ── agent.runStatus ───────────────────────────────────────────────────────

  it('agent.runStatus returns 400 when runId missing', async () => {
    const res = await dispatchRpc({ id: 22, method: 'agent.runStatus', params: {} }, makeCtx());
    expect(res.error?.code).toBe(-32602);
  });

  it('agent.runStatus returns run object when found', async () => {
    const run = { runId: 'run-77', phase: 'done' };
    mockKernel.getRun.mockReturnValue(run);
    const res = await dispatchRpc(
      { id: 23, method: 'agent.runStatus', params: { runId: 'run-77' } },
      makeCtx(),
    );
    expect(res.result).toEqual(run);
  });

  // ── agent.resume ──────────────────────────────────────────────────────────

  it('agent.resume returns 400 when runId missing', async () => {
    const res = await dispatchRpc({ id: 24, method: 'agent.resume', params: {} }, makeCtx());
    expect(res.error?.code).toBe(-32602);
  });

  it('agent.resume returns 404 when run not found', async () => {
    mockKernel.getRun.mockReturnValue(undefined);
    const res = await dispatchRpc(
      { id: 25, method: 'agent.resume', params: { runId: 'missing' } },
      makeCtx(),
    );
    expect(res.error?.code).toBe(404);
  });

  it('agent.resume resumes a suspended run', async () => {
    const run = { runId: 'run-s', phase: 'suspended', processStatus: 'suspended' };
    mockKernel.getRun.mockReturnValue(run);
    mockKernel.resumeTurn.mockResolvedValue({ ...run, phase: 'running', processStatus: 'running' });
    const res = await dispatchRpc(
      { id: 26, method: 'agent.resume', params: { runId: 'run-s' } },
      makeCtx(),
    );
    expect(res.error).toBeUndefined();
    expect((res.result as { resumed: boolean }).resumed).toBe(true);
  });

  // ── agent.status ──────────────────────────────────────────────────────────

  it('agent.status returns 404 when agent not found', async () => {
    const res = await dispatchRpc(
      { id: 27, method: 'agent.status', params: { agentId: 'ghost' } },
      makeCtx(),
    );
    expect(res.error?.code).toBe(404);
  });

  it('agent.status returns activity for known agent', async () => {
    const ctx = makeCtx({
      runners: new Map([['main', makeRunner() as never]]),
    });
    const res = await dispatchRpc(
      { id: 28, method: 'agent.status', params: { agentId: 'main' } },
      ctx,
    );
    expect(res.error).toBeUndefined();
    expect((res.result as { agentId: string }).agentId).toBe('main');
    expect((res.result as { activity: { state: string } }).activity.state).toBe('idle');
  });

  // ── session.list ──────────────────────────────────────────────────────────

  it('session.list returns empty list when no sessions', async () => {
    const res = await dispatchRpc({ id: 29, method: 'session.list' }, makeCtx());
    expect((res.result as { sessions: unknown[] }).sessions).toEqual([]);
  });

  it('session.list returns sessions sorted by lastActivity desc', async () => {
    const sessions = [
      { sessionKey: 'key-1', lastActivity: 100 },
      { sessionKey: 'key-2', lastActivity: 200 },
    ];
    const ctx = makeCtx({
      metaStore: { listAll: vi.fn().mockResolvedValue(sessions), update: vi.fn() } as never,
    });
    const res = await dispatchRpc({ id: 30, method: 'session.list' }, ctx);
    const result = (res.result as { sessions: Array<{ sessionKey: string }> }).sessions;
    expect(result[0]?.sessionKey).toBe('key-2');
    expect(result[1]?.sessionKey).toBe('key-1');
  });

  // ── session.messages ──────────────────────────────────────────────────────

  it('session.messages returns 400 when sessionKey missing', async () => {
    const res = await dispatchRpc({ id: 31, method: 'session.messages', params: {} }, makeCtx());
    expect(res.error?.code).toBe(-32602);
  });

  it('session.messages returns converted messages', async () => {
    const stored = [
      { id: 'm1', role: 'user', content: 'Hello', timestamp: 1000 },
      { id: 'm2', role: 'assistant', content: 'Hi there', timestamp: 1001 },
    ];
    const ctx = makeCtx({
      sessionStore: {
        readAll: vi.fn().mockResolvedValue(stored),
        overwrite: vi.fn(),
      } as never,
    });
    const res = await dispatchRpc(
      { id: 32, method: 'session.messages', params: { sessionKey: 'agent:main:default' } },
      ctx,
    );
    expect(res.error).toBeUndefined();
    const messages = (res.result as { messages: Array<{ role: string; text: string }> }).messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.text).toBe('Hello');
  });

  // ── session.clear ─────────────────────────────────────────────────────────

  it('session.clear clears by sessionKey', async () => {
    const sessionStore = { readAll: vi.fn(), overwrite: vi.fn().mockResolvedValue(undefined) };
    const metaStore = { listAll: vi.fn(), update: vi.fn().mockResolvedValue(undefined) };
    const ctx = makeCtx({ sessionStore: sessionStore as never, metaStore: metaStore as never });
    const res = await dispatchRpc(
      { id: 33, method: 'session.clear', params: { sessionKey: 'agent:main:abc' } },
      ctx,
    );
    expect(res.error).toBeUndefined();
    expect((res.result as { cleared: boolean }).cleared).toBe(true);
    expect(sessionStore.overwrite).toHaveBeenCalledWith('agent:main:abc', []);
  });

  it('session.clear clears by agentId via runner.clearHistory', async () => {
    const runner = makeRunner();
    const ctx = makeCtx({ runners: new Map([['main', runner as never]]) });
    const res = await dispatchRpc(
      { id: 34, method: 'session.clear', params: { agentId: 'main' } },
      ctx,
    );
    expect(res.error).toBeUndefined();
    expect(runner.clearHistory).toHaveBeenCalledOnce();
  });

  // ── memory.search ─────────────────────────────────────────────────────────

  it('memory.search returns 503 when no memoryStore', async () => {
    const res = await dispatchRpc(
      { id: 35, method: 'memory.search', params: { query: 'hello' } },
      makeCtx(),
    );
    expect(res.error?.code).toBe(503);
  });

  it('memory.search returns 400 when query missing', async () => {
    const ctx = makeCtx({
      memoryStore: { searchFts: vi.fn() } as never,
    });
    const res = await dispatchRpc({ id: 36, method: 'memory.search', params: {} }, ctx);
    expect(res.error?.code).toBe(-32602);
  });

  it('memory.search returns results from searchMemory', async () => {
    const { searchMemory } = await import('../../../src/memory/search.js');
    (searchMemory as ReturnType<typeof vi.fn>).mockResolvedValue([
      { entry: { id: 'e1', agentId: 'main', text: 'fact' }, score: 0.9, method: 'fts' },
    ]);
    const ctx = makeCtx({
      memoryStore: {} as never,
    });
    const res = await dispatchRpc(
      { id: 37, method: 'memory.search', params: { query: 'fact' } },
      ctx,
    );
    expect(res.error).toBeUndefined();
    const results = (res.result as { results: Array<{ id: string; score: number }> }).results;
    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBe(0.9);
  });

  // ── memory.delete ─────────────────────────────────────────────────────────

  it('memory.delete returns 503 when no memoryStore', async () => {
    const res = await dispatchRpc(
      { id: 38, method: 'memory.delete', params: { entryId: 'e1' } },
      makeCtx(),
    );
    expect(res.error?.code).toBe(503);
  });

  it('memory.delete removes entry and returns deleted:true', async () => {
    const memoryStore = { delete: vi.fn() };
    const ctx = makeCtx({ memoryStore: memoryStore as never });
    const res = await dispatchRpc(
      { id: 39, method: 'memory.delete', params: { entryId: 'e5' } },
      ctx,
    );
    expect(res.error).toBeUndefined();
    expect((res.result as { deleted: boolean }).deleted).toBe(true);
    expect(memoryStore.delete).toHaveBeenCalledWith('e5');
  });

  // ── mcp.status ────────────────────────────────────────────────────────────

  it('mcp.status returns empty servers when getMcpStatus not provided', async () => {
    const res = await dispatchRpc({ id: 40, method: 'mcp.status' }, makeCtx());
    expect((res.result as { servers: unknown[] }).servers).toEqual([]);
  });

  it('mcp.status calls getMcpStatus and returns snapshot', async () => {
    const servers = [{ id: 'svr-1', status: 'connected' }];
    const ctx = makeCtx({ getMcpStatus: () => servers as never });
    const res = await dispatchRpc({ id: 41, method: 'mcp.status' }, ctx);
    expect((res.result as { servers: unknown[] }).servers).toEqual(servers);
  });

  // ── mcp.refresh ───────────────────────────────────────────────────────────

  it('mcp.refresh falls back to ctx.reload when refreshMcp not provided', async () => {
    const reload = vi.fn().mockResolvedValue({ reloaded: ['s1'] });
    const ctx = makeCtx({ reload });
    const res = await dispatchRpc({ id: 42, method: 'mcp.refresh' }, ctx);
    expect(reload).toHaveBeenCalledOnce();
    expect(res.error).toBeUndefined();
  });

  // ── scheduler.preview ─────────────────────────────────────────────────────

  it('scheduler.preview returns valid next run for intervalMinutes', async () => {
    const res = await dispatchRpc(
      { id: 43, method: 'scheduler.preview', params: { intervalMinutes: 30 } },
      makeCtx(),
    );
    expect(res.error).toBeUndefined();
    const result = res.result as { valid: boolean; cronExpr: string; nextRunAt: number | null };
    expect(result.valid).toBe(true);
    expect(result.cronExpr).toBe('*/30 * * * *');
    expect(result.nextRunAt).toBeTypeOf('number');
  });

  it('scheduler.preview returns invalid for bad cron expression', async () => {
    const res = await dispatchRpc(
      { id: 44, method: 'scheduler.preview', params: { cronExpr: 'not-a-cron' } },
      makeCtx(),
    );
    const result = res.result as { valid: boolean };
    expect(result.valid).toBe(false);
  });

  it('scheduler.preview returns 400 when neither cronExpr nor intervalMinutes given', async () => {
    const res = await dispatchRpc(
      { id: 45, method: 'scheduler.preview', params: {} },
      makeCtx(),
    );
    expect(res.error?.code).toBe(-32602);
  });

  // ── buildErrorResponse helper ─────────────────────────────────────────────

  it('buildErrorResponse builds correct error shape', () => {
    const res = buildErrorResponse('req-1', -32601, 'Method not found');
    expect(res).toEqual({ id: 'req-1', error: { code: -32601, message: 'Method not found' } });
  });

  // ── unknown method ────────────────────────────────────────────────────────

  it('unknown method returns -32601 method not found', async () => {
    const res = await dispatchRpc(
      { id: 99, method: 'not.a.method' as never },
      makeCtx(),
    );
    expect(res.error?.code).toBe(-32601);
    expect(res.error?.message).toContain('not.a.method');
  });
});
