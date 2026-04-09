import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStdioMcpClient } from './stdio.js';

const tempDirs: string[] = [];

async function createTempScript(name: string, source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentflyer-mcp-stdio-'));
  tempDirs.push(dir);
  const filePath = join(dir, name);
  await writeFile(filePath, source, 'utf8');
  return filePath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('createStdioMcpClient', () => {
  it('classifies missing command config errors with stable code and phase', async () => {
    await expect(
      createStdioMcpClient({
        id: 'filesystem',
        transport: 'stdio',
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({
      name: 'McpTransportError',
      message: 'MCP stdio server "filesystem" is missing command',
      code: 'STDIO_COMMAND_MISSING',
      phase: 'config',
    });
  });

  it('classifies request timeouts with stable code and phase', async () => {
    const scriptPath = await createTempScript(
      'stdio-timeout.js',
      'process.stdin.resume(); setTimeout(() => {}, 1000);\n',
    );

    await expect(
      createStdioMcpClient({
        id: 'filesystem',
        transport: 'stdio',
        command: 'node',
        args: [scriptPath],
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({
      name: 'McpTransportError',
      message: 'MCP request timed out: initialize',
      code: 'STDIO_REQUEST_TIMEOUT',
      phase: 'request',
    });
  });

  it('connects to newline-delimited MCP stdio servers', async () => {
    const scriptPath = await createTempScript(
      'stdio-json-lines.js',
      [
        "const { createInterface } = require('node:readline');",
        "const rl = createInterface({ input: process.stdin });",
        'rl.on(\'line\', (line) => {',
        '  const payload = JSON.parse(line);',
        "  if (payload.method === 'initialize' && payload.id) {",
        "    if (payload.params?.protocolVersion !== '2025-11-25') {",
        "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: { code: -32602, message: 'unexpected protocol version' } }) + '\\n');",
        '      return;',
        '    }',
        "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1.0.0' } } }) + '\\n');",
        '  }',
        '});',
      ].join('\n'),
    );

    const client = await createStdioMcpClient({
      id: 'fixture',
      transport: 'stdio',
      command: 'node',
      args: [scriptPath],
      timeoutMs: 200,
    });

    await expect(client.close()).resolves.toBeUndefined();
  });

  it('classifies invalid stdio frames with stable code and phase', async () => {
    const scriptPath = await createTempScript(
      'stdio-invalid-frame.js',
      "process.stdout.write('not json\\n'); process.stdin.resume(); setTimeout(() => {}, 1000);\n",
    );

    await expect(
      createStdioMcpClient({
        id: 'filesystem',
        transport: 'stdio',
        command: 'node',
        args: [scriptPath],
        timeoutMs: 200,
      }),
    ).rejects.toMatchObject({
      name: 'McpTransportError',
      message: 'Invalid MCP stdio JSON message',
      code: 'STDIO_FRAME_INVALID',
      phase: 'stream',
    });
  });
});
