import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadStats } from '../agent/stats.js';
import { createLogger } from '../core/logger.js';
import { summarizeSessionErrors } from '../core/session/error-stats.js';
import { type StreamChunk, asAgentId, parseSessionKey } from '../core/types.js';
import { getAgentKernelService } from './agent-kernel.js';
import type { AgentQueueRegistry } from './agent-queue.js';
import { validateToken } from './auth.js';
import { captureChatTurnDeliverable } from './chat-deliverables.js';
import { buildConsoleHtml } from './console/index.js';
import type { InboxBroadcaster } from './inbox-broadcaster.js';
import type { IntentRouter } from './intent-router.js';
import type { LogBroadcaster } from './log-buffer.js';
import { type RpcContext, dispatchRpc } from './rpc.js';
import { getWorkflowKernelService } from './workflow-backend.js';
import type { RunStreamEvent } from './workflow-kernel.js';

const logger = createLogger('gateway:router');

export interface RouterOptions {
  authToken: string;
  rpcContext: RpcContext;
  agentQueues?: AgentQueueRegistry;
  logBroadcaster: LogBroadcaster;
  inboxBroadcaster?: InboxBroadcaster;
  port: number;
  /**
   * Channel webhook handlers that bypass gateway auth.
   * Key = exact path (e.g. '/channels/feishu/event').
   * These are registered by the lifecycle when webhook-based channels (Feishu, QQ) are active.
   */
  webhookHandlers?: Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>;
  /**
   * Optional intent router. When present and the request body omits `agentId`,
   * the router applies regex rules against the message text to pick an agent
   * automatically (E6 intent-aware routing).
   */
  intentRouter?: IntentRouter;
}

function normalizeMention(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function resolveMentionedAgent(
  message: string,
  agents: Array<{ id: string; name?: string; mentionAliases?: string[] }>,
): { agentId?: string; text: string } {
  const trimmed = message.trim();
  const match = /^@([^\s]+)\s+([\s\S]*)$/u.exec(trimmed);
  if (!match) {
    return { text: trimmed };
  }
  const mention = match[1]?.trim() ?? '';
  const nextText = match[2]?.trim() ?? '';
  if (!mention || !nextText) {
    return { text: trimmed };
  }
  const normalizedMention = normalizeMention(mention);
  const matchedAgent = agents.find((item) => {
    if (normalizeMention(item.id) === normalizedMention) {
      return true;
    }
    if (item.name && normalizeMention(item.name) === normalizedMention) {
      return true;
    }
    return (item.mentionAliases ?? []).some(
      (alias) => normalizeMention(alias) === normalizedMention,
    );
  });
  return matchedAgent ? { agentId: matchedAgent.id, text: nextText } : { text: trimmed };
}

function isLikelyTextMime(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/javascript' ||
    mimeType === 'application/xml' ||
    mimeType === 'image/svg+xml'
  );
}

