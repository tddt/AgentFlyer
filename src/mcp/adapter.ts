import type { ToolCallResult } from '../core/types.js';
import type { McpRegistry } from './registry.js';
import type { AdaptedTool } from './types.js';

export function adaptMcpRegistryToTools(registry: McpRegistry): AdaptedTool[] {
  return registry.listTools().map((tool) => ({
    definition: {
      name: tool.prefixedName,
      description: tool.description,
      inputSchema: tool.inputSchema,
    },
    approvalMode: tool.approval,
    invoke: async (input: unknown): Promise<ToolCallResult> => {
      return await registry.callTool(tool.prefixedName, input);
    },
    metadata: {
      category: 'mcp',
      serverId: tool.serverId,
      originalName: tool.originalName,
    },
  }));
}
