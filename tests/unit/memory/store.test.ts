import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnyDatabase } from '../../../src/core/runtime-compat.js';

// ─── sql.js mock for openDatabase (works in pure Node.js without native bindings) ────
vi.mock('../../../src/core/runtime-compat.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/core/runtime-compat.js')>();
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();

  function wrapSqlJsDb(db: InstanceType<(typeof SQL)['Database']>): AnyDatabase {
    return {
      exec(sql: string) {
        // sql.js 1.x ships with FTS4 but not FTS5. Rewrite FTS5 virtual table
        // declarations to FTS4 by stripping key=value options and changing the
        // module name. Basic MATCH queries behave identically for our use case.
        const processed = sql.replace(/USING fts5\(([^)]*)\)/gi, (_match, args: string) => {
          const cols = args
            .split(',')
            .map((s) => s.trim())
            .filter((s) => !s.includes('='))
            .join(', ');
          return `USING fts4(${cols || 'content'})`;
        });
        db.run(processed);
      },
      prepare(sql: string) {
        // FTS5 uses 'rank' as a virtual column for relevance ordering.
        // FTS4 has no such column; fall back to rowid ordering for tests.
        const mappedSql = sql.replace(/\bORDER BY rank\b/gi, 'ORDER BY m.rowid DESC');
        return {
          all(...params: unknown[]) {
            const stmt = db.prepare(mappedSql);
            if (params.length) stmt.bind(params as Parameters<typeof stmt.bind>[0]);
            const rows: Record<string, unknown>[] = [];
            while (stmt.step()) rows.push(stmt.getAsObject());
            stmt.free();
            return rows;
          },
          get(...params: unknown[]) {
            const stmt = db.prepare(mappedSql);
            if (params.length) stmt.bind(params as Parameters<typeof stmt.bind>[0]);
            let row: Record<string, unknown> | null = null;
            if (stmt.step()) row = stmt.getAsObject();
            stmt.free();
            return row;
          },
          run(...params: unknown[]) {
            const stmt = db.prepare(mappedSql);
            if (params.length) stmt.bind(params as Parameters<typeof stmt.bind>[0]);
            stmt.run();
            stmt.free();
            const changes = db.getRowsModified();
            const lastIdResult = db.exec('SELECT last_insert_rowid()');
            const lastInsertRowid = (lastIdResult[0]?.values[0]?.[0] as number) ?? 0;
            return { changes, lastInsertRowid };
          },
        };
      },
      close() {
        db.close();
      },
      loadExtension() {
        /* no-op in sql.js */
      },
    };
  }

  return {
    ...original,
    openDatabase: async (_filePath: string): Promise<AnyDatabase> => {
      const db = new SQL.Database(); // in-memory
      return wrapSqlJsDb(db);
    },
  };
});

import type { MemoryEntryId } from '../../../src/core/types.js';
import { MemoryStore } from '../../../src/memory/store.js';

function makeTestStore(): { store: MemoryStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agentflyer-memory-test-'));
  const store = new MemoryStore(dir);
  return { store, dir };
}

