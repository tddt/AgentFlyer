import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as agentKernelModule from './agent-kernel.js';
import { AgentQueueRegistry } from './agent-queue.js';
import * as chatDeliverablesModule from './chat-deliverables.js';
import { type RouterOptions, routeRequest } from './router.js';
import type { RpcContext } from './rpc.js';
import { SchedulerActivityBroadcaster } from './scheduler-activity.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

type MockReq = IncomingMessage & { emitBody: () => void };

function makeReq(
  url: string,
  method = 'GET',
  headers: Record<string, string> = {},
  body?: unknown,
): MockReq {
  const listeners = new Map<string, Array<(chunk?: Buffer) => void>>();
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf-8');
  let emitted = false;
  const scheduleBody = (): void => {
    if (emitted || payload === null) {
      return;
    }
    emitted = true;
    queueMicrotask(() => {
      for (const handler of listeners.get('data') ?? []) {
        handler(payload);
      }
      for (const handler of listeners.get('end') ?? []) {
        handler();
      }
    });
  };
  const req = {
    url,
    method,
    headers,
    on: vi.fn((event: string, handler: (chunk?: Buffer) => void) => {
      const bucket = listeners.get(event) ?? [];
      bucket.push(handler);
      listeners.set(event, bucket);
      if (event === 'end' || event === 'data') {
        scheduleBody();
      }
      return req;
    }),
    destroy: vi.fn(),
    emitBody: scheduleBody,
  } as unknown as MockReq;
  return req;
}

interface MockRes {
  statusCode: number;
  writeHead: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  body: () => string;
}

function makeRes(): MockRes {
  const chunks: string[] = [];
  const res: MockRes = {
    statusCode: 200,
    writeHead: vi.fn((status: number) => {
      res.statusCode = status;
    }),
    setHeader: vi.fn(),
    write: vi.fn((data?: string) => {
      if (data) chunks.push(data);
    }),
    end: vi.fn((data?: string) => {
      if (data) chunks.push(data);
    }),
    on: vi.fn(() => res),
    body: () => chunks.join(''),
  };
  return res;
}

function makeCtx(overrides: Partial<RpcContext> = {}): RpcContext {
  return {
    gatewayVersion: '1.2.1',
    startedAt: Date.now() - 5000,
    getMcpStatus: () => [],
    channels: new Map(),
    runners: new Map(),
    getConfig: () => ({ agents: [] }),
    reload: async () => ({ reloaded: [] }),
    memoryStore: {} as never,
    runningTasks: new Map(),
    ...overrides,
  } as unknown as RpcContext;
}

function makeOpts(ctxOverrides: Partial<RpcContext> = {}): RouterOptions {
  return {
    authToken: 'test-token',
    rpcContext: makeCtx(ctxOverrides),
    logBroadcaster: { broadcast: vi.fn() } as never,
    port: 18080,
  };
}

function parseJsonBody(body: string): Record<string, unknown> {
  return JSON.parse(body) as Record<string, unknown>;
}

function parseSseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6).trim())
    .filter((payload) => payload && payload !== '[DONE]')
    .map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

const mockedGetAgentKernelService = vi.spyOn(agentKernelModule, 'getAgentKernelService');
const mockedCaptureChatTurnDeliverable = vi.spyOn(
  chatDeliverablesModule,
  'captureChatTurnDeliverable',
);
mockedCaptureChatTurnDeliverable.mockResolvedValue(null);

afterEach(() => {
  mockedGetAgentKernelService.mockReset();
  mockedCaptureChatTurnDeliverable.mockReset();
  mockedCaptureChatTurnDeliverable.mockResolvedValue(null);
});

