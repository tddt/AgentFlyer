import { describe, expect, it } from 'vitest';
import { adaptMcpRegistryToTools } from './adapter.js';
import { McpTransportError } from './errors.js';
import { computeMcpNextRetryAt } from './reconnect-policy.js';
import { McpRegistry } from './registry.js';
import type { McpClient } from './types.js';

describe('McpRegistry', () => {
  it('builds prefixed tool bindings from enabled servers', async () => {
    const now = 1_700_000_000_000;
    const registry = await McpRegistry.create(
      [
        {
          id: 'github',
          transport: 'stdio',
          enabled: true,
          command: 'ignored',
          toolPrefix: 'mcp_github',
        },
      ],
      {
        now: () => now,
        clientFactory: async (): Promise<McpClient> => ({
          async listTools() {
            return [
              {
                name: 'search_repos',
                description: 'Search repositories',
                inputSchema: {
                  type: 'object',
                  properties: {
                    query: { type: 'string' },
                  },
                  required: ['query'],
                },
              },
            ];
          },
          async callTool() {
            return { isError: false, content: 'ok' };
          },
          getConnectionDetails() {
            return 'stdio command=ignored';
          },
          async close() {},
        }),
      },
    );

    expect(registry.listTools()).toEqual([
      {
        serverId: 'github',
        originalName: 'search_repos',
        prefixedName: 'mcp_github_search_repos',
        description: 'Search repositories',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
        approval: 'inherit',
      },
    ]);

    expect(registry.listServerStatus()).toEqual([
      {
        serverId: 'github',
        transport: 'stdio',
        enabled: true,
        toolPrefix: 'mcp_github',
        approval: 'inherit',
        timeoutMs: 20_000,
        status: 'connected',
        connectionDetails: 'stdio command=ignored',
        toolCount: 1,
        tools: ['mcp_github_search_repos'],
        autoRetryEligible: true,
        retryCount: 0,
        lastConnectedAt: now,
        lastRefreshAt: now,
      },
    ]);

    await registry.close();
  });

  it('routes adapted tool calls back through the registry', async () => {
    const registry = await McpRegistry.create(
      [
        {
          id: 'github',
          transport: 'stdio',
          enabled: true,
          command: 'ignored',
        },
      ],
      {
        clientFactory: async (): Promise<McpClient> => ({
          async listTools() {
            return [
              {
                name: 'search_repos',
                description: 'Search repositories',
                inputSchema: { type: 'object', properties: {} },
              },
            ];
          },
          async callTool(name, input) {
            return {
              isError: false,
              content: `${name}:${JSON.stringify(input)}`,
            };
          },
          getConnectionDetails() {
            return 'stdio command=ignored';
          },
          async close() {},
        }),
      },
    );

    const adapted = adaptMcpRegistryToTools(registry);
    expect(adapted).toHaveLength(1);
    const firstTool = adapted[0];
    if (!firstTool) {
      throw new Error('Expected adapted MCP tool');
    }

    expect(firstTool.approvalMode).toBe('inherit');

    const result = await firstTool.invoke({ query: 'agentflyer' });
    expect(result).toEqual({
      isError: false,
      content: 'search_repos:{"query":"agentflyer"}',
    });

    await registry.close();
  });

  it('captures typed transport errors in runtime status', async () => {
    const now = 1_700_000_100_000;
    const registry = await McpRegistry.create(
      [
        {
          id: 'filesystem',
          transport: 'sse',
          enabled: true,
          url: 'http://127.0.0.1:3100/sse',
        },
      ],
      {
        now: () => now,
        clientFactory: async (): Promise<McpClient> => {
          throw new McpTransportError(
            'MCP SSE connect failed: HTTP 503',
            'SSE_CONNECT_HTTP',
            'connect',
          );
        },
      },
    );

    expect(registry.listServerStatus()).toEqual([
      {
        serverId: 'filesystem',
        transport: 'sse',
        enabled: true,
        toolPrefix: 'mcp_filesystem',
        approval: 'inherit',
        timeoutMs: 20_000,
        status: 'error',
        toolCount: 0,
        tools: [],
        lastError: 'MCP SSE connect failed: HTTP 503',
        lastErrorCode: 'SSE_CONNECT_HTTP',
        lastErrorPhase: 'connect',
        autoRetryEligible: true,
        retryCount: 1,
        nextRetryAt: computeMcpNextRetryAt(now, 1),
        lastRefreshAt: now,
      },
    ]);

    await registry.close();
  });

  it('refreshes one MCP server without rebuilding unrelated server state', async () => {
    const calls: string[] = [];
    const registry = await McpRegistry.create(
      [
        {
          id: 'github',
          transport: 'stdio',
          enabled: true,
          command: 'ignored',
        },
        {
          id: 'filesystem',
          transport: 'sse',
          enabled: true,
          url: 'http://127.0.0.1:3100/sse',
        },
      ],
      {
        clientFactory: async (server): Promise<McpClient> => {
          calls.push(server.id);
          return {
            async listTools() {
              return [
                {
                  name: server.id === 'github' ? 'search_repos' : 'read_file',
                  description: server.id,
                  inputSchema: { type: 'object', properties: {} },
                },
              ];
            },
            async callTool() {
              return { isError: false, content: 'ok' };
            },
            async close() {},
          };
        },
      },
    );

    calls.length = 0;
    await expect(registry.refresh('filesystem')).resolves.toEqual(['filesystem']);
    expect(calls).toEqual(['filesystem']);
    expect(registry.listTools().map((tool) => tool.prefixedName)).toEqual([
      'mcp_filesystem_read_file',
      'mcp_github_search_repos',
    ]);

    await registry.close();
  });

  it('treats an empty allowTools list as unrestricted', async () => {
    const registry = await McpRegistry.create(
      [
        {
          id: 'bing',
          transport: 'stdio',
          enabled: true,
          command: 'ignored',
          allowTools: [],
        },
      ],
      {
        clientFactory: async (): Promise<McpClient> => ({
          async listTools() {
            return [
              {
                name: 'bing_search',
                description: 'Search Bing',
                inputSchema: { type: 'object', properties: {} },
              },
              {
                name: 'crawl_webpage',
                description: 'Crawl a webpage',
                inputSchema: { type: 'object', properties: {} },
              },
            ];
          },
          async callTool() {
            return { isError: false, content: 'ok' };
          },
          async close() {},
        }),
      },
    );

    expect(registry.listTools().map((tool) => tool.prefixedName)).toEqual([
      'mcp_bing_bing_search',
      'mcp_bing_crawl_webpage',
    ]);
    expect(registry.listServerStatus()).toEqual([
      expect.objectContaining({
        serverId: 'bing',
        status: 'connected',
        toolCount: 2,
        tools: ['mcp_bing_bing_search', 'mcp_bing_crawl_webpage'],
      }),
    ]);

    await registry.close();
  });

  it('increments retry metadata across repeated failures and resets it on success', async () => {
    let now = 1_700_000_200_000;
    let attempts = 0;
    const registry = await McpRegistry.create(
      [
        {
          id: 'filesystem',
          transport: 'sse',
          enabled: true,
          url: 'http://127.0.0.1:3100/sse',
        },
      ],
      {
        now: () => now,
        clientFactory: async (): Promise<McpClient> => {
          attempts += 1;
          if (attempts < 3) {
            throw new McpTransportError(
              'MCP SSE connect failed: HTTP 503',
              'SSE_CONNECT_HTTP',
              'connect',
            );
          }

          return {
            async listTools() {
              return [
                {
                  name: 'read_file',
                  description: 'read file',
                  inputSchema: { type: 'object', properties: {} },
                },
              ];
            },
            async callTool() {
              return { isError: false, content: 'ok' };
            },
            async close() {},
          };
        },
      },
    );

    expect(registry.listServerStatus()[0]?.retryCount).toBe(1);
    expect(registry.listServerStatus()[0]?.autoRetryEligible).toBe(true);
    expect(registry.listServerStatus()[0]?.nextRetryAt).toBe(computeMcpNextRetryAt(now, 1));

    now += 30_000;
    await registry.refresh('filesystem');
    expect(registry.listServerStatus()[0]?.retryCount).toBe(2);
    expect(registry.listServerStatus()[0]?.nextRetryAt).toBe(computeMcpNextRetryAt(now, 2));

    now += 60_000;
    await registry.refresh('filesystem');
    expect(registry.listServerStatus()).toEqual([
      expect.objectContaining({
        serverId: 'filesystem',
        status: 'connected',
        retryCount: 0,
        lastConnectedAt: now,
        lastRefreshAt: now,
      }),
    ]);

    await registry.close();
  });

  it('emits trigger-aware history records for failures and recovery', async () => {
    const events: Array<{
      serverId: string;
      trigger: string;
      outcome: string;
      timestamp: number;
      retryCount?: number;
      lastErrorCode?: string;
      toolCount: number;
    }> = [];
    let now = 1_700_000_300_000;
    let shouldFail = true;

    const registry = await McpRegistry.create(
      [
        {
          id: 'filesystem',
          transport: 'sse',
          enabled: true,
          url: 'http://127.0.0.1:3100/sse',
        },
      ],
      {
        now: () => now,
        historyTrigger: 'startup',
        historyRecorder: (record) => {
          events.push({
            serverId: record.serverId,
            trigger: record.trigger,
            outcome: record.outcome,
            timestamp: record.timestamp,
            retryCount: record.retryCount,
            lastErrorCode: record.lastErrorCode,
            toolCount: record.toolCount,
          });
        },
        clientFactory: async (): Promise<McpClient> => {
          if (shouldFail) {
            throw new McpTransportError(
              'MCP SSE connect failed: HTTP 503',
              'SSE_CONNECT_HTTP',
              'connect',
            );
          }

          return {
            async listTools() {
              return [
                {
                  name: 'read_file',
                  description: 'read file',
                  inputSchema: { type: 'object', properties: {} },
                },
              ];
            },
            async callTool() {
              return { isError: false, content: 'ok' };
            },
            async close() {},
          };
        },
      },
    );

    now += 5_000;
    shouldFail = false;
    await registry.refresh('filesystem', 'auto-retry');

    expect(events).toEqual([
      {
        serverId: 'filesystem',
        trigger: 'startup',
        outcome: 'error',
        timestamp: 1_700_000_300_000,
        retryCount: 1,
        lastErrorCode: 'SSE_CONNECT_HTTP',
        toolCount: 0,
      },
      {
        serverId: 'filesystem',
        trigger: 'auto-retry',
        outcome: 'connected',
        timestamp: 1_700_000_305_000,
        retryCount: 0,
        lastErrorCode: undefined,
        toolCount: 1,
      },
    ]);

    await registry.close();
  });

  it('disables automatic retry for non-recoverable configuration errors', async () => {
    const now = 1_700_000_300_000;
    const registry = await McpRegistry.create(
      [
        {
          id: 'github',
          transport: 'stdio',
          enabled: true,
        },
      ],
      {
        now: () => now,
      },
    );

    expect(registry.listServerStatus()).toEqual([
      {
        serverId: 'github',
        transport: 'stdio',
        enabled: true,
        toolPrefix: 'mcp_github',
        approval: 'inherit',
        timeoutMs: 20_000,
        status: 'error',
        toolCount: 0,
        tools: [],
        lastError: 'MCP stdio server "github" is missing command',
        lastErrorCode: 'STDIO_COMMAND_MISSING',
        lastErrorPhase: 'config',
        autoRetryEligible: false,
        retryCount: 1,
        lastRefreshAt: now,
      },
    ]);

    await registry.close();
  });

  it('uses configured retry policy when scheduling the next automatic reconnect', async () => {
    const now = 1_700_000_400_000;
    const registry = await McpRegistry.create(
      [
        {
          id: 'filesystem',
          transport: 'sse',
          enabled: true,
          url: 'http://127.0.0.1:3100/sse',
        },
      ],
      {
        now: () => now,
        retryPolicy: {
          baseDelayMs: 60_000,
          maxDelayMs: 60_000,
        },
        clientFactory: async (): Promise<McpClient> => {
          throw new McpTransportError(
            'MCP SSE connect failed: HTTP 503',
            'SSE_CONNECT_HTTP',
            'connect',
          );
        },
      },
    );

    expect(registry.listServerStatus()).toEqual([
      expect.objectContaining({
        serverId: 'filesystem',
        autoRetryEligible: true,
        retryCount: 1,
        nextRetryAt: now + 60_000,
      }),
    ]);

    await registry.close();
  });
});
