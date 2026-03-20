/** Unified search result returned by all providers. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Normalized response from any search provider. */
export interface SearchResponse {
  provider: string;
  results: SearchResult[];
  /** AI-generated answer / summary (only some providers, e.g. Tavily). */
  answer?: string;
}

export interface SearchOptions {
  maxResults?: number;
  /** Provider-specific extra parameters (passthrough). */
  [key: string]: unknown;
}

/** All search providers implement this interface. */
export interface SearchProvider {
  readonly name: string;
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
}

/** Format a SearchResponse into readable markdown text for the agent. */
export function formatSearchResponse(resp: SearchResponse): string {
  const lines: string[] = [];

  if (resp.answer) {
    lines.push(`**Summary (${resp.provider}):** ${resp.answer}`, '');
  }

  for (const [i, r] of resp.results.entries()) {
    lines.push(`[${i + 1}] **${r.title}**`);
    lines.push(`    URL: ${r.url}`);
    if (r.snippet) {
      lines.push(`    ${r.snippet.slice(0, 300).replace(/\n/g, ' ')}`);
    }
    lines.push('');
  }

  return lines.length ? lines.join('\n') : 'No results found.';
}