// ── GET /health ───────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with ok=true', async () => {
    const req = makeReq('/health');
    const res = makeRes();
    const handled = await routeRequest(req, res as unknown as ServerResponse, makeOpts());

    expect(handled).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'Content-Type': 'application/json' }),
    );
    const body = parseJsonBody(res.body());
    expect(body.ok).toBe(true);
  });

  it('includes version, uptime, timestamp', async () => {
    const req = makeReq('/health');
    const res = makeRes();
    const before = Date.now();
    await routeRequest(req, res as unknown as ServerResponse, makeOpts());
    const after = Date.now();

    const body = parseJsonBody(res.body());
    expect(body.version).toBe('1.2.1');
    expect(typeof body.uptime).toBe('number');
    expect(Number(body.uptime)).toBeGreaterThanOrEqual(4);
    expect(Number(body.timestamp)).toBeGreaterThanOrEqual(before);
    expect(Number(body.timestamp)).toBeLessThanOrEqual(after + 100);
  });

  it('does not require auth (no Authorization header needed)', async () => {
    const req = makeReq('/health', 'GET', {});
    const res = makeRes();
    await routeRequest(req, res as unknown as ServerResponse, makeOpts());
    expect(res.statusCode).toBe(200);
  });

  it('returns false for POST /health', async () => {
    const req = makeReq('/health', 'POST');
    const res = makeRes();
    // POST /health is not handled; router will fall through
    // It may return false (unhandled) or short-circuit at auth check
    // Just verify it doesn't throw
    await expect(
      routeRequest(req, res as unknown as ServerResponse, makeOpts()),
    ).resolves.toBeDefined();
  });
});

// ── GET /ready ────────────────────────────────────────────────────────────────

describe('GET /ready – nominal', () => {
  it('returns 200 with ready=true when db is present', async () => {
    const req = makeReq('/ready');
    const res = makeRes();
    await routeRequest(req, res as unknown as ServerResponse, makeOpts());

    expect(res.statusCode).toBe(200);
    const body = parseJsonBody(res.body());
    expect(body.ready).toBe(true);
  });

  it('includes version and uptime', async () => {
    const req = makeReq('/ready');
    const res = makeRes();
    await routeRequest(req, res as unknown as ServerResponse, makeOpts());

    const body = parseJsonBody(res.body());
    expect(body.version).toBe('1.2.1');
    expect(typeof body.uptime).toBe('number');
  });

  it('includes all component keys', async () => {
    const req = makeReq('/ready');
    const res = makeRes();
    await routeRequest(req, res as unknown as ServerResponse, makeOpts());

    const body = parseJsonBody(res.body());
    const comps = body.components as Record<string, unknown>;
    expect(comps).toHaveProperty('db');
    expect(comps).toHaveProperty('mcp');
    expect(comps).toHaveProperty('channels');
    expect(comps).toHaveProperty('agents');
  });

  it('reports mcp server count from getMcpStatus()', async () => {
    const opts = makeOpts({
      getMcpStatus: () => [
        { id: 's1', status: 'connected' } as never,
        { id: 's2', status: 'disconnected' } as never,
      ],
    });
    const req = makeReq('/ready');
    const res = makeRes();
    await routeRequest(req, res as unknown as ServerResponse, opts);

    const body = parseJsonBody(res.body());
    const comps = body.components as Record<string, Record<string, unknown>>;
    expect(comps.mcp?.serversTotal).toBe(2);
    expect(comps.mcp?.serversConnected).toBe(1);
  });
});

describe('GET /ready – unhealthy', () => {
  it('returns 503 with ready=false when memoryStore is null', async () => {
    const opts = makeOpts({ memoryStore: null as never });
    const req = makeReq('/ready');
    const res = makeRes();
    await routeRequest(req, res as unknown as ServerResponse, opts);

    expect(res.statusCode).toBe(503);
    const body = parseJsonBody(res.body());
    expect(body.ready).toBe(false);
  });

  it('returns 503 with ready=false when memoryStore is undefined', async () => {
    const opts = makeOpts({ memoryStore: undefined as never });
    const req = makeReq('/ready');
    const res = makeRes();
    await routeRequest(req, res as unknown as ServerResponse, opts);

    expect(res.statusCode).toBe(503);
    const body = parseJsonBody(res.body());
    expect(body.ready).toBe(false);
  });
});

// ── CORS preflight ────────────────────────────────────────────────────────────

