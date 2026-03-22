import { createLogger } from '../../../core/logger.js';
import type { RegisteredTool } from '../registry.js';
import type { MemoryStore } from '../../../memory/store.js';
import type { MemoryConfig } from '../../../core/config/schema.js';

const logger = createLogger('tools:memory');

export function createMemoryTools(store: MemoryStore, config: MemoryConfig): RegisteredTool[] {
  const searchTool: RegisteredTool = {
    category: 'builtin',
    definition: {
      name: 'memory_search',
      description:
        'Search your long-term memory for relevant information. ' +
        'Returns entries ranked by relevance and recency.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language search query' },
          limit: { type: 'number', description: 'Max number of results (default 5, max 20)' },
          partition: {
            type: 'string',
            description: 'Memory partition to search (default "shared")',
          },
        },
        required: ['query'],
      },
    },
    async handler(input) {
      if (!config.enabled) {
        return { isError: false, content: 'Memory is disabled in configuration.' };
      }
      const { query, limit = 5, partition = 'shared' } = input as {
        query: string;
        limit?: number;
        partition?: string;
      };
      const cap = Math.min(Math.max(1, limit), 20);
      try {
        const results = store.searchFts(query, partition, cap);
        if (results.length === 0) {
          return { isError: false, content: 'No memory entries found.' };
        }
        const text = results
          .map((r, i) => `[${i + 1}] (${r.key}) ${r.content}`)
          .join('\n\n');
        return { isError: false, content: text };
      } catch (err) {
        logger.error('memory_search failed', { error: String(err) });
        return { isError: true, content: `Memory search error: ${String(err)}` };
      }
    },
  };

  const writeTool: RegisteredTool = {
    category: 'builtin',
    definition: {
      name: 'memory_write',
      description:
        'Save a new entry to your long-term memory. ' +
        'Use this to remember important facts, decisions, or context for future sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'Short identifier (snake_case, e.g. "user_pref_language")',
          },
          body: { type: 'string', description: 'The content to remember' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags for filtering',
          },
          partition: {
            type: 'string',
            description: 'Memory partition (default "shared")',
          },
        },
        required: ['key', 'body'],
      },
    },
    async handler(input) {
      if (!config.enabled) {
        return { isError: false, content: 'Memory is disabled in configuration.' };
      }
      const { key, body, tags = [], partition = 'shared' } = input as {
        key: string;
        body: string;
        tags?: string[];
        partition?: string;
      };
      try {
        store.upsert({
          key,
          content: body,
          tags,
          partition,
          agentId: 'agent',
          source: 'agent',
          importance: 0.5,
          superseded: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          accessedAt: Date.now(),
          accessCount: 0,
        });
        return { isError: false, content: `Memory saved: ${key}` };
      } catch (err) {
        logger.error('memory_write failed', { error: String(err) });
        return { isError: true, content: `Memory write error: ${String(err)}` };
      }
    },
  };

  const deleteTool: RegisteredTool = {
    category: 'builtin',
    definition: {
      name: 'memory_delete',
      description: 'Delete a memory entry by its key.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key of the memory entry to delete' },
          partition: { type: 'string', description: 'Memory partition (default "shared")' },
        },
        required: ['key'],
      },
    },
    async handler(input) {
      if (!config.enabled) {
        return { isError: false, content: 'Memory is disabled.' };
      }
      const { key, partition = 'shared' } = input as { key: string; partition?: string };
      try {
        const deleted = store.deleteByKey(key, partition);
        return {
          isError: false,
          content: deleted ? `Deleted memory: ${key}` : `No entry found with key: ${key}`,
        };
      } catch (err) {
        return { isError: true, content: `Memory delete error: ${String(err)}` };
      }
    },
  };

  return [searchTool, writeTool, deleteTool];
}
