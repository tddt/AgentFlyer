import { createLogger } from '../../../../core/logger.js';
import type { SearchOptions, SearchProvider, SearchResponse } from './provider.js';

const logger = createLogger('search:bing');

interface BingWebPage {
  name: string;
  url: string;
  snippet: string;
}

interface BingResponse {
  webPages?: { value: BingWebPage[] };
}

export interface BingProviderOptions {
  /** Azure Cognitive Services Bing Search v7 API key. */
  apiKey: string;
  maxResults?: number;
  /** BCP-47 market code, e.g. 'zh-CN', 'en-US'. Default: 'zh-CN'. */
  market?: string;
}

export class BingProvider implements SearchProvider {
  readonly name = 'bing';
  private readonly opts: Required<BingProviderOptions>;

  constructor(opts: BingProviderOptions) {
    this.opts = { maxResults: 5, market: 'zh-CN', ...opts };
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    const count = Math.min(options?.maxResults ?? this.opts.maxResults, 50);
    const market = (options?.market as string | undefined) ?? this.opts.market;

    logger.debug('Bing search', { query, count, market });

    const url = new URL('https://api.bing.microsoft.com/v7.0/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(count));
    url.searchParams.set('mkt', market);
    url.searchParams.set('responseFilter', 'Webpages');

    const response = await fetch(url.toString(), {
      headers: { 'Ocp-Apim-Subscription-Key': this.opts.apiKey },
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      throw new Error(`Bing API ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as BingResponse;
    return {
      provider: this.name,
      results: (data.webPages?.value ?? []).map((p) => ({
        title: p.name,
        url: p.url,
        snippet: p.snippet,
      })),
    };
  }
}