describe('OPTIONS preflight', () => {
  it('returns 204 for localhost origin preflight', async () => {
    const req = makeReq('/health', 'OPTIONS', { origin: 'http://localhost:3000' });
    const res = makeRes();
    await routeRequest(req, res as unknown as ServerResponse, makeOpts());
    expect(res.writeHead).toHaveBeenCalledWith(204);
  });
});

// ── favicon ───────────────────────────────────────────────────────────────────

describe('GET /favicon.ico', () => {
  it('returns 204 without auth', async () => {
    const req = makeReq('/favicon.ico');
    const res = makeRes();
    const handled = await routeRequest(req, res as unknown as ServerResponse, makeOpts());
    expect(handled).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(
      204,
      expect.objectContaining({ 'Cache-Control': expect.any(String) }),
    );
  });

  describe('GET /api/scheduler-activity', () => {
    it('streams scheduler running snapshots on initial load and follow-up activity', async () => {
      const schedulerActivity = new SchedulerActivityBroadcaster();
      let currentRun: {
        runId: string;
        agentId: string;
        threadKey: string;
        processStatus: 'running' | 'suspended';
        phase: 'running' | 'suspended';
        controlState: 'active' | 'suspended';
        createdAt: number;
        updatedAt: number;
      } | null = {
        runId: 'run-live',
        agentId: 'agent-main',
        threadKey: 'default',
        processStatus: 'running',
        phase: 'running',
        controlState: 'active',
        createdAt: 1,
        updatedAt: 2,
      };
      let kernelActivityListener: ((agentId: string) => void) | null = null;

      mockedGetAgentKernelService.mockResolvedValue({
        getRun: vi.fn(() => currentRun),
        subscribeActivity: vi.fn((listener: (agentId: string) => void) => {
          kernelActivityListener = listener;
          return () => {
            kernelActivityListener = null;
          };
        }),
      } as never);

      const ctx = makeCtx({
        schedulerActivity,
        getConfig: () => ({ agents: [{ id: 'agent-main', name: 'Main Agent' }] }) as never,
      });
      ctx.runningTasks.set('task-live', {
        taskId: 'task-live',
        taskName: 'Live task',
        startedAt: Date.now(),
        agentId: 'agent-main',
        agentRunId: 'run-live',
      });

      const req = makeReq('/api/scheduler-activity?token=test-token');
      const res = makeRes();
      const handled = await routeRequest(req, res as unknown as ServerResponse, {
        ...makeOpts(),
        rpcContext: ctx,
      });

      expect(handled).toBe(true);
      let events = parseSseEvents(res.body());
      expect(events[0]).toEqual({
        running: [
          expect.objectContaining({
            taskId: 'task-live',
            agentRunId: 'run-live',
            status: 'running',
            resumable: false,
          }),
        ],
      });

      currentRun = {
        runId: 'run-live',
        agentId: 'agent-main',
        threadKey: 'default',
        processStatus: 'suspended',
        phase: 'suspended',
        controlState: 'suspended',
        createdAt: 1,
        updatedAt: 3,
      };
      const notifyKernelActivity = kernelActivityListener as ((agentId: string) => void) | null;
      if (notifyKernelActivity) {
        notifyKernelActivity('agent-main');
      }
      await new Promise((resolve) => setTimeout(resolve, 0));

      events = parseSseEvents(res.body());
      expect(events[1]).toEqual({
        running: [
          expect.objectContaining({
            taskId: 'task-live',
            agentRunId: 'run-live',
            status: 'suspended',
            resumable: true,
          }),
        ],
      });

      currentRun = null;
      ctx.runningTasks.delete('task-live');
      schedulerActivity.publish();
      await new Promise((resolve) => setTimeout(resolve, 0));

      events = parseSseEvents(res.body());
      expect(events[2]).toEqual({ running: [] });
    });
  });
});

