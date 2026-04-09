import { createLogger } from '../../core/logger.js';
import { McpTransportError } from '../errors.js';
import type {
  McpClient,
  McpServerConfigLike,
  McpToolCallOutput,
  McpToolManifest,
} from '../types.js';

const logger = createLogger('mcp:sse');

type JsonRpcSuccess = { jsonrpc: '2.0'; id: number; result: unknown };
type JsonRpcFailure = { jsonrpc: '2.0'; id: number; error: { code: number; message: string } };
type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

interface SseEvent {
  event: string;
  data: string;
}

function normalizeToolList(result: unknown): McpToolManifest[] {
  const tools = (result as { tools?: unknown })?.tools;
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map((tool) => {
      const candidate = tool as {
        name?: unknown;
        description?: unknown;
        inputSchema?: unknown;
      };
      if (typeof candidate.name !== 'string') {
        return null;
      }

      return {
        name: candidate.name,
        description:
          typeof candidate.description === 'string'
            ? candidate.description
            : `MCP tool ${candidate.name}`,
        inputSchema:
          typeof candidate.inputSchema === 'object' && candidate.inputSchema !== null
            ? (candidate.inputSchema as Record<string, unknown>)
            : { type: 'object', properties: {} },
      } satisfies McpToolManifest;
    })
    .filter((tool): tool is McpToolManifest => tool !== null);
}

function normalizeCallResult(result: unknown): McpToolCallOutput {
  const response = result as {
    content?: Array<{ type?: string; text?: unknown }>;
    isError?: unknown;
  };

  const chunks = Array.isArray(response.content)
    ? response.content.map((item) => {
        if (item?.type === 'text' && typeof item.text === 'string') {
          return item.text;
        }
        return JSON.stringify(item);
      })
    : [JSON.stringify(result)];

  return {
    isError: response.isError === true,
    content: chunks.join('\n').trim() || '(empty MCP result)',
  };
}

function parseSseEvents(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let rest = buffer;

  while (true) {
    const eventBoundary = rest.indexOf('\n\n');
    if (eventBoundary === -1) {
      return { events, rest };
    }

    const rawEvent = rest.slice(0, eventBoundary);
    rest = rest.slice(eventBoundary + 2);

    const lines = rawEvent.replace(/\r/g, '').split('\n');
    let event = 'message';
    const dataLines: string[] = [];

    for (const line of lines) {
      if (!line || line.startsWith(':')) {
        continue;
      }

      const separator = line.indexOf(':');
      const field = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^\s/, '');

      if (field === 'event') {
        event = value || 'message';
      } else if (field === 'data') {
        dataLines.push(value);
      }
    }

    events.push({ event, data: dataLines.join('\n') });
  }
}

class SseMcpClient implements McpClient {
  private readonly abortController = new AbortController();
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly endpointPromise: Promise<string>;
  private endpointResolve: ((value: string) => void) | null = null;
  private endpointReject: ((error: Error) => void) | null = null;
  private nextRequestId = 1;
  private closed = false;
  private readerLoop: Promise<void> | null = null;
  private endpointUrl: string | null = null;

  constructor(private readonly server: McpServerConfigLike) {
    if (!server.url) {
      throw new McpTransportError(
        `MCP sse server "${server.id}" is missing url`,
        'SSE_URL_MISSING',
        'config',
      );
    }

    this.endpointPromise = new Promise<string>((resolve, reject) => {
      this.endpointResolve = resolve;
      this.endpointReject = reject;
    });
  }

  async initialize(): Promise<void> {
    const response = await fetch(this.server.url as string, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
      },
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      throw new McpTransportError(
        `MCP SSE connect failed: HTTP ${response.status}`,
        'SSE_CONNECT_HTTP',
        'connect',
      );
    }
    if (!response.body) {
      throw new McpTransportError(
        'MCP SSE connect failed: response body is missing',
        'SSE_CONNECT_NO_BODY',
        'connect',
      );
    }

    this.readerLoop = this.consumeEventStream(response.body).catch((error) => {
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
      throw error;
    });

    const endpoint = await this.endpointPromise;
    logger.debug('MCP SSE endpoint ready', { serverId: this.server.id, endpoint });

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'AgentFlyer',
        version: 'm1',
      },
    });
    await this.notify('notifications/initialized', {});
  }

  async listTools(): Promise<McpToolManifest[]> {
    const result = await this.request('tools/list', {});
    return normalizeToolList(result);
  }

  async callTool(name: string, input: unknown): Promise<McpToolCallOutput> {
    const result = await this.request('tools/call', {
      name,
      arguments: input,
    });
    return normalizeCallResult(result);
  }

  getConnectionDetails(): string {
    return `sse stream=${this.server.url}${this.endpointUrl ? ` · endpoint=${this.endpointUrl}` : ''}`;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abortController.abort();
    this.rejectAll(new Error('MCP client closed'));
  }

  private async consumeEventStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (!this.closed) {
            throw new McpTransportError(
              'MCP SSE stream closed unexpectedly',
              'SSE_STREAM_CLOSED',
              'stream',
            );
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseEvents(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) {
          this.handleEvent(event);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleEvent(event: SseEvent): void {
    if (event.event === 'endpoint') {
      try {
        const endpoint = new URL(event.data, this.server.url).toString();
        this.endpointUrl = endpoint;
        this.endpointResolve?.(endpoint);
        this.endpointResolve = null;
        this.endpointReject = null;
      } catch (error) {
        const endpointError = new McpTransportError(
          `MCP SSE endpoint event is invalid: ${event.data}`,
          'SSE_ENDPOINT_INVALID',
          'endpoint',
          { cause: error },
        );
        this.endpointReject?.(endpointError);
        this.endpointReject = null;
        this.endpointResolve = null;
        this.rejectAll(endpointError);
      }
      return;
    }

    if (!event.data) {
      return;
    }

    const message = JSON.parse(event.data) as JsonRpcResponse | { method?: string };
    if ('id' in message && typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if ('error' in message) {
        pending.reject(new Error(message.error.message));
        return;
      }
      pending.resolve(message.result);
    }
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const requestId = this.nextRequestId++;
    const timeoutMs = this.server.timeoutMs ?? 20_000;
    const endpoint = await this.endpointPromise;

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new McpTransportError(
            `MCP request timed out: ${method}`,
            'SSE_REQUEST_TIMEOUT',
            'request',
          ),
        );
      }, timeoutMs);

      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
      });

      void fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          method,
          params,
        }),
        signal: this.abortController.signal,
      })
        .then((response) => {
          if (!response.ok) {
            throw new McpTransportError(
              `MCP SSE request failed: HTTP ${response.status}`,
              'SSE_REQUEST_HTTP',
              'request',
            );
          }
        })
        .catch((error) => {
          const pending = this.pending.get(requestId);
          if (!pending) {
            return;
          }
          this.pending.delete(requestId);
          clearTimeout(pending.timer);
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const endpoint = await this.endpointPromise;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
      }),
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      throw new McpTransportError(
        `MCP SSE notify failed: HTTP ${response.status}`,
        'SSE_NOTIFY_HTTP',
        'initialize',
      );
    }
  }

  private rejectAll(error: Error): void {
    this.endpointReject?.(error);
    this.endpointReject = null;
    this.endpointResolve = null;

    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

export async function createSseMcpClient(server: McpServerConfigLike): Promise<McpClient> {
  const client = new SseMcpClient(server);
  await client.initialize();
  return client;
}
