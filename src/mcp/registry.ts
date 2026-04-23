import { createLogger } from '../core/logger.js';
import { createMcpClient } from './client.js';
import { toMcpRuntimeError } from './errors.js';
import {
  computeMcpNextRetryAt,
  isMcpAutoRetryEligible,
  resolveMcpAutoReconnectPolicy,
} from './reconnect-policy.js';
import type {
  McpAutoReconnectPolicy,
  McpClient,
  McpHistoryRecorder,
  McpHistoryTrigger,
  McpServerConfigLike,
  McpServerHistoryRecord,
  McpServerRuntimeStatus,
  McpToolBinding,
} from './types.js';

const logger = createLogger('mcp:registry');

function toolPrefixFor(server: McpServerConfigLike): string {
  return server.toolPrefix?.trim() || `mcp_${server.id}`;
}

export class McpRegistry {
  private readonly clients = new Map<string, McpClient>();
  private readonly tools = new Map<string, McpToolBinding>();
  private readonly statuses = new Map<string, McpServerRuntimeStatus>();
  private readonly createClient: (server: McpServerConfigLike) => Promise<McpClient>;
  private readonly now: () => number;
  private readonly retryPolicy: McpAutoReconnectPolicy;
  private readonly historyRecorder: McpHistoryRecorder;
  private readonly historyTrigger: McpHistoryTrigger;

  constructor(
    private readonly servers: McpServerConfigLike[],
    deps: {
      clientFactory?: (server: McpServerConfigLike) => Promise<McpClient>;
      now?: () => number;
      retryPolicy?: Partial<McpAutoReconnectPolicy>;
      historyRecorder?: McpHistoryRecorder;
      historyTrigger?: McpHistoryTrigger;
    } = {},
  ) {
    this.createClient = deps.clientFactory ?? createMcpClient;
    this.now = deps.now ?? Date.now;
    this.retryPolicy = resolveMcpAutoReconnectPolicy(deps.retryPolicy);
    this.historyRecorder = deps.historyRecorder;
    this.historyTrigger = deps.historyTrigger ?? 'startup';
  }

  static async create(
    servers: McpServerConfigLike[],
    deps: {
      clientFactory?: (server: McpServerConfigLike) => Promise<McpClient>;
      now?: () => number;
      retryPolicy?: Partial<McpAutoReconnectPolicy>;
      historyRecorder?: McpHistoryRecorder;
      historyTrigger?: McpHistoryTrigger;
    } = {},
  ): Promise<McpRegistry> {
    const registry = new McpRegistry(servers, deps);

    for (const server of servers) {
      await registry.initializeServer(server, registry.historyTrigger);
    }

    return registry;
  }

  async refresh(
    serverId?: string,
    trigger: McpHistoryTrigger = 'manual-refresh',
  ): Promise<string[]> {
    const targets = serverId
      ? this.servers.filter((server) => server.id === serverId)
      : this.servers;

    if (targets.length === 0) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }

    for (const server of targets) {
      await this.resetServer(server.id);
      await this.initializeServer(server, trigger);
    }

