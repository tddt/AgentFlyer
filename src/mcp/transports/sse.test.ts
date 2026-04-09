import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpTransportError } from '../errors.js';
import { createSseMcpClient } from './sse.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('createSseMcpClient', () => {
  it('connects to the SSE endpoint and serves tools/list and tools/call', async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encoder = new TextEncoder();

    function emitSse(event: string, data: unknown): void {
      streamController?.enqueue(
        encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      );
    }

    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (method === 'GET') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            controller.enqueue(encoder.encode('event: endpoint\ndata: /messages?session=test\n\n'));
          },
          cancel() {
            streamController = null;
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
          },
        });
      }

      if (method === 'POST' && url.endsWith('/messages?session=test')) {
        const payload = JSON.parse(String(init?.body)) as {
          id?: number;
          method?: string;
        };

        if (payload.method === 'initialize' && payload.id) {
          queueMicrotask(() => {
            emitSse('message', {
              jsonrpc: '2.0',
              id: payload.id,
              result: { serverInfo: { name: 'mock-sse' } },
            });
          });
        }

        if (payload.method === 'tools/list' && payload.id) {
          queueMicrotask(() => {
            emitSse('message', {
              jsonrpc: '2.0',
              id: payload.id,
              result: {
                tools: [
                  {
                    name: 'search_docs',
                    description: 'Search docs',
                    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
                  },
                ],
              },
            });
          });
        }

        if (payload.method === 'tools/call' && payload.id) {
          queueMicrotask(() => {
            emitSse('message', {
              jsonrpc: '2.0',
              id: payload.id,
              result: {
                content: [{ type: 'text', text: 'sse ok' }],
              },
            });
          });
        }

        return new Response(null, { status: 202 });
      }

      throw new Error(`Unexpected fetch call: ${method} ${url}`);
    }) as typeof fetch;

    const client = await createSseMcpClient({
      id: 'remote-docs',
      transport: 'sse',
      url: 'http://127.0.0.1:3100/sse',
      timeoutMs: 1_000,
    });

    await expect(client.listTools()).resolves.toEqual([
      {
        name: 'search_docs',
        description: 'Search docs',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ]);

    await expect(client.callTool('search_docs', { query: 'agentflyer' })).resolves.toEqual({
      isError: false,
      content: 'sse ok',
    });

    await client.close();
  });

  it('classifies HTTP connect failures with stable code and phase', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch;

    await expect(
      createSseMcpClient({
        id: 'remote-docs',
        transport: 'sse',
        url: 'http://127.0.0.1:3100/sse',
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      name: 'McpTransportError',
      message: 'MCP SSE connect failed: HTTP 503',
      code: 'SSE_CONNECT_HTTP',
      phase: 'connect',
    } satisfies Partial<McpTransportError>);
  });
});
