import { createLogger } from '../../../core/logger.js';
import type { RegisteredTool } from '../registry.js';
import { BingProvider, type BingProviderOptions } from './search-providers/bing.js';
import {
  DuckDuckGoProvider,
  type DuckDuckGoProviderOptions,
} from './search-providers/duckduckgo.js';
import type { SearchProvider } from './search-providers/provider.js';
import { formatSearchResponse } from './search-providers/provider.js';
import { SerpApiProvider, type SerpApiProviderOptions } from './search-providers/serpapi.js';
import { TavilyProvider, type TavilyProviderOptions } from './search-providers/tavily.js';

export type { SearchProvider };
export { TavilyProvider, BingProvider, SerpApiProvider, DuckDuckGoProvider };
export type {
  TavilyProviderOptions,
  BingProviderOptions,
  SerpApiProviderOptions,
  DuckDuckGoProviderOptions,
};

const logger = createLogger('tools:web-search');

export interface WebSearchToolOptions {
  /**
   * Ordered list of providers. The first one is the default.
   * If a provider name is given in the tool call it routes there;
   * otherwise the first provider is used.
   */
  providers: SearchProvider[];
  /** Default max results when caller does not specify. */
  maxResults?: number;
}

export function createWebSearchTool(opts: WebSearchToolOptions): RegisteredTool {
  const { providers, maxResults = 5 } = opts;

  if (providers.length === 0) {
    throw new Error('createWebSearchTool: at least one provider is required');
  }
  const firstProvider = providers[0];
  if (!firstProvider) {
    throw new Error('createWebSearchTool: default provider is missing');
  }
  const defaultProvider: SearchProvider = firstProvider;

  const providerNames = providers.map((p) => p.name);

  function resolveProvider(name?: string): SearchProvider {
    if (!name) return defaultProvider;
    const found = providers.find((p) => p.name === name);
    if (!found) {
      logger.warn('Unknown search provider requested, using default', {
        requested: name,
        available: providerNames,
      });
      return defaultProvider;
    }
    return found;
  }

  function resolveProviders(name?: string): SearchProvider[] {
    if (name) return [resolveProvider(name)];
    return providers;
  }

  return {
    category: 'builtin',
    definition: {
      name: 'web_search',
      description: `Search the web and return relevant results with titles, URLs, and content snippets. Available providers: ${providerNames.join(', ')}. Use this to find up-to-date information, news, documentation, or any topic that requires internet access.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query string',
          },
          provider: {
            type: 'string',
            description: `Search provider to use. One of: ${providerNames.join(', ')}. Defaults to "${providerNames[0]}".`,
          },
          max_results: {
            type: 'number',
            description: `Maximum number of results to return (default ${maxResults})`,
          },
        },
        required: ['query'],
      },
    },
    async handler(input) {
      const {
        query,
        provider: providerName,
        max_results,
      } = input as {
        query: string;
        provider?: string;
        max_results?: number;
      };

      const numResults = max_results ?? maxResults;
      const candidates = resolveProviders(providerName);

      logger.info('Web search', {
        query,
        provider: providerName ?? candidates[0]?.name,
        candidates: candidates.map((p) => p.name),
        numResults,
      });

      const errors: string[] = [];
      for (const provider of candidates) {
        try {
          const resp = await provider.search(query, { maxResults: numResults });
          return { isError: false, content: formatSearchResponse(resp) };
        } catch (err) {
          const message = String(err);
          errors.push(`${provider.name}: ${message}`);
          logger.error('Web search failed', { provider: provider.name, error: message });
          if (providerName) {
            return { isError: true, content: `Web search error (${provider.name}): ${message}` };
          }
        }
      }

      return {
        isError: true,
        content: `Web search failed for all providers: ${errors.join(' | ')}`,
      };
    },
  };
}
