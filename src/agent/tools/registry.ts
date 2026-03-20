import { createLogger } from '../../core/logger.js';
import type { ToolDefinition, ToolCallResult } from '../../core/types.js';

const logger = createLogger('tools:registry');

export type ToolHandler = (input: unknown) => Promise<ToolCallResult>;

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
  /** Category for grouping (e.g. 'builtin', 'skill', 'mesh'). */
  category: string;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    this.tools.set(tool.definition.name, tool);
    logger.debug('Registered tool', { name: tool.definition.name, category: tool.category });
  }

  registerMany(tools: RegisteredTool[]): void {
    for (const t of tools) this.register(t);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /** Execute a tool by name. Returns an error result if the tool is not found. */
  async execute(name: string, input: unknown): Promise<ToolCallResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { isError: true, content: `Unknown tool: ${name}` };
    }
    try {
      return await tool.handler(input);
    } catch (err) {
      logger.error('Tool execution failed', { name, error: String(err) });
      return { isError: true, content: `Tool error: ${String(err)}` };
    }
  }

  list(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }
}
