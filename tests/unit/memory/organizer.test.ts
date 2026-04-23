import { describe, expect, it, vi } from 'vitest';
import { MemoryOrganizer } from '../../../src/memory/organizer.js';
import type { LLMProvider } from '../../../src/agent/llm/provider.js';
import type { MemoryStore } from '../../../src/memory/store.js';
import type { MemoryEntry, MemoryEntryId } from '../../../src/core/types.js';

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'entry-1' as MemoryEntryId,
    key: 'test-key',
    agentId: 'agent-1' as never,
    partition: 'episodic',
    content: 'Some memory content from a conversation.',
    tags: [],
    source: 'test',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    accessedAt: Date.now(),
    accessCount: 1,
    importance: 0.5,
    superseded: false,
    ...overrides,
  };
}

function makeMockStore(entries: MemoryEntry[] = []): MemoryStore {
  return {
    listRecent: vi.fn().mockReturnValue(entries),
    upsert: vi.fn().mockReturnValue({ ...makeEntry(), id: 'new-entry' as MemoryEntryId }),
    markSuperseded: vi.fn(),
    getById: vi.fn(),
    searchFts: vi.fn().mockReturnValue([]),
    listEmbeddedIds: vi.fn().mockReturnValue([]),
    loadEmbedding: vi.fn().mockReturnValue(null),
    saveEmbedding: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
  } as unknown as MemoryStore;
}

function makeMockLlm(response: string): LLMProvider {
  return {
    run: vi.fn().mockReturnValue(
      (async function* () {
        yield { type: 'text_delta', text: response };
      })(),
    ),
  } as unknown as LLMProvider;
}

describe('MemoryOrganizer', () => {
  it('does not organize on the first 19 turns (below threshold)', async () => {
    const store = makeMockStore();
    const llm = makeMockLlm('A summary.');
    const organizer = new MemoryOrganizer(store, llm, 'agent-1' as never);

    for (let i = 0; i < 19; i++) {
      await organizer.maybeOrganize();
    }

    expect(store.listRecent).not.toHaveBeenCalled();
  });

  it('triggers organization on the 20th turn', async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ id: `entry-${i}` as MemoryEntryId }),
    );
    const store = makeMockStore(entries);
    const llm = makeMockLlm('Organized summary.');
    const organizer = new MemoryOrganizer(store, llm, 'agent-1' as never);

    for (let i = 0; i < 20; i++) {
      await organizer.maybeOrganize();
    }

    expect(store.listRecent).toHaveBeenCalled();
  });

  it('skips when fewer than 3 episodic entries', async () => {
    const entries = [makeEntry(), makeEntry({ id: 'e2' as MemoryEntryId })];
    const store = makeMockStore(entries);
    const llm = makeMockLlm('summary');
    const organizer = new MemoryOrganizer(store, llm, 'agent-1' as never);

    await organizer.organize();

    expect(llm.run).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('skips superseded entries', async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ id: `e${i}` as MemoryEntryId, superseded: i < 4 }), // only 1 non-superseded
    );
    const store = makeMockStore(entries);
    const llm = makeMockLlm('summary');
    const organizer = new MemoryOrganizer(store, llm, 'agent-1' as never);

    await organizer.organize();

    expect(llm.run).not.toHaveBeenCalled();
  });

  it('writes a semantic entry and marks source entries superseded on success', async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ id: `e${i}` as MemoryEntryId }),
    );
    const store = makeMockStore(entries);
    const llm = makeMockLlm('Concise semantic summary here.');
    const organizer = new MemoryOrganizer(store, llm, 'agent-1' as never);

    await organizer.organize();

    expect(store.upsert).toHaveBeenCalledOnce();
    const upsertCall = (store.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(upsertCall.partition).toBe('semantic');
    expect(upsertCall.content).toContain('Concise semantic summary');
    expect(store.markSuperseded).toHaveBeenCalledTimes(5);
  });

  it('skips upsert when LLM returns empty summary', async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ id: `e${i}` as MemoryEntryId }),
    );
    const store = makeMockStore(entries);
    const llm = makeMockLlm('   '); // whitespace only
    const organizer = new MemoryOrganizer(store, llm, 'agent-1' as never);

    await organizer.organize();

    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('handles LLM error gracefully — no upsert', async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ id: `e${i}` as MemoryEntryId }),
    );
    const store = makeMockStore(entries);
    const llm = {
      run: vi.fn().mockReturnValue(
        (async function* () {
          throw new Error('LLM boom');
        })(),
      ),
    } as unknown as LLMProvider;
    const organizer = new MemoryOrganizer(store, llm, 'agent-1' as never);

    await expect(organizer.organize()).resolves.toBeUndefined();
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('resets turn counter after triggering so next cycle works', async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ id: `e${i}` as MemoryEntryId }),
    );
    const store = makeMockStore(entries);
    const llm = makeMockLlm('Second cycle summary.');
    const organizer = new MemoryOrganizer(store, llm, 'agent-1' as never);

    // First cycle
    for (let i = 0; i < 20; i++) await organizer.maybeOrganize();
    const callsAfterFirst = (store.listRecent as ReturnType<typeof vi.fn>).mock.calls.length;

    // Second cycle
    for (let i = 0; i < 20; i++) await organizer.maybeOrganize();
    expect((store.listRecent as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
      callsAfterFirst,
    );
  });
});
