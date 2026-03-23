import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from '../core/logger.js';
import { type AnyDatabase, openDatabase } from '../core/runtime-compat.js';
import type { MemoryEntryId } from '../core/types.js';

const logger = createLogger('memory:store');

export interface MemoryEntry {
  id: MemoryEntryId;
  key: string; // user-defined identifier (e.g. "user_pref_language")
  agentId: string;
  partition: string; // 'shared' | 'per-agent:<id>'
  content: string;
  tags: string[];
  source: string; // file path or 'api'
  createdAt: number;
  updatedAt: number;
  accessedAt: number;
  accessCount: number;
  /** 0–1 user-assigned relevance score; 0.5 default */
  importance: number;
  /** True when a newer version supersedes this entry */
  superseded: boolean;
  embedding?: Float32Array;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL,
  partition TEXT NOT NULL DEFAULT 'shared',
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'api',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  accessed_at INTEGER NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  importance REAL NOT NULL DEFAULT 0.5,
  superseded INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memories_partition ON memories(partition);
CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content=memories,
  content_rowid=rowid
);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL
);
`;

export class MemoryStore {
  private db: AnyDatabase | null = null;
  private readonly dbPath: string;

  constructor(private readonly dataDir: string) {
    this.dbPath = join(dataDir, 'memory.db');
  }

  async open(): Promise<void> {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = await openDatabase(this.dbPath);
    this.db.exec(SCHEMA);
    // RATIONALE: Migration for importance/superseded columns added in v0.2.
    // SQLite CREATE TABLE IF NOT EXISTS won't add new columns to existing tables,
    // so we use ALTER TABLE with try/catch to handle both fresh and existing DBs.
    for (const col of [
      'ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.5',
      'ALTER TABLE memories ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0',
    ]) {
      try {
        this.db.exec(col);
      } catch {
        /* column already exists */
      }
    }
    logger.info('Memory store opened', { path: this.dbPath });
  }

  private get conn(): AnyDatabase {
    if (!this.db) throw new Error('MemoryStore not opened — call open() first');
    return this.db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  insert(entry: Omit<MemoryEntry, 'id'>): MemoryEntry {
    const id = genId(entry.content) as MemoryEntryId;
    const now = Date.now();
    this.conn
      .prepare(`
      INSERT OR IGNORE INTO memories
        (id, key, agent_id, partition, content, tags, source, created_at, updated_at, accessed_at, access_count, importance, superseded)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        id,
        entry.key,
        entry.agentId,
        entry.partition,
        entry.content,
        JSON.stringify(entry.tags),
        entry.source,
        entry.createdAt ?? now,
        entry.updatedAt ?? now,
        entry.accessedAt ?? now,
        entry.accessCount ?? 0,
        entry.importance ?? 0.5,
        entry.superseded ? 1 : 0,
      );

    // Also insert into FTS
    this.conn
      .prepare(
        'INSERT OR IGNORE INTO memories_fts(rowid, content) SELECT rowid, content FROM memories WHERE id = ?',
      )
      .run(id);

    return { ...entry, id };
  }

  upsert(entry: Omit<MemoryEntry, 'id'> & { id?: MemoryEntryId }): MemoryEntry {
    const id = entry.id && entry.id.length > 0 ? entry.id : (genId(entry.content) as MemoryEntryId);
    const now = Date.now();
    this.conn
      .prepare(`
      INSERT INTO memories
        (id, key, agent_id, partition, content, tags, source, created_at, updated_at, accessed_at, access_count, importance, superseded)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        key=excluded.key,
        content=excluded.content,
        tags=excluded.tags,
        updated_at=excluded.updated_at,
        importance=excluded.importance
    `)
      .run(
        id,
        entry.key,
        entry.agentId,
        entry.partition,
        entry.content,
        JSON.stringify(entry.tags),
        entry.source,
        entry.createdAt ?? now,
        now,
        entry.accessedAt ?? now,
        entry.accessCount ?? 0,
        entry.importance ?? 0.5,
        entry.superseded ? 1 : 0,
      );

    // Rebuild FTS for this entry
    this.conn
      .prepare(
        'INSERT OR REPLACE INTO memories_fts(rowid, content) SELECT rowid, content FROM memories WHERE id = ?',
      )
      .run(id);

    return { ...entry, id };
  }

  getById(id: MemoryEntryId): MemoryEntry | null {
    const row = this.conn.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    return row ? rowToEntry(row as MemoryRow) : null;
  }

  delete(id: MemoryEntryId): void {
    this.conn.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  /** Delete a memory entry by its user-defined key and partition */
  deleteByKey(key: string, partition = 'shared'): boolean {
    const result = this.conn
      .prepare('DELETE FROM memories WHERE key = ? AND partition = ?')
      .run(key, partition);
    return result.changes > 0;
  }

  /** BM25 full-text search via FTS5 */
  searchFts(query: string, partition?: string, limit = 10): MemoryEntry[] {
    const sql = partition
      ? `SELECT m.* FROM memories_fts fts
         JOIN memories m ON fts.rowid = m.rowid
         WHERE memories_fts MATCH ? AND m.partition = ?
         ORDER BY rank LIMIT ?`
      : `SELECT m.* FROM memories_fts fts
         JOIN memories m ON fts.rowid = m.rowid
         WHERE memories_fts MATCH ?
         ORDER BY rank LIMIT ?`;

    const rows = partition
      ? this.conn.prepare(sql).all(ftsEscape(query), partition, limit)
      : this.conn.prepare(sql).all(ftsEscape(query), limit);

    return (rows as MemoryRow[]).map(rowToEntry);
  }

  /** Retrieve most recently updated entries */
  listRecent(partition?: string, limit = 20): MemoryEntry[] {
    const sql = partition
      ? 'SELECT * FROM memories WHERE partition = ? ORDER BY updated_at DESC LIMIT ?'
      : 'SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?';
    const rows = partition
      ? this.conn.prepare(sql).all(partition, limit)
      : this.conn.prepare(sql).all(limit);
    return (rows as MemoryRow[]).map(rowToEntry);
  }

  count(): number {
    const row = this.conn.prepare('SELECT COUNT(*) as n FROM memories').get() as { n: number };
    return row.n;
  }

  /** Save embedding vector for a memory entry */
  saveEmbedding(memoryId: MemoryEntryId, embedding: Float32Array, model: string): void {
    const buf = Buffer.from(embedding.buffer);
    this.conn
      .prepare(`
      INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding, model, dims)
      VALUES (?, ?, ?, ?)
    `)
      .run(memoryId, buf, model, embedding.length);
  }

  /** Load embedding for a memory entry */
  loadEmbedding(memoryId: MemoryEntryId): Float32Array | null {
    const row = this.conn
      .prepare('SELECT embedding FROM memory_embeddings WHERE memory_id = ?')
      .get(memoryId) as { embedding: Buffer } | undefined;
    if (!row) return null;
    return new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4,
    );
  }

  /** Return all memory IDs that have embeddings */
  listEmbeddedIds(): MemoryEntryId[] {
    const rows = this.conn.prepare('SELECT memory_id FROM memory_embeddings').all() as Array<{
      memory_id: string;
    }>;
    return rows.map((r) => r.memory_id as MemoryEntryId);
  }

  /** Update the importance score of a memory entry */
  updateImportance(id: MemoryEntryId, importance: number): void {
    const clamped = Math.max(0, Math.min(1, importance));
    this.conn.prepare('UPDATE memories SET importance = ? WHERE id = ?').run(clamped, id);
  }

  /** Mark an entry as superseded (replaced by a newer version) */
  markSuperseded(id: MemoryEntryId): void {
    this.conn.prepare('UPDATE memories SET superseded = 1 WHERE id = ?').run(id);
  }

  /** List non-superseded entries by partition */
  listActive(partition?: string, limit = 50): MemoryEntry[] {
    const sql = partition
      ? 'SELECT * FROM memories WHERE superseded = 0 AND partition = ? ORDER BY updated_at DESC LIMIT ?'
      : 'SELECT * FROM memories WHERE superseded = 0 ORDER BY updated_at DESC LIMIT ?';
    const rows = partition
      ? this.conn.prepare(sql).all(partition, limit)
      : this.conn.prepare(sql).all(limit);
    return (rows as MemoryRow[]).map(rowToEntry);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
interface MemoryRow {
  id: string;
  key: string;
  agent_id: string;
  partition: string;
  content: string;
  tags: string;
  source: string;
  created_at: number;
  updated_at: number;
  accessed_at: number;
  access_count: number;
  importance: number;
  superseded: number;
}

function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id as MemoryEntryId,
    key: row.key,
    agentId: row.agent_id,
    partition: row.partition,
    content: row.content,
    tags: JSON.parse(row.tags) as string[],
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessedAt: row.accessed_at,
    accessCount: row.access_count,
    importance: row.importance ?? 0.5,
    superseded: row.superseded === 1,
  };
}

function genId(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function ftsEscape(q: string): string {
  // FTS5 special chars: " ^ * : - + = < > ( )
  return `"${q.replace(/"/g, '""')}"`;
}
