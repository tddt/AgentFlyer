import { createLogger } from '../../../../core/logger.js';
import type { SearchOptions, SearchProvider, SearchResponse } from './provider.js';

const logger = createLogger('search:serpapi');

interface SerpApiOrganicResult {
  title: string;
  link: string;
  snippet: string;
}

interface SerpApiResponse {
  organic_results?: SerpApiOrganicResult[];
  answer_box?: { answer?: string; snippet?: string };
}

export interface SerpApiProviderOptions {
  apiKey: string;
  maxResults?: number;
  /** Search engine: 'google' | 'baidu' | 'bing' | 'duckduckgo'. Default: 'google'. */
  engine?: string;
  /** Google language code, e.g. 'zh-cn'. Default: 'zh-cn'. */
  hl?: string;
  /** Google country code, e.g. 'cn'. Default: 'cn'. */
  gl?: string;
}

export class SerpApiProvider implements SearchProvider {
  readonly name = 'serpapi';
  private readonly opts: Required<SerpApiProviderOptions>;

  constructor(opts: SerpApiProviderOptions) {
    this.opts = { maxResults: 5, engine: 'google', hl: 'zh-cn', gl: 'cn', ...opts };
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    const numResults = Math.min(options?.maxResults ?? this.opts.maxResults, 100);
    const engine = (options?.engine as string | undefined) ?? this.opts.engine;

    logger.debug('SerpApi search', { query, numResults, engine });

    const url = new URL('https://serpapi.com/search');
    url.searchParams.set('q', query);
    url.searchParams.set('api_key', this.opts.apiKey);
    url.searchParams.set('engine', engine);
    url.searchParams.set('num', String(numResults));
    url.searchParams.set('hl', this.opts.hl);
    url.searchParams.set('gl', this.opts.gl);
    url.searchParams.set('output', 'json');

    const response = await fetch(url.toString());

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      throw new Error(`SerpApi ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as SerpApiResponse;
    const answer = data.answer_box?.answer ?? data.answer_box?.snippet;
    return {
      provider: this.name,
      answer,
      results: (data.organic_results ?? []).slice(0, numResults).map((r) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet,
      })),
    };
  }
}
