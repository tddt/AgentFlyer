/**
 * HTTP client for an already-running AgentFlyer gateway.
 * Used by the `chat` command when a gateway process is detected.
 * Connects to POST /chat (SSE streaming) and yields StreamChunk objects.
 */

import * as http from 'node:http';
import type { StreamChunk } from '../core/types.js';

export interface GatewayClientOptions {
  port: number;
  token: string;
  agentId: string;
  message: string;
  thread: string;
}

/**
 * Stream a chat turn from the running gateway.
 * Yields StreamChunk values as they arrive, resolves when [DONE] is received.
 *
 * Uses a simple push-queue: the SSE response handler enqueues chunks and
 * pings a pending Promise; the generator drains the queue on each tick.
 */
export async function* streamChatFromGateway(
  opts: GatewayClientOptions,
): AsyncGenerator<StreamChunk> {
  const body = JSON.stringify({
    agentId: opts.agentId,
    message: opts.message,
    thread: opts.thread,
  });

  // Queue shared between the http-response callback and the generator.
  const queue: StreamChunk[] = [];
  let closed = false;
  let error: Error | null = null;

  // One-shot notification: resolved when new data/end arrives.
  let notify!: () => void;
  let waitForData = new Promise<void>((r) => { notify = r; });

  const ping = (): void => {
    notify();
    waitForData = new Promise<void>((r) => { notify = r; });
  };

  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: opts.port,
      path: '/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${opts.token}`,
      },
    },
    (res) => {
      if ((res.statusCode ?? 0) !== 200) {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => {
          error = new Error(
            `Gateway /chat HTTP ${res.statusCode}: ${Buffer.concat(parts).toString().slice(0, 200)}`,
          );
          closed = true;
          ping();
        });
        return;
      }

      let buf = '';
      res.setEncoding('utf-8');

      res.on('data', (chunk: string) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') { closed = true; ping(); return; }
          try { queue.push(JSON.parse(raw) as StreamChunk); ping(); }
          catch { /* skip malformed */ }
        }
      });

      res.on('end', () => { closed = true; ping(); });
      res.on('error', (err: Error) => { error = err; closed = true; ping(); });
    },
  );

  req.on('error', (err: Error) => { error = err; closed = true; ping(); });
  req.end(body);

  // Generator loop: drain queue, wait for more, repeat until closed.
  while (!closed || queue.length > 0) {
    while (queue.length > 0) yield queue.shift()!;
    if (!closed) await waitForData;
  }

  if (error) throw error;
}

/**
 * Send a single JSON-RPC call to the running gateway and return the result.
 * Throws if the gateway returns an error response or the HTTP call fails.
 */
export async function callRpc(
  port: number,
  token: string,
  method: string,
  params?: unknown,
): Promise<unknown> {
  const body = JSON.stringify({ id: 1, method, params: params ?? {} });
  return new Promise<unknown>((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/rpc',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Bearer ${token}`,
        },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(parts).toString()) as {
              result?: unknown;
              error?: { code: number; message: string };
            };
            if (json.error) {
              reject(new Error(`RPC error ${json.error.code}: ${json.error.message}`));
            } else {
              resolve(json.result);
            }
          } catch (e) {
            reject(e);
          }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

