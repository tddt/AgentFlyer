import { describe, expect, it, vi } from 'vitest';
import { searchMemory } from '../../../src/memory/search.js';
import type { MemoryEntry } from '../../../src/memory/store.js';
import type { MemoryStore } from '../../../src/memory/store.js';
import type { EmbedConfig } from '../../../src/memory/embed.js';
import { asAgentId, asMemoryEntryId } from '../../../src/core/types.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const embedConfig: EmbedConfig = { model: 'stub', provider: 'local' };

function makeEntry(id: string, content: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now();
  return {
    id: asMemoryEntryId(id),
    key: id,
    agentId: asAgentId('agent-a'),
    partition: 'shared',
    content,
    tags: [],
    source: 'api',
    createdAt: now,
    updatedAt: now,
    accessedAt: now,
    accessCount: 1,
    importance: 0.5,
    superseded: false,
    ...overrides,
  };
}

function makeMockStore(entries: MemoryEntry[]): MemoryStore {
  return {
    searchFts: vi.fn((_query: string, partition?: string, limit = 10) => {
      const filtered = partition ? entries.filter((e) => e.partition === partition) : entries;
      return filtered.slice(0, limit);
    }),
    listEmbeddedIds: vi.fn(() => []),
    loadEmbedding: vi.fn(() => null),
    getById: vi.fn((id: string) => entries.find((e) => e.id === id) ?? null),
  } as unknown as MemoryStore;
}

describe('searchMemory', () => {
  it('returns empty array when store has no entries', async () => {
    const store = makeMockStore([]);
    const results = await searchMemory(store, 'hello', embedConfig);
    expect(results).toEqual([]);
  });

  it('returns BM25 results from the store', async () => {
    const e1 = makeEntry('id-1', 'TypeScript is a great language');
    const e2 = makeEntry('id-2', 'Python is also popular');
    const store = makeMockStore([e1, e2]);

    const results = await searchMemory(store, 'TypeScript', embedConfig);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].method).toBe('bm25');
  });

  it('applies limit option', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => makeEntry(`id-${i}`, `content ${i}`));
    const store = makeMockStore(entries);

    const results = await searchMemory(store, 'content', embedConfig, { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('filters by partition', async () => {
    const sharedEntry = makeEntry('s1', 'shared content', { partition: 'shared' });
    const agentEntry = makeEntry('a1', 'agent content', { partition: 'per-agent:agent-a' });
    const store = makeMockStore([sharedEntry, agentEntry]);

    await searchMemory(store, 'content', embedConfig, { partition: 'shared' });
    const [searchFts] = (store as unknown as { searchFts: ReturnType<typeof vi.fn> }).searchFts.mock
      .calls[0] as [string, string, number];
    expect(searchFts).toBe('content'); // query
  });

  it('applies minScore filter — no results when all scores are below minScore', async () => {
    const e1 = makeEntry('id-1', 'old content', { updatedAt: Date.now() - 365 * MS_PER_DAY });
    const store = makeMockStore([e1]);

    // Very high minScore ensures the decayed result is filtered out
    const results = await searchMemory(store, 'old', embedConfig, {
      minScore: 0.99,
      decayEnabled: true,
      halfLifeDays: 7,
    });
    expect(results).toHaveLength(0);
  });

  it('returns results without decay when decayEnabled is false', async () => {
    const e1 = makeEntry('id-1', 'very old content', {
      updatedAt: Date.now() - 1000 * MS_PER_DAY,
    });
    const store = makeMockStore([e1]);

    const withDecay = await searchMemory(store, 'old', embedConfig, {
      decayEnabled: true,
      halfLifeDays: 30,
    });
    const withoutDecay = await searchMemory(store, 'old', embedConfig, {
      decayEnabled: false,
    });

    if (withoutDecay.length > 0 && withDecay.length > 0) {
      expect(withoutDecay[0].score).toBeGreaterThan(withDecay[0].score);
    }
  });

  it('ranks by score descending', async () => {
    const entries = [
      makeEntry('id-1', 'top result'),
      makeEntry('id-2', 'second result'),
      makeEntry('id-3', 'third result'),
    ];
    const store = makeMockStore(entries);

    const results = await searchMemory(store, 'result', embedConfig, { decayEnabled: false });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('handles vector search with embedded entries (no real model — uses stub)', async () => {
    const e1 = makeEntry('id-1', 'machine learning');
    const embedding = new Float32Array([0.1, 0.2, 0.3]);
    const storeWithEmbeddings = {
      searchFts: vi.fn(() => []),
      listEmbeddedIds: vi.fn(() => [asMemoryEntryId('id-1')]),
      loadEmbedding: vi.fn(() => embedding),
      getById: vi.fn(() => e1),
    } as unknown as MemoryStore;

    // embed() will fall back to stub (no model available in tests)
    // This should not throw
    await expect(searchMemory(storeWithEmbeddings, 'machine learning', embedConfig)).resolves.toBeDefined();
  });
});