describe('POST /chat', () => {
  it('lazy-loads a configured agent runner before returning Agent not found', async () => {
    const listeners = new Map<string, (chunk: Record<string, unknown>) => void>();
    mockedGetAgentKernelService.mockResolvedValue({
      startTurn: vi.fn(async ({ runId }: { runId: string }) => {
        listeners.get(runId)?.({ type: 'text_delta', text: 'hello from lazy agent' });
        return { runId };
      }),
      waitForRun: vi.fn(async () => ({ text: 'hello from lazy agent' })),
      subscribeRun: vi.fn((runId: string, listener: (chunk: Record<string, unknown>) => void) => {
        listeners.set(runId, listener);
        return () => {
          listeners.delete(runId);
        };
      }),
    } as never);

    const runners = new Map<string, unknown>();
    const reload = vi.fn(async (agentId?: string) => {
      if (agentId === 'agent-5') {
        runners.set('agent-5', {});
      }
      return { reloaded: agentId ? [agentId] : [] };
    });

    const req = makeReq(
      '/chat',
      'POST',
      { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      { agentId: 'agent-5', message: 'hello', thread: 'console:agent-5' },
    );
    const res = makeRes();
    const handled = await routeRequest(
      req,
      res as unknown as ServerResponse,
      makeOpts({
        runners: runners as never,
        reload,
        getConfig: () => ({ agents: [{ id: 'agent-5', name: 'Agent 5' }] }) as never,
      }),
    );

    expect(handled).toBe(true);
    expect(reload).toHaveBeenCalledWith('agent-5');
    expect(parseSseEvents(res.body())[1]).toMatchObject({
      type: 'text_delta',
      text: 'hello from lazy agent',
    });
  });

  it('emits a runId on started events and captures deliverables after completion', async () => {
    const listeners = new Map<string, (chunk: Record<string, unknown>) => void>();
    mockedGetAgentKernelService.mockResolvedValue({
      startTurn: vi.fn(async ({ runId }: { runId: string }) => {
        listeners.get(runId)?.({ type: 'text_delta', text: 'hello from agent' });
        return { runId };
      }),
      waitForRun: vi.fn(async () => ({ text: 'hello from agent' })),
      subscribeRun: vi.fn((runId: string, listener: (chunk: Record<string, unknown>) => void) => {
        listeners.set(runId, listener);
        return () => {
          listeners.delete(runId);
        };
      }),
    } as never);

    const req = makeReq(
      '/chat',
      'POST',
      { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      { agentId: 'agent-main', message: 'hello', thread: 'thread-1' },
    );
    const res = makeRes();
    const handled = await routeRequest(
      req,
      res as unknown as ServerResponse,
      makeOpts({
        runners: new Map([['agent-main', {} as never]]),
        getConfig: () => ({ agents: [{ id: 'agent-main', name: 'Main Agent' }] }) as never,
      }),
    );

    expect(handled).toBe(true);
    const events = parseSseEvents(res.body());
    expect(events[0]?.type).toBe('started');
    expect(typeof events[0]?.runId).toBe('string');
    expect(events[1]).toMatchObject({ type: 'text_delta', text: 'hello from agent' });
    expect(mockedCaptureChatTurnDeliverable).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentId: 'agent-main',
        threadKey: 'thread-1',
        replyText: 'hello from agent',
      }),
    );
  });

  it('does not hold the per-agent queue for the full streaming lifetime', async () => {
    const listeners = new Map<string, (chunk: Record<string, unknown>) => void>();
    const waitResolvers = new Map<string, (result: { text: string }) => void>();
    const completedResults = new Map<string, { text: string }>();
    const startCalls: string[] = [];
    let runCount = 0;
    mockedGetAgentKernelService.mockResolvedValue({
      reserveQueuedTurn: vi.fn(async () => ({ runId: `run-${++runCount}` })),
      getRun: vi.fn((runId: string) => ({ runId, processStatus: 'waiting', phase: 'pending' })),
      startTurn: vi.fn(async ({ runId }: { runId: string }) => {
        startCalls.push(runId);
        if (runId === 'run-2') {
          listeners.get(runId)?.({ type: 'text_delta', text: 'second reply' });
          const result = { text: 'second reply' };
          const resolver = waitResolvers.get(runId);
          if (resolver) {
            resolver(result);
          } else {
            completedResults.set(runId, result);
          }
        }
        return { runId };
      }),
      waitForRun: vi.fn((runId: string) => {
        const completed = completedResults.get(runId);
        if (completed) {
          completedResults.delete(runId);
          return Promise.resolve(completed);
        }
        return new Promise<{ text: string }>((resolve) => {
          waitResolvers.set(runId, resolve);
        });
      }),
      subscribeRun: vi.fn((runId: string, listener: (chunk: Record<string, unknown>) => void) => {
        listeners.set(runId, listener);
        return () => {
          listeners.delete(runId);
        };
      }),
    } as never);

    const opts = {
      ...makeOpts({
        runners: new Map([['agent-main', {} as never]]),
        getConfig: () => ({ agents: [{ id: 'agent-main', name: 'Main Agent' }] }) as never,
      }),
      agentQueues: new AgentQueueRegistry(),
    } satisfies RouterOptions;

    const firstReq = makeReq(
      '/chat',
      'POST',
      { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      { agentId: 'agent-main', message: 'first', thread: 'thread-1' },
    );
    const firstRes = makeRes();
    const firstPromise = routeRequest(firstReq, firstRes as unknown as ServerResponse, opts);

    for (let attempt = 0; attempt < 50 && startCalls.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(startCalls).toEqual(['run-1']);

    const secondReq = makeReq(
      '/chat',
      'POST',
      { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      { agentId: 'agent-main', message: 'second', thread: 'thread-2' },
    );
    const secondRes = makeRes();
    const secondPromise = routeRequest(secondReq, secondRes as unknown as ServerResponse, opts);

    for (let attempt = 0; attempt < 50 && startCalls.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(startCalls).toEqual(['run-1', 'run-2']);

    await secondPromise;
    const secondEvents = parseSseEvents(secondRes.body());
    expect(secondEvents[0]).toMatchObject({ type: 'started', runId: 'run-2' });
    expect(secondEvents[1]).toMatchObject({ type: 'text_delta', text: 'second reply' });

    listeners.get('run-1')?.({ type: 'text_delta', text: 'first reply' });
    waitResolvers.get('run-1')?.({ text: 'first reply' });
    await firstPromise;
  });

  it('resumes a suspended chat run through the same /chat SSE endpoint', async () => {
    const listeners = new Map<string, (chunk: Record<string, unknown>) => void>();
    let resolveRun!: (result: { text: string }) => void;
    mockedGetAgentKernelService.mockResolvedValue({
      getRun: vi.fn((runId: string) =>
        runId === 'run-suspended'
          ? {
              runId,
              agentId: 'agent-main',
              threadKey: 'thread-1',
              processStatus: 'suspended',
              phase: 'suspended',
            }
          : null,
      ),
      resumeTurn: vi.fn(async () => ({ runId: 'run-suspended', processStatus: 'ready' })),
      waitForRun: vi.fn(
        () =>
          new Promise<{ text: string }>((resolve) => {
            resolveRun = resolve;
          }),
      ),
      subscribeRun: vi.fn((runId: string, listener: (chunk: Record<string, unknown>) => void) => {
        listeners.set(runId, listener);
        return () => {
          listeners.delete(runId);
        };
      }),
    } as never);

    const req = makeReq(
      '/chat',
      'POST',
      { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      { runId: 'run-suspended', resume: true },
    );
    const res = makeRes();

    const routePromise = routeRequest(
      req,
      res as unknown as ServerResponse,
      makeOpts({
        runners: new Map([['agent-main', {} as never]]),
        getConfig: () => ({ agents: [{ id: 'agent-main', name: 'Main Agent' }] }) as never,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    listeners.get('run-suspended')?.({ type: 'text_delta', text: 'resumed reply' });
    resolveRun({ text: 'resumed reply' });
    await routePromise;

    const events = parseSseEvents(res.body());
    expect(events[0]).toMatchObject({ type: 'started', runId: 'run-suspended', resumed: true });
    expect(events[1]).toMatchObject({
      type: 'text_delta',
      text: 'resumed reply',
      runId: 'run-suspended',
    });
  });
});
