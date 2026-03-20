import { createLogger } from '../../../../core/logger.js';
import type { SearchProvider, SearchResponse, SearchOptions } from './provider.js';

const logger = createLogger('search:tavily');

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

interface TavilyResponse {
  results: TavilyResult[];
  answer?: string;
}

export interface TavilyProviderOptions {
  apiKey: string;
  maxResults?: number;
  /** 'basic' is faster, 'advanced' is more thorough. */
  searchDepth?: 'basic' | 'advanced';
}

export class TavilyProvider implements SearchProvider {
  readonly name = 'tavily';
  private readonly opts: Required<TavilyProviderOptions>;

  constructor(opts: TavilyProviderOptions) {
    this.opts = {
      maxResults: 5,
      searchDepth: 'basic',
      ...opts,
    };
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    const numResults = Math.min((options?.maxResults ?? this.opts.maxResults), 10);
    const depth = (options?.['searchDepth'] as string | undefined) ?? this.opts.searchDepth;

    logger.debug('Tavily search', { query, numResults, depth });

    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: numResults,
        search_depth: depth,
        include_answer: true,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      throw new Error(`Tavily API ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as TavilyResponse;
    return {
      provider: this.name,
      answer: data.answer,
      results: data.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
      })),
    };
  }
}
