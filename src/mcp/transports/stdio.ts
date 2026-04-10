import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createLogger } from '../../core/logger.js';
import { McpTransportError } from '../errors.js';
import type {
  McpClient,
  McpServerConfigLike,
  McpToolCallOutput,
  McpToolManifest,
} from '../types.js';

const logger = createLogger('mcp:stdio');
const MCP_LATEST_PROTOCOL_VERSION = '2025-11-25';

const DEFAULT_INHERITED_ENV_VARS =
  process.platform === 'win32'
    ? [
        'APPDATA',
        'HOMEDRIVE',
        'HOMEPATH',
        'LOCALAPPDATA',
        'PATH',
        'PROCESSOR_ARCHITECTURE',
        'SYSTEMDRIVE',
        'SYSTEMROOT',
        'TEMP',
        'USERNAME',
        'USERPROFILE',
        'PROGRAMFILES',
      ]
    : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];

function getDefaultSpawnEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of DEFAULT_INHERITED_ENV_VARS) {
    const value = process.env[key];
    if (value === undefined || value.startsWith('()')) {
      continue;
    }
    env[key] = value;
  }

  return env;
}

type JsonRpcSuccess = { jsonrpc: '2.0'; id: number; result: unknown };
type JsonRpcFailure = { jsonrpc: '2.0'; id: number; error: { code: number; message: string } };
type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

function toStdioFrameError(error: unknown): McpTransportError {
  if (error instanceof McpTransportError) {
    return error;
  }

  return new McpTransportError(
    error instanceof Error ? error.message : String(error),
    'STDIO_FRAME_INVALID',
    'stream',
    { cause: error },
  );
}

function encodeMessage(payload: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
}

function extractFrames(buffer: Buffer): { frames: string[]; rest: Buffer } {
  const frames: string[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf(0x0a, offset);
    if (lineEnd === -1) break;

    const line = buffer.toString('utf8', offset, lineEnd).replace(/\r$/, '');
    if (line.trim().length > 0) {
      frames.push(line);
    }
    offset = lineEnd + 1;
  }

  return { frames, rest: buffer.subarray(offset) };
}

function parseResponseFrame(frame: string): JsonRpcResponse | { method?: string } {
  try {
    return JSON.parse(frame) as JsonRpcResponse | { method?: string };
  } catch (error) {
    throw new McpTransportError('Invalid MCP stdio JSON message', 'STDIO_FRAME_INVALID', 'stream', {
      cause: error,
    });
  }
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

class StdioMcpClient implements McpClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly started: Promise<void>;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly stderrLines: string[] = [];
  private nextRequestId = 1;
  private stdoutBuffer: Buffer = Buffer.alloc(0);
  private closed = false;
  private fatalStreamError: Error | null = null;

  constructor(private readonly server: McpServerConfigLike) {
    if (!server.command) {
      throw new McpTransportError(
        `MCP stdio server "${server.id}" is missing command`,
        'STDIO_COMMAND_MISSING',
        'config',
      );
    }

    this.process = spawn(server.command, server.args ?? [], {
      stdio: 'pipe',
      shell: false,
      windowsHide: process.platform === 'win32',
      cwd: server.cwd,
      env: {
        ...getDefaultSpawnEnvironment(),
        ...(server.env ?? {}),
      },
    });

    this.started = new Promise((resolve, reject) => {
      this.process.once('spawn', () => resolve());
      this.process.once('error', (error) => {
        reject(
          new McpTransportError(
            error instanceof Error ? error.message : String(error),
            'STDIO_PROCESS_EXIT',
            'stream',
            { cause: error },
          ),
        );
      });
    });

    this.process.stdout.on('data', (chunk: Buffer) => {
      try {
        this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
        const { frames, rest } = extractFrames(this.stdoutBuffer);
        this.stdoutBuffer = rest;
        for (const frame of frames) {
          this.handleResponse(frame);
        }
      } catch (error) {
        this.fatalStreamError = toStdioFrameError(error);
        this.rejectAll(this.fatalStreamError);
      }
    });

    this.process.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (!text) return;
      this.stderrLines.push(text);
      if (this.stderrLines.length > 20) {
        this.stderrLines.shift();
      }
    });

    this.process.once('exit', (code, signal) => {
      if (this.closed) return;
      const detail = this.stderrLines.at(-1);
      this.rejectAll(
        new McpTransportError(
          `MCP stdio server exited (code=${String(code)}, signal=${String(signal)})${detail ? `: ${detail}` : ''}`,
          'STDIO_PROCESS_EXIT',
          'stream',
        ),
      );
    });
  }

  async initialize(): Promise<void> {
    await this.started;
    await this.request('initialize', {
      protocolVersion: MCP_LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'AgentFlyer',
        version: 'm1',
      },
    });
    this.notify('notifications/initialized', {});
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
    const args = this.server.args?.length ? ` ${this.server.args.join(' ')}` : '';
    return `stdio pid=${this.process.pid ?? 'unknown'} · command=${this.server.command}${args}`;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectAll(new Error('MCP client closed'));
    if (!this.process.killed) {
      this.process.kill();
    }
  }

  private handleResponse(frame: string): void {
    const message = parseResponseFrame(frame);
    if ('id' in message && typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if ('error' in message) {
        pending.reject(new Error(message.error.message));
        return;
      }
      pending.resolve(message.result);
    }
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    if (this.fatalStreamError) {
      throw this.fatalStreamError;
    }

    const requestId = this.nextRequestId++;
    const timeoutMs = this.server.timeoutMs ?? 20_000;

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new McpTransportError(
            `MCP request timed out: ${method}`,
            'STDIO_REQUEST_TIMEOUT',
            'request',
          ),
        );
      }, timeoutMs);

      this.pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      logger.debug('MCP stdio request', {
        serverId: this.server.id,
        method,
        requestId,
      });
      this.process.stdin.write(
        encodeMessage({
          jsonrpc: '2.0',
          id: requestId,
          method,
          params,
        }),
      );
    });
  }

  private notify(method: string, params: unknown): void {
    this.process.stdin.write(
      encodeMessage({
        jsonrpc: '2.0',
        method,
        params,
      }),
    );
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

export async function createStdioMcpClient(server: McpServerConfigLike): Promise<McpClient> {
  const client = new StdioMcpClient(server);
  await client.initialize();
  return client;
}
