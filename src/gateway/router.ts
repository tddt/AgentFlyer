import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../core/logger.js';
import type { StreamChunk } from '../core/types.js';
import { validateToken } from './auth.js';
import { buildConsoleHtml } from './console/index.js';
import type { LogBroadcaster } from './log-buffer.js';
import { type RpcContext, dispatchRpc } from './rpc.js';

const logger = createLogger('gateway:router');

export interface RouterOptions {
  authToken: string;
  rpcContext: RpcContext;
  logBroadcaster: LogBroadcaster;
  port: number;
  /**
   * Channel webhook handlers that bypass gateway auth.
   * Key = exact path (e.g. '/channels/feishu/event').
   * These are registered by the lifecycle when webhook-based channels (Feishu, QQ) are active.
   */
  webhookHandlers?: Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>;
}

/** Parse request body as JSON (resolves null on empty body). */
async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8').trim();
      if (!body) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Route an HTTP request to the appropriate handler.
 * Returns `false` if the request was not handled (let caller deal with it).
 */
export async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RouterOptions,
): Promise<boolean> {
  const url = req.url ?? '/';
  const method = req.method?.toUpperCase() ?? 'GET';

  // ── CORS: allow localhost / 127.0.0.1 origins (console dev + same-host) ─
  // localhost and 127.0.0.1 are different browser origins even on the same port.
  const origin = (req.headers['origin'] as string) ?? '';
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Vary', 'Origin');
  }
  // Handle preflight before any auth or routing logic.
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  // ── Health check (no auth) ─────────────────────────────────────────────
  if (url === '/health' && method === 'GET') {
    json(res, 200, { ok: true });
    return true;
  }

  // Browsers request favicon.ico automatically; do not require auth for this.
  if (url === '/favicon.ico' && method === 'GET') {
    res.writeHead(204, {
      'Cache-Control': 'public, max-age=86400',
    });
    res.end();
    return true;
  }

  // ── Channel webhooks (no gateway auth — channels verify their own tokens) ─
  if (opts.webhookHandlers && method === 'POST') {
    for (const [path, handler] of opts.webhookHandlers) {
      if (url === path || url.startsWith(`${path}?`)) {
        await handler(req, res);
        return true;
      }
    }
  }

  // ── Web console (token in query param — SSE cannot set headers) ────────
  // GET /console?token=<token>
  if (url.startsWith('/console') && method === 'GET') {
    const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    const queryToken = new URLSearchParams(qs).get('token') ?? '';
    const authCheck = validateToken(`Bearer ${queryToken}`, opts.authToken);
    if (!authCheck.ok) {
      json(res, 401, { error: 'Unauthorized' });
      return true;
    }
    const html = buildConsoleHtml(opts.authToken, opts.port);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
    return true;
  }

  // GET /api/logs?token=<token>  — SSE log stream
  if (url.startsWith('/api/logs') && method === 'GET') {
    const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    const queryToken = new URLSearchParams(qs).get('token') ?? '';
    const authCheck = validateToken(`Bearer ${queryToken}`, opts.authToken);
    if (!authCheck.ok) {
      json(res, 401, { error: 'Unauthorized' });
      return true;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Transfer-Encoding': 'chunked',
    });
    opts.logBroadcaster.subscribe(res);
    return true;
  }

  // ── All other routes require auth ──────────────────────────────────────
  const authResult = validateToken(req.headers.authorization, opts.authToken);
  if (!authResult.ok) {
    json(res, 401, { error: authResult.reason });
    return true;
  }

  // ── Streaming chat endpoint (SSE) ─────────────────────────────────────
  // POST /chat  body: { agentId, message, thread? }
  // Response:   text/event-stream, each event is a serialised StreamChunk.
  // Final event: data: [DONE]\n\n
  if (url === '/chat' && method === 'POST') {
    const authResult = validateToken(req.headers.authorization, opts.authToken);
    if (!authResult.ok) {
      json(res, 401, { error: authResult.reason });
      return true;
    }

    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      json(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    const { agentId, message, thread } = (body ?? {}) as {
      agentId?: string;
      message?: string;
      thread?: string;
    };
    if (!agentId || !message) {
      json(res, 400, { error: 'agentId and message are required' });
      return true;
    }
    const runner = opts.rpcContext.runners.get(agentId);
    if (!runner) {
      json(res, 404, { error: `Agent not found: ${agentId}` });
      return true;
    }

    if (thread) runner.setThread(thread);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Transfer-Encoding': 'chunked',
    });

    const sendEvent = (data: unknown): void => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const gen = runner.turn(message);
      let next = await gen.next();
      while (!next.done) {
        sendEvent(next.value as StreamChunk);
        next = await gen.next();
      }
    } catch (err) {
      logger.error('Streaming chat error', { agentId, error: String(err) });
      sendEvent({ type: 'error', error: String(err) });
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return true;
  }

  // ── JSON-RPC endpoint ──────────────────────────────────────────────────
  if (url === '/rpc' && method === 'POST') {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      json(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    if (!body || typeof body !== 'object') {
      json(res, 400, { error: 'Expected JSON object' });
      return true;
    }
    const rpcReq = body as { id?: string | number; method?: string; params?: unknown };
    if (!rpcReq.method) {
      json(res, 400, { error: 'Missing method' });
      return true;
    }
    const response = await dispatchRpc(
      {
        id: rpcReq.id ?? 0,
        method: rpcReq.method as Parameters<typeof dispatchRpc>[0]['method'],
        params: rpcReq.params,
      },
      opts.rpcContext,
    );
    json(res, 200, response);
    return true;
  }

  logger.debug('Unmatched route', { method, url });
  return false;
}
