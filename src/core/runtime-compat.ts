// Runtime compatibility shim — Bun vs Node.js
// All Bun-specific API calls should go through this module.

import { createHash } from 'node:crypto';
import { readFile as fsReadFile, rename, writeFile as fsWriteFile } from 'node:fs/promises';

/** True when running inside Bun runtime (main thread or worker threads) */
export const isBun: boolean =
  typeof (globalThis as Record<string, unknown>).Bun !== 'undefined' ||
  typeof (process as { versions?: { bun?: string } }).versions?.bun !== 'undefined';

// ─── SHA-256 hasher ───────────────────────────────────────────────────────────
export interface RuntimeHasher {
  update(data: string | Uint8Array): RuntimeHasher;
  digest(encoding: 'hex'): string;
}

export function createSha256(): RuntimeHasher {
  return createHash('sha256');
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

// ─── High-performance file read ───────────────────────────────────────────────
export async function readFileText(path: string): Promise<string> {
  if (isBun) {
    // Bun.file() is faster but falls back gracefully
    try {
      const f = (globalThis as Record<string, unknown>).Bun as {
        file: (p: string) => { text: () => Promise<string> };
      };
      return await f.file(path).text();
    } catch {
      // fallthrough to Node path
    }
  }
  return fsReadFile(path, 'utf-8');
}

export async function writeFileText(path: string, content: string): Promise<void> {
  await fsWriteFile(path, content, 'utf-8');
}

/**
 * Write `content` to `path` atomically by first writing to a `.tmp` sibling
 * and then renaming it into place.
 *
 * RATIONALE: A direct write can leave a truncated file if the process is killed
 * mid-write. On POSIX, `rename()` is atomic; on Windows it is best-effort but
 * still safer than an in-place overwrite because readers either see the old or
 * the new content, never a partial write.
 */
export async function atomicWriteFile(
  path: string,
  content: string | Buffer,
): Promise<void> {
  const tmp = `${path}.tmp`;
  if (typeof content === 'string') {
    await fsWriteFile(tmp, content, 'utf-8');
  } else {
    await fsWriteFile(tmp, content);
  }
  await rename(tmp, path);
}

// ─── SQLite factory ───────────────────────────────────────────────────────────
export type AnyDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  };
  close(): void;
  loadExtension(path: string): void;
};

export async function openDatabase(filePath: string): Promise<AnyDatabase> {
  if (isBun) {
    try {
      // RATIONALE: bun:sqlite is a Bun-only built-in; tsc doesn't know its types.
      // We cast via unknown to satisfy strict mode.
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error bun:sqlite has no TS declarations for Node tsc
      const { Database } = (await import('bun:sqlite')) as {
        Database: new (path: string) => AnyDatabase;
      };
      return new Database(filePath);
    } catch {
      // fallthrough
    }
  }
  const { default: BetterSqlite3 } = await import('better-sqlite3');
  return new BetterSqlite3(filePath) as unknown as AnyDatabase;
}