    return targets.map((server) => server.id);
  }

  listTools(): McpToolBinding[] {
    return Array.from(this.tools.values()).sort((left, right) =>
      left.prefixedName.localeCompare(right.prefixedName),
    );
  }

  listServerStatus(): McpServerRuntimeStatus[] {
    return Array.from(this.statuses.values()).sort((left, right) =>
      left.serverId.localeCompare(right.serverId),
    );
  }

  async callTool(prefixedName: string, input: unknown) {
    const binding = this.tools.get(prefixedName);
    if (!binding) {
      return {
        isError: true,
        content: `Unknown MCP tool: ${prefixedName}`,
      };
    }

    const client = this.clients.get(binding.serverId);
    if (!client) {
      return {
        isError: true,
        content: `MCP server offline: ${binding.serverId}`,
      };
    }

    const timeoutMs = this.statuses.get(binding.serverId)?.timeoutMs ?? 20_000;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`MCP tool call timed out after ${timeoutMs}ms: ${prefixedName}`)),
        timeoutMs,
      ),
    );

    try {
      return await Promise.race([client.callTool(binding.originalName, input), timeoutPromise]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('MCP tool call failed', { prefixedName, error: msg });
      return { isError: true, content: msg };
    }
  }

  async close(): Promise<void> {
    await Promise.all(Array.from(this.clients.values()).map((client) => client.close()));
    this.clients.clear();
    this.tools.clear();
  }

  private baseStatus(server: McpServerConfigLike): McpServerRuntimeStatus {
    return {
      serverId: server.id,
      transport: server.transport,
      enabled: server.enabled !== false,
      toolPrefix: toolPrefixFor(server),
      approval: server.approval ?? 'inherit',
      timeoutMs: server.timeoutMs ?? 20_000,
      status: server.enabled === false ? 'disabled' : 'error',
      toolCount: 0,
      tools: [],
    };
  }

  private async initializeServer(
    server: McpServerConfigLike,
    trigger: McpHistoryTrigger,
  ): Promise<void> {
    const previousStatus = this.statuses.get(server.id);
    const refreshAt = this.now();
    this.statuses.set(server.id, {
      ...this.baseStatus(server),
      retryCount: previousStatus?.retryCount,
      lastConnectedAt: previousStatus?.lastConnectedAt,
      lastRefreshAt: refreshAt,
    });

    if (server.enabled === false) {
      this.recordHistory({
        serverId: server.id,
        transport: server.transport,
        trigger,
        outcome: 'disabled',
        timestamp: refreshAt,
        toolPrefix: toolPrefixFor(server),
        approval: server.approval ?? 'inherit',
        timeoutMs: server.timeoutMs ?? 20_000,
        toolCount: 0,
      });
      return;
    }

    try {
      const client = await this.createClient(server);
      this.clients.set(server.id, client);

      const prefix = toolPrefixFor(server);
      const allowedTools =
        server.allowTools && server.allowTools.length > 0 ? new Set(server.allowTools) : null;
      const tools = await client.listTools();
      const visibleTools: string[] = [];
      for (const tool of tools) {
        if (allowedTools && !allowedTools.has(tool.name)) {
          continue;
        }
        const prefixedName = `${prefix}_${tool.name}`;
        visibleTools.push(prefixedName);
        this.tools.set(prefixedName, {
          serverId: server.id,
          originalName: tool.name,
          prefixedName,
          description: tool.description,
          inputSchema: tool.inputSchema,
          approval: server.approval ?? 'inherit',
        });
      }
      this.statuses.set(server.id, {
        serverId: server.id,
        transport: server.transport,
        enabled: true,
        toolPrefix: prefix,
        approval: server.approval ?? 'inherit',
        timeoutMs: server.timeoutMs ?? 20_000,
        status: 'connected',
        connectionDetails: client.getConnectionDetails?.(),
        toolCount: visibleTools.length,
        tools: visibleTools.sort((left, right) => left.localeCompare(right)),
        autoRetryEligible: true,
        retryCount: 0,
        lastConnectedAt: refreshAt,
        lastRefreshAt: refreshAt,
      });
      this.recordHistory({
        serverId: server.id,
        transport: server.transport,
        trigger,
        outcome: 'connected',
        timestamp: refreshAt,
        toolPrefix: prefix,
        approval: server.approval ?? 'inherit',
        timeoutMs: server.timeoutMs ?? 20_000,
        toolCount: visibleTools.length,
        connectionDetails: client.getConnectionDetails?.(),
        autoRetryEligible: true,
        retryCount: 0,
      });
    } catch (error) {
      const runtimeError = toMcpRuntimeError(error);
      const autoRetryEligible = isMcpAutoRetryEligible(runtimeError.lastErrorCode);
      const retryCount = (previousStatus?.retryCount ?? 0) + 1;
      logger.warn('Failed to initialize MCP server', {
        serverId: server.id,
        error: runtimeError.lastError,
        errorCode: runtimeError.lastErrorCode,
        errorPhase: runtimeError.lastErrorPhase,
        autoRetryEligible,
        retryCount,
      });
      this.statuses.set(server.id, {
        ...this.baseStatus(server),
        enabled: true,
        status: 'error',
        autoRetryEligible,
        retryCount,
        nextRetryAt: autoRetryEligible
          ? computeMcpNextRetryAt(refreshAt, retryCount, this.retryPolicy)
          : undefined,
        lastConnectedAt: previousStatus?.lastConnectedAt,
        lastRefreshAt: refreshAt,
        ...runtimeError,
      });
      this.recordHistory({
        serverId: server.id,
        transport: server.transport,
        trigger,
        outcome: 'error',
        timestamp: refreshAt,
        toolPrefix: toolPrefixFor(server),
        approval: server.approval ?? 'inherit',
        timeoutMs: server.timeoutMs ?? 20_000,
        toolCount: 0,
        autoRetryEligible,
        retryCount,
        nextRetryAt: autoRetryEligible
          ? computeMcpNextRetryAt(refreshAt, retryCount, this.retryPolicy)
          : undefined,
        ...runtimeError,
      });
    }
  }

  private recordHistory(record: McpServerHistoryRecord): void {
    if (!this.historyRecorder) {
      return;
    }

    try {
      const maybePromise = this.historyRecorder(record);
      if (maybePromise && typeof (maybePromise as PromiseLike<unknown>).then === 'function') {
        void maybePromise.catch((error: unknown) => {
          logger.warn('Failed to record MCP history event', {
            serverId: record.serverId,
            error: String(error),
          });
        });
      }
    } catch (error) {
      logger.warn('Failed to record MCP history event', {
        serverId: record.serverId,
        error: String(error),
      });
    }
  }

  private async resetServer(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    this.clients.delete(serverId);
    if (client) {
      await client.close().catch(() => undefined);
    }

    for (const [toolName, tool] of this.tools) {
      if (tool.serverId === serverId) {
        this.tools.delete(toolName);
      }
    }
  }
}
