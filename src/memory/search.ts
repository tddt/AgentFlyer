import { createLogger } from '../core/logger.js';
import { decayScore } from './decay.js';
import { type EmbedConfig, cosineSimilarity, embed } from './embed.js';
import type { MemoryEntry, MemoryStore } from './store.js';

const _logger = createLogger('memory:search');

export interface SearchResult {
  entry: MemoryEntry;
  score: number;
  method: 'bm25' | 'vector' | 'hybrid';
}

export interface SearchOptions {
  partition?: string;
  limit?: number;
  minScore?: number;
  decayEnabled?: boolean;
  halfLifeDays?: number;
}

/**
 * Hybrid search combining BM25 (FTS5) and optional vector similarity.
 * Results are de-duplicated and ranked by combined score.
 */
export async function searchMemory(
  store: MemoryStore,
  query: string,
  embedConfig: EmbedConfig,
  opts: SearchOptions = {},
): Promise<SearchResult[]> {
  const limit = opts.limit ?? 10;
  const minScore = opts.minScore ?? 0;

  // BM25 search
  const bm25Results = store.searchFts(query, opts.partition, limit * 2);

  // Vector search (best-effort — if embedding available)
  const vectorResults = await vectorSearch(store, query, embedConfig, opts.partition, limit * 2);

  // Merge and rank
  const merged = mergeAndRank(bm25Results, vectorResults, {
    decayEnabled: opts.decayEnabled ?? true,
    halfLifeDays: opts.halfLifeDays ?? 30,
    now: Date.now(),
  });

  return merged.filter((r) => r.score >= minScore).slice(0, limit);
}

async function vectorSearch(
  store: MemoryStore,
  query: string,
  embedConfig: EmbedConfig,
  partition: string | undefined,
  limit: number,
): Promise<Array<{ entry: MemoryEntry; similarity: number }>> {
  const embeddedIds = store.listEmbeddedIds();
  if (embeddedIds.length === 0) return [];

  let queryVec: Float32Array;
  try {
    queryVec = await embed(query, embedConfig);
  } catch {
    return [];
  }

  const scored: Array<{ entry: MemoryEntry; similarity: number }> = [];

  for (const id of embeddedIds) {
    const embedding = store.loadEmbedding(id);
    if (!embedding) continue;

    const entry = store.getById(id);
    if (!entry) continue;
    if (partition && entry.partition !== partition) continue;

    scored.push({ entry, similarity: cosineSimilarity(queryVec, embedding) });
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

interface MergeOpts {
  decayEnabled: boolean;
  halfLifeDays: number;
  now: number;
}

function mergeAndRank(
  bm25: MemoryEntry[],
  vector: Array<{ entry: MemoryEntry; similarity: number }>,
  opts: MergeOpts,
): SearchResult[] {
  const scoreMap = new Map<string, SearchResult>();

  // Normalise BM25 ranks into 0-1 scores
  for (const [idx, entry] of bm25.entries()) {
    const bm25Score = 1 - idx / Math.max(bm25.length, 1);
    const decay = opts.decayEnabled
      ? decayScore(1, entry.updatedAt, opts.now, opts.halfLifeDays)
      : 1;
    scoreMap.set(entry.id, { entry, score: bm25Score * decay * 0.5, method: 'bm25' });
  }

  // Add vector scores
  for (const { entry, similarity } of vector) {
    const decay = opts.decayEnabled
      ? decayScore(1, entry.updatedAt, opts.now, opts.halfLifeDays)
      : 1;
    const vecScore = similarity * decay * 0.5;
    const existing = scoreMap.get(entry.id);
    if (existing) {
      // Hybrid: combine scores
      scoreMap.set(entry.id, {
        entry,
        score: existing.score + vecScore,
        method: 'hybrid',
      });
    } else {
      scoreMap.set(entry.id, { entry, score: vecScore, method: 'vector' });
    }
  }

  const results = Array.from(scoreMap.values());
  results.sort((a, b) => b.score - a.score);
  return results;
}
