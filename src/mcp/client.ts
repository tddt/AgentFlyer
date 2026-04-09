import { createLogger } from '../core/logger.js';
import { McpTransportError } from './errors.js';
import { createSseMcpClient } from './transports/sse.js';
import { createStdioMcpClient } from './transports/stdio.js';
import type { McpClient, McpServerConfigLike } from './types.js';

const logger = createLogger('mcp:client');

export async function createMcpClient(server: McpServerConfigLike): Promise<McpClient> {
  switch (server.transport) {
    case 'stdio':
      return await createStdioMcpClient(server);
    case 'sse':
      return await createSseMcpClient(server);
    default:
      logger.warn('Skipping unknown MCP transport', {
        serverId: server.id,
        transport: server.transport,
      });
      throw new McpTransportError(
        `Unknown MCP transport: ${String(server.transport)}`,
        'UNKNOWN_TRANSPORT',
        'transport',
      );
  }
}
