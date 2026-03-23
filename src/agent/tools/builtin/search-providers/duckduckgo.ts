import { createLogger } from '../../../../core/logger.js';
import type { SearchOptions, SearchProvider, SearchResponse } from './provider.js';

const logger = createLogger('search:duckduckgo');

// DDG Instant Answers API — free, no key required.
// Provides zero-click / featured snippet results.
// For full web results, falls back to HTML scraping of lite.duckduckgo.com.

interface DdgInstantResult {
  Text: string;
  FirstURL: string;
}

interface DdgInstantResponse {
  AbstractText?: string;
  AbstractURL?: string;
  AbstractSource?: string;
  RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: DdgInstantResult[] }>;
}

export interface DuckDuckGoProviderOptions {
  maxResults?: number;
  /** DDG region code, e.g. 'cn-zh', 'us-en'. Default: 'cn-zh'. */
  region?: string;
}

export class DuckDuckGoProvider implements SearchProvider {
  readonly name = 'duckduckgo';
  private readonly opts: Required<DuckDuckGoProviderOptions>;

  constructor(opts: DuckDuckGoProviderOptions = {}) {
    this.opts = { maxResults: 5, region: 'cn-zh', ...opts };
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    const numResults = options?.maxResults ?? this.opts.maxResults;

    logger.debug('DuckDuckGo search', { query, numResults });

    // Step 1: Instant Answers API for featured snippet + related topics
    const iaUrl = new URL('https://api.duckduckgo.com/');
    iaUrl.searchParams.set('q', query);
    iaUrl.searchParams.set('format', 'json');
    iaUrl.searchParams.set('no_html', '1');
    iaUrl.searchParams.set('skip_disambig', '1');
    iaUrl.searchParams.set('kl', this.opts.region);

    const iaResp = await fetch(iaUrl.toString(), {
      headers: { 'User-Agent': 'AgentFlyer/0.1 (search tool)' },
    });

    if (!iaResp.ok) {
      throw new Error(`DuckDuckGo API ${iaResp.status}: ${iaResp.statusText}`);
    }

    const data = (await iaResp.json()) as DdgInstantResponse;

    const results: Array<{ title: string; url: string; snippet: string }> = [];

    // Extract abstract as first result
    if (data.AbstractText && data.AbstractURL) {
      results.push({
        title: data.AbstractSource ?? 'Wikipedia',
        url: data.AbstractURL,
        snippet: data.AbstractText,
      });
    }

    // Related topics
    for (const topic of data.RelatedTopics ?? []) {
      if (results.length >= numResults) break;
      if (topic.FirstURL && topic.Text) {
        results.push({
          title: topic.Text.split(' - ')[0] ?? topic.Text,
          url: topic.FirstURL,
          snippet: topic.Text,
        });
      }
      // Nested topics
      for (const sub of topic.Topics ?? []) {
        if (results.length >= numResults) break;
        if (sub.FirstURL && sub.Text) {
          results.push({
            title: sub.Text.split(' - ')[0] ?? sub.Text,
            url: sub.FirstURL,
            snippet: sub.Text,
          });
        }
      }
    }

    const _answer = data.AbstractText ? undefined : undefined; // only use as result, not summary

    return {
      provider: this.name,
      answer: data.AbstractText ?? undefined,
      results: results.slice(0, numResults),
    };
  }
}
