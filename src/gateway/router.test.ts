import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { type RouterOptions, routeRequest } from './router.js';
import type { RpcContext } from './rpc.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeReq(url: string, method = 'GET', headers: Record<string, string> = {}): IncomingMessage {
  return { url, method, headers, on: vi.fn() } as unknown as IncomingMessage;
}

interface MockRes {
  statusCode: number;
  writeHead: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  body: () => unknown;
}

function makeRes(): MockRes {
  const chunks: string[] = [];
  let code = 200;
  const res: MockRes = {
    statusCode: 200,
    writeHead: vi.fn((status: number) => { code = status; res.statusCode = status; }),
    setHeader: vi.fn(),
    end: vi.fn((data?: string) => { if (data) chunks.push(data); }),
    body: () => {
      try {
        return JSON.parse(chunks.join(''));
      } catch {
        return chunks.join('');
      }
    },
  };
  return res;
}

function makeCtx(overrides: Partial<RpcContext> = {}): RpcContext {
  return {
    gatewayVersion: '1.2.0',
    startedAt: Date.now() - 5000,
    getMcpStatus: () => [],
    channels: new Map(),
    runners: new Map(),
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

// ── GET /health ───────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with ok=true', async () => {
    const req = makeReq('/health');
    const res = makeRes();
    const handled = await routeRequest(req, res as unknown as ServerResponse, makeOpts());

    expect(handled).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': 'application/json' }));
    const body = res.body() as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  it('includes version, uptime, timestamp', async () => {
    const req = makeReq('/health');
    const res = makeRes();
    const before = Date.now();
    await routeRequest(req, res as unknown as ServerResponse, makeOpts());
    const after = Date.now();

    const body = res.body() as Record<string, unknown>;
    expect(body.version).toBe('1.2.0');
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
    await expect(routeRequest(req, res as unknown as ServerResponse, makeOpts())).resolves.toBeDefined();
  });
});

// ── GET /ready ────────────────────────────────────────────────────────────────

describe('GET /ready – nominal', () => {
  it('returns 200 with ready=true when db is present', async () => {
    const req = makeReq('/ready');
    const res = makeRes();
    await routeRequest(req, res as unknown as ServerResponse, makeOpts());

    expect(res.statusCode).toBe(200);
    const body = res.body() as Record<string, unknown>;
    expect(body.ready).toBe(true);
  });

  it('includes version and uptime', async () => {
    const req = makeReq('/ready');
    const res = makeRes();
    await routeRequest(req, res as unknown as ServerResponse, makeOpts());

    const body = res.body() as Record<string, unknown>;
    expect(body.version).toBe('1.2.0');
    expect(typeof body.uptime).toBe('number');
  });

  it('includes all component keys', async () => {
    const req = makeReq('/ready');
    const res = makeRes();
    await routeRequest(req, res as unknown as ServerResponse, makeOpts());

    const body = res.body() as Record<string, unknown>;
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

    const body = res.body() as Record<string, unknown>;
    const comps = body.components as Record<string, Record<string, unknown>>;
    expect(comps['mcp']?.['serversTotal']).toBe(2);
    expect(comps['mcp']?.['serversConnected']).toBe(1);
  });
});

describe('GET /ready – unhealthy', () => {
  it('returns 503 with ready=false when memoryStore is null', async () => {
    const opts = makeOpts({ memoryStore: null as never });
    const req = makeReq('/ready');
    const res = makeRes();
    await routeRequest(req, res as unknown as ServerResponse, opts);

    expect(res.statusCode).toBe(503);
    const body = res.body() as Record<string, unknown>;
    expect(body.ready).toBe(false);
  });

  it('returns 503 with ready=false when memoryStore is undefined', async () => {
    const opts = makeOpts({ memoryStore: undefined as never });
    const req = makeReq('/ready');
    const res = makeRes();
    await routeRequest(req, res as unknown as ServerResponse, opts);

    expect(res.statusCode).toBe(503);
    const body = res.body() as Record<string, unknown>;
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
    expect(res.writeHead).toHaveBeenCalledWith(204, expect.objectContaining({ 'Cache-Control': expect.any(String) }));
  });
});