describe('MemoryStore', () => {
  let store: MemoryStore;
  let dir: string;

  beforeEach(async () => {
    ({ store, dir } = makeTestStore());
    await store.open();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // ─── Insert ──────────────────────────────────────────────────────────────
  describe('insert', () => {
    it('inserts a new entry and returns it with an id', () => {
      const entry = store.insert({
        key: 'test_key',
        agentId: 'main',
        partition: 'shared',
        content: 'Hello memory!',
        tags: ['greeting'],
        source: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
      });
      expect(entry.id).toBeTruthy();
      expect(entry.key).toBe('test_key');
      expect(entry.content).toBe('Hello memory!');
    });

    it('count increases after insert', () => {
      expect(store.count()).toBe(0);
      store.insert({
        key: 'k1',
        agentId: 'main',
        partition: 'shared',
        content: 'entry one',
        tags: [],
        source: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
      });
      expect(store.count()).toBe(1);
    });
  });

  // ─── Upsert ──────────────────────────────────────────────────────────────
  describe('upsert', () => {
    it('creates new entry on upsert', () => {
      const e = store.upsert({
        key: 'upsert_key',
        agentId: 'main',
        partition: 'shared',
        content: 'initial content',
        tags: [],
        source: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
      });
      expect(e.key).toBe('upsert_key');
      expect(store.count()).toBe(1);
    });

    it('updates existing entry on conflict', () => {
      const e1 = store.upsert({
        key: 'shared_key',
        agentId: 'main',
        partition: 'shared',
        content: 'first',
        tags: [],
        source: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
      });
      // upsert same id with different content
      store.upsert({
        id: e1.id,
        key: 'shared_key',
        agentId: 'main',
        partition: 'shared',
        content: 'updated',
        tags: ['new'],
        source: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 1,
      });
      expect(store.count()).toBe(1); // still one entry
      const loaded = store.getById(e1.id);
      expect(loaded?.content).toBe('updated');
    });
  });

  // ─── GetById ─────────────────────────────────────────────────────────────
  describe('getById', () => {
    it('returns null for unknown id', () => {
      expect(store.getById('unknown' as MemoryEntryId)).toBeNull();
    });

    it('returns the correct entry', () => {
      const e = store.insert({
        key: 'lookup',
        agentId: 'main',
        partition: 'shared',
        content: 'findme',
        tags: [],
        source: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
      });
      const found = store.getById(e.id);
      expect(found).not.toBeNull();
      expect(found?.content).toBe('findme');
    });
  });

  // ─── Delete ──────────────────────────────────────────────────────────────
  describe('delete', () => {
    it('removes entry by id', () => {
      const e = store.insert({
        key: 'del_test',
        agentId: 'main',
        partition: 'shared',
        content: 'to delete',
        tags: [],
        source: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
      });
      store.delete(e.id);
      expect(store.getById(e.id)).toBeNull();
      expect(store.count()).toBe(0);
    });
  });

  // ─── DeleteByKey ─────────────────────────────────────────────────────────
  describe('deleteByKey', () => {
    it('deletes by key and partition, returns true', () => {
      store.insert({
        key: 'my_key',
        agentId: 'main',
        partition: 'shared',
        content: 'something',
        tags: [],
        source: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
      });
      const deleted = store.deleteByKey('my_key', 'shared');
      expect(deleted).toBe(true);
      expect(store.count()).toBe(0);
    });

    it('returns false when key not found', () => {
      const deleted = store.deleteByKey('nonexistent', 'shared');
      expect(deleted).toBe(false);
    });

    it('only deletes within specified partition', () => {
      store.insert({
        key: 'k',
        agentId: 'main',
        partition: 'shared',
        content: 'shared partition',
        tags: [],
        source: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
      });
      const deleted = store.deleteByKey('k', 'agent:other');
      expect(deleted).toBe(false);
      expect(store.count()).toBe(1); // still there in 'shared'
    });
  });

  // ─── FTS Search ──────────────────────────────────────────────────────────
  describe('searchFts', () => {
    beforeEach(() => {
      store.insert({
        key: 'typescript_notes',
        agentId: 'main',
        partition: 'shared',
        content: 'TypeScript is a strongly typed programming language',
        tags: ['lang'],
        source: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
      });
      store.insert({
        key: 'python_notes',
        agentId: 'main',
        partition: 'shared',
        content: 'Python is great for data science',
        tags: ['lang'],
        source: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
      });
    });

    it('returns matching entries', () => {
      const results = store.searchFts('TypeScript');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.key).toBe('typescript_notes');
    });

    it('returns empty array for no match', () => {
      const results = store.searchFts('unrelated-xyz-topic');
      expect(results).toEqual([]);
    });

    it('respects limit', () => {
      const results = store.searchFts('language', undefined, 1);
      expect(results.length).toBeLessThanOrEqual(1);
    });
  });

  // ─── ListRecent ──────────────────────────────────────────────────────────
  describe('listRecent', () => {
    it('returns entries sorted by updated_at desc', () => {
      const now = Date.now();
      store.insert({
        key: 'old',
        agentId: 'main',
        partition: 'shared',
        content: 'older entry',
        tags: [],
        source: 'test',
        createdAt: now - 2000,
        updatedAt: now - 2000,
        accessedAt: now - 2000,
        accessCount: 0,
      });
      store.insert({
        key: 'new',
        agentId: 'main',
        partition: 'shared',
        content: 'newer entry',
        tags: [],
        source: 'test',
        createdAt: now,
        updatedAt: now,
        accessedAt: now,
        accessCount: 0,
      });
      const entries = store.listRecent(undefined, 10);
      expect(entries[0]?.key).toBe('new');
      expect(entries[1]?.key).toBe('old');
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        store.insert({
          key: `key_${i}`,
          agentId: 'main',
          partition: 'shared',
          content: `entry ${i}`,
          tags: [],
          source: 'test',
          createdAt: Date.now() + i,
          updatedAt: Date.now() + i,
          accessedAt: Date.now() + i,
          accessCount: 0,
        });
      }
      expect(store.listRecent(undefined, 3)).toHaveLength(3);
    });

    it('filters by partition', () => {
      store.insert({
        key: 'p1',
        agentId: 'main',
        partition: 'shared',
        content: 'in shared',
        tags: [],
        source: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
      });
      store.insert({
        key: 'p2',
        agentId: 'main',
        partition: 'per-agent:x',
        content: 'in agent',
        tags: [],
        source: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
      });
      const shared = store.listRecent('shared');
      expect(shared.every((e) => e.partition === 'shared')).toBe(true);
    });
  });

  // ─── Embedding ───────────────────────────────────────────────────────────
  describe('saveEmbedding / loadEmbedding / listEmbeddedIds', () => {
    it('stores and retrieves a Float32Array embedding', () => {
      const e = store.insert({
        key: 'emb',
        agentId: 'main',
        partition: 'shared',
        content: 'embedding content',
        tags: [],
        source: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
      });
      const vec = new Float32Array([0.1, 0.2, 0.3]);
      store.saveEmbedding(e.id, vec, 'test-model');

      const loaded = store.loadEmbedding(e.id);
      expect(loaded).not.toBeNull();
      expect(loaded?.length).toBe(3);
      expect(loaded?.[0]).toBeCloseTo(0.1, 4);
    });

    it('returns null for an entry with no embedding', () => {
      const e = store.insert({
        key: 'no-emb',
        agentId: 'main',
        partition: 'shared',
        content: 'no embedding',
        tags: [],
        source: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
      });
      expect(store.loadEmbedding(e.id)).toBeNull();
    });

    it('listEmbeddedIds includes ids that have embeddings', () => {
      const a = store.insert({
        key: 'a',
        agentId: 'main',
        partition: 'shared',
        content: 'a',
        tags: [],
        source: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
      });
      const b = store.insert({
        key: 'b',
        agentId: 'main',
        partition: 'shared',
        content: 'b',
        tags: [],
        source: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
      });
      store.saveEmbedding(a.id, new Float32Array([1, 2]), 'm');

      const ids = store.listEmbeddedIds();
      expect(ids).toContain(a.id);
      expect(ids).not.toContain(b.id);
    });
  });

  // ─── Importance & Superseded ─────────────────────────────────────────────
  describe('updateImportance / markSuperseded / listActive', () => {
    function insertEntry(key: string, content: string) {
      return store.insert({
        key,
        agentId: 'main',
        partition: 'shared',
        content,
        tags: [],
        source: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
      });
    }

    it('updateImportance persists a new score', () => {
      const e = insertEntry('imp', 'important');
      store.updateImportance(e.id, 0.9);
      expect(store.getById(e.id)?.importance).toBeCloseTo(0.9);
    });

    it('updateImportance clamps values above 1 to 1.0', () => {
      const e = insertEntry('high', 'high');
      store.updateImportance(e.id, 1.5);
      expect(store.getById(e.id)?.importance).toBeCloseTo(1.0);
    });

    it('updateImportance clamps values below 0 to 0.0', () => {
      const e = insertEntry('low', 'low');
      store.updateImportance(e.id, -0.3);
      expect(store.getById(e.id)?.importance).toBeCloseTo(0.0);
    });

    it('markSuperseded sets superseded flag to true', () => {
      const e = insertEntry('old', 'old version');
      store.markSuperseded(e.id);
      expect(store.getById(e.id)?.superseded).toBe(true);
    });

    it('listActive excludes superseded entries', () => {
      const active = insertEntry('active', 'active entry');
      const old = insertEntry('old', 'old entry');
      store.markSuperseded(old.id);

      const results = store.listActive();
      const ids = results.map((e) => e.id);
      expect(ids).toContain(active.id);
      expect(ids).not.toContain(old.id);
    });

    it('listActive filters by partition', () => {
      insertEntry('s1', 'shared entry');
      store.insert({
        key: 'a1',
        agentId: 'main',
        partition: 'per-agent:z',
        content: 'agent entry',
        tags: [],
        source: 'test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
      });
      const results = store.listActive('shared');
      expect(results.every((e) => e.partition === 'shared')).toBe(true);
    });
  });
});