function responseContentType(mimeType: string): string {
  return isLikelyTextMime(mimeType) ? `${mimeType}; charset=utf-8` : mimeType;
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

function queryTokenFromUrl(url: string): string {
  const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  return new URLSearchParams(qs).get('token') ?? '';
}

function writeUnauthorized(res: ServerResponse): void {
  json(res, 401, { error: 'Unauthorized' });
}

async function streamContentItem(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RouterOptions,
  itemId: string,
): Promise<boolean> {
  const item = await opts.rpcContext.contentStore.get(itemId);
  if (!item) {
    json(res, 404, { error: 'Content item not found' });
    return true;
  }

  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(item.filePath);
  } catch {
    json(res, 404, { error: 'Content file not found on disk' });
    return true;
  }

  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileStat.size}` });
      res.end();
      return true;
    }

    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : fileStat.size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end >= fileStat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileStat.size}` });
      res.end();
      return true;
    }

    res.writeHead(206, {
      'Content-Type': responseContentType(item.mimeType),
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${fileStat.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Disposition': `inline; filename="${encodeURIComponent(item.name)}"`,
    });
    createReadStream(item.filePath, { start, end }).pipe(res);
    return true;
  }

  res.writeHead(200, {
    'Content-Type': responseContentType(item.mimeType),
    'Content-Length': fileStat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Disposition': `inline; filename="${encodeURIComponent(item.name)}"`,
  });
  createReadStream(item.filePath).pipe(res);
  return true;
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
  const origin = (req.headers.origin as string) ?? '';
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
    const queryToken = queryTokenFromUrl(url);
    const authCheck = validateToken(`Bearer ${queryToken}`, opts.authToken);
    if (!authCheck.ok) {
      writeUnauthorized(res);
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
    const queryToken = queryTokenFromUrl(url);
    const authCheck = validateToken(`Bearer ${queryToken}`, opts.authToken);
    if (!authCheck.ok) {
      writeUnauthorized(res);
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

  // GET /api/workflow-stream?runId=<runId>&token=<token>  — SSE workflow step token stream
  if (url.startsWith('/api/workflow-stream') && method === 'GET') {
    const queryToken = queryTokenFromUrl(url);
    const authCheck = validateToken(`Bearer ${queryToken}`, opts.authToken);
    if (!authCheck.ok) {
      writeUnauthorized(res);
      return true;
    }
    const parsedUrl = new URL(url, 'http://localhost');
    const runId = parsedUrl.searchParams.get('runId');
    if (!runId) {
      json(res, 400, { error: 'runId is required' });
      return true;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Transfer-Encoding': 'chunked',
    });

    const service = await getWorkflowKernelService(opts.rpcContext);
    const run = service.getRun(runId);
    if (!run || run.status !== 'running') {
      res.write('data: {"done":true}\n\n');
      res.end();
      return true;
    }

    const unsubscribe = service.subscribeToStreamOutput(runId, (event: RunStreamEvent) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        unsubscribe();
      }
    });

    // Poll for run completion to send the done event
    const checkDone = setInterval(() => {
      const current = service.getRun(runId);
      if (!current || current.status !== 'running') {
        clearInterval(checkDone);
        try {
          res.write('data: {"done":true}\n\n');
          res.end();
        } catch {
          // Client already disconnected
        }
      }
    }, 500);

    res.on('close', () => {
      unsubscribe();
      clearInterval(checkDone);
    });

    return true;
  }

  if (url.startsWith('/api/inbox') && method === 'GET') {
    const queryToken = queryTokenFromUrl(url);
    const authCheck = validateToken(`Bearer ${queryToken}`, opts.authToken);
    if (!authCheck.ok) {
      writeUnauthorized(res);
      return true;
    }
    if (!opts.inboxBroadcaster) {
      json(res, 503, { error: 'Inbox stream unavailable' });
      return true;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Transfer-Encoding': 'chunked',
    });
    opts.inboxBroadcaster.subscribe(res);
    return true;
  }

  // GET /api/content/<itemId>?token=<token>  — browser-safe media/file preview
  if (url.startsWith('/api/content/') && method === 'GET') {
    const itemId = url.slice('/api/content/'.length).split('?')[0] ?? '';
    const queryToken = queryTokenFromUrl(url);
    const authCheck = validateToken(`Bearer ${queryToken}`, opts.authToken);
    if (!authCheck.ok) {
      writeUnauthorized(res);
      return true;
    }
    if (!itemId) {
      json(res, 400, { error: 'Missing content item id' });
      return true;
    }
    return streamContentItem(req, res, opts, decodeURIComponent(itemId));
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
    const {
      agentId: rawAgentId,
      message,
      thread,
    } = (body ?? {}) as {
      agentId?: string;
      message?: string;
      thread?: string;
    };
    if (!message) {
      json(res, 400, { error: 'message is required' });
      return true;
    }

    // E6: if agentId omitted, use intent router (falls back to 'main' if no rule matches).
    const mention = resolveMentionedAgent(
      message,
      opts.rpcContext
        .getConfig()
        .agents.filter((agent) => opts.rpcContext.runners.has(agent.id))
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          mentionAliases: agent.mentionAliases,
        })),
    );
    const inboundMessage = mention.text;
    let agentId = mention.agentId ?? rawAgentId;
    if (!agentId && opts.intentRouter) {
      const routed = opts.intentRouter.routeWithFallback(inboundMessage);
      agentId = opts.rpcContext.runners.has(routed.agent) ? routed.agent : routed.fallback;
      logger.debug('Intent router selected agent', {
        agentId,
        message: inboundMessage.slice(0, 60),
      });
    }
    if (!agentId) {
      json(res, 400, { error: 'agentId is required' });
      return true;
    }

    const runner = opts.rpcContext.runners.get(agentId);
    if (!runner) {
      json(res, 404, { error: `Agent not found: ${agentId}` });
      return true;
    }

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
      const startedAt = Date.now();
      const agentKernel = await getAgentKernelService(opts.rpcContext);
      const executeStream = async (): Promise<void> => {
        let replyText = '';
        const gen = agentKernel.streamTurn({
          agentId,
          userMessage: inboundMessage,
          threadKey: thread,
        });
        let next = await gen.next();
        let finalResult = next.done ? next.value : null;
        while (!next.done) {
          const chunk = next.value as StreamChunk;
          if (chunk.type === 'text_delta' && chunk.text) {
            replyText += chunk.text;
          }
          sendEvent(chunk);
          next = await gen.next();
          if (next.done) {
            finalResult = next.value;
          }
        }
        const resolvedThreadKey =
          finalResult && parseSessionKey(finalResult.sessionKey)?.threadKey
            ? (parseSessionKey(finalResult.sessionKey)?.threadKey as unknown as string)
            : (thread ?? '');
        if (replyText.trim() && opts.inboxBroadcaster) {
          opts.inboxBroadcaster.publish({
            kind: 'agent_reply',
            agentId,
            threadKey: resolvedThreadKey,
            channelId: 'chat',
            title: `${agentId} replied`,
            text: replyText.trim(),
          });
        }
        await captureChatTurnDeliverable(opts.rpcContext, {
          agentId,
          threadKey: resolvedThreadKey,
          channelId: 'chat',
          replyText,
          startedAt,
        });
      };

      const agentQueue = opts.agentQueues?.for(agentId);
      if (agentQueue) {
        await agentQueue.enqueue(executeStream, {
          onQueued: ({ position }) => {
            sendEvent({ type: 'queued', position });
          },
          onStarted: ({ wasQueued, queueDepth }) => {
            if (wasQueued) {
              sendEvent({ type: 'started', queueDepth });
            }
          },
        });
      } else {
        await executeStream();
      }
    } catch (err) {
      logger.error('Streaming chat error', { agentId, error: String(err) });
      sendEvent({ type: 'error', message: String(err) });
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

  // ── OpenAI-compatible model list ──────────────────────────────────────
  // GET /v1/models
  if (url === '/v1/models' && method === 'GET') {
    const models = Array.from(opts.rpcContext.runners.keys()).map((agentId) => ({
      id: agentId,
      object: 'model',
      // RATIONALE: No real creation time — use current Unix time as a stable placeholder per call.
      created: Math.floor(Date.now() / 1000),
      owned_by: 'agentflyer',
    }));
    json(res, 200, { object: 'list', data: models });
    return true;
  }

  // ── OpenAI-compatible chat completions ────────────────────────────────
  // POST /v1/chat/completions  body: { model, messages, stream? }
  // `model` maps to agentId; last user message is used as the prompt.
  if (url === '/v1/chat/completions' && method === 'POST') {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      json(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request_error' } });
      return true;
    }
    const {
      model,
      messages,
      stream: wantStream,
    } = (body ?? {}) as {
      model?: string;
      messages?: Array<{ role: string; content: string }>;
      stream?: boolean;
    };

    if (!model) {
      json(res, 400, { error: { message: 'model is required', type: 'invalid_request_error' } });
      return true;
    }
    if (!messages || messages.length === 0) {
      json(res, 400, {
        error: { message: 'messages is required', type: 'invalid_request_error' },
      });
      return true;
    }

    const userMessages = messages.filter((m) => m.role === 'user');
    const lastUserMsg = userMessages[userMessages.length - 1];
    if (!lastUserMsg) {
      json(res, 400, {
        error: { message: 'No user message found in messages', type: 'invalid_request_error' },
      });
      return true;
    }

    const ocRunner = opts.rpcContext.runners.get(model);
    if (!ocRunner) {
      json(res, 404, {
        error: { message: `Model not found: ${model}`, type: 'invalid_request_error' },
      });
      return true;
    }

    const completionId = `chatcmpl-${Date.now()}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const agentKernel = await getAgentKernelService(opts.rpcContext);

    if (wantStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Transfer-Encoding': 'chunked',
      });

      const sendOcChunk = (content: string, finishReason: string | null = null): void => {
        const chunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created: createdAt,
          model,
          choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      };

      try {
        const gen = agentKernel.streamTurn({
          agentId: model,
          userMessage: lastUserMsg.content,
        });
        let next = await gen.next();
        while (!next.done) {
          const chunk = next.value as StreamChunk;
          if (chunk.type === 'text_delta') sendOcChunk(chunk.text);
          next = await gen.next();
        }
      } catch (err) {
        logger.error('OpenAI compat stream error', { model, error: String(err) });
      }
      sendOcChunk('', 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const parts: string[] = [];
      try {
        const result = await agentKernel.executeTurn({
          agentId: model,
          userMessage: lastUserMsg.content,
        });
        parts.push(result.text);
      } catch (err) {
        logger.error('OpenAI compat chat error', { model, error: String(err) });
        json(res, 500, { error: { message: String(err), type: 'server_error' } });
        return true;
      }
      json(res, 200, {
        id: completionId,
        object: 'chat.completion',
        created: createdAt,
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: parts.join('') },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
    return true;
  }

  // ── Webhook trigger ───────────────────────────────────────────────────
  // POST /hooks/trigger  body: { agentId, message }
  // Uses gateway bearer-token auth (already validated above).
  if (url === '/hooks/trigger' && method === 'POST') {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      json(res, 400, { error: 'Invalid JSON' });
      return true;
    }
    const { agentId: hookAgentId, message: hookMessage } = (body ?? {}) as {
      agentId?: string;
      message?: string;
    };
    if (!hookAgentId || !hookMessage) {
      json(res, 400, { error: 'agentId and message are required' });
      return true;
    }
    const hookRunner = opts.rpcContext.runners.get(hookAgentId);
    if (!hookRunner) {
      json(res, 404, { error: `Agent not found: ${hookAgentId}` });
      return true;
    }
    try {
      const agentKernel = await getAgentKernelService(opts.rpcContext);
      const result = await agentKernel.executeTurn({
        agentId: hookAgentId,
        userMessage: hookMessage,
      });
      json(res, 200, { ok: true, agentId: hookAgentId, response: result.text });
      return true;
    } catch (err) {
      logger.error('Webhook trigger error', { agentId: hookAgentId, error: String(err) });
      json(res, 500, { error: String(err) });
      return true;
    }
  }

  // ── Token usage stats ─────────────────────────────────────────────────
  // GET /api/stats[?agentId=<id>&days=<n>]
  if (url.startsWith('/api/stats') && method === 'GET') {
    const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    const agentIdParam = params.get('agentId');
    const agentId = agentIdParam?.trim() ? asAgentId(agentIdParam) : undefined;
    const days = Math.max(1, Number(params.get('days') ?? '30') || 30);
    const stats = await loadStats(opts.rpcContext.dataDir, agentId, days);
    const sessions = await opts.rpcContext.metaStore.listAll();
    const errors = summarizeSessionErrors(sessions, Math.min(days, 14));
    json(res, 200, { ok: true, stats, errors });
    return true;
  }

  logger.debug('Unmatched route', { method, url });
  return false;
}
