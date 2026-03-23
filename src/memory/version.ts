import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
/**
 * Memory versioning — gzip snapshots before overwriting MEMORY.md files.
 * Snapshots live in <memoryDir>/.history/ with ISO timestamp in the filename.
 */
import { createGunzip, createGzip } from 'node:zlib';

const MAX_SNAPSHOTS = 30;

function historyDir(memoryFilePath: string): string {
  return join(dirname(memoryFilePath), '.history');
}

function snapshotName(memoryFilePath: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${basename(memoryFilePath)}.${ts}.gz`;
}

/**
 * Compress the current memory file into .history/ before overwriting.
 * No-op if the file does not yet exist.
 */
export async function snapshotMemoryFile(memoryFilePath: string): Promise<void> {
  if (!existsSync(memoryFilePath)) return;

  const dir = historyDir(memoryFilePath);
  await mkdir(dir, { recursive: true });

  const dest = join(dir, snapshotName(memoryFilePath));
  await pipeline(createReadStream(memoryFilePath), createGzip(), createWriteStream(dest));

  // Prune old snapshots beyond MAX_SNAPSHOTS
  await pruneSnapshots(memoryFilePath);
}

/** List snapshot metadata (path, timestamp) sorted newest first (max 30) */
export async function listSnapshots(
  memoryFilePath: string,
): Promise<Array<{ path: string; timestamp: string }>> {
  const dir = historyDir(memoryFilePath);
  if (!existsSync(dir)) return [];

  try {
    const entries = await readdir(dir);
    const prefix = basename(memoryFilePath);
    const snapshots = entries
      .filter((e) => e.startsWith(prefix) && e.endsWith('.gz'))
      .sort()
      .reverse()
      .slice(0, MAX_SNAPSHOTS)
      .map((e) => ({
        path: join(dir, e),
        timestamp: e
          .slice(prefix.length + 1, -3)
          .replace(/-/g, (m, i) =>
            i === 10 ? 'T' : i === 13 || i === 16 ? ':' : i === 19 ? '.' : m,
          ),
      }));
    return snapshots;
  } catch {
    return [];
  }
}

/** Decompress a snapshot back to targetPath */
export async function restoreSnapshot(snapshotPath: string, targetPath: string): Promise<void> {
  await pipeline(createReadStream(snapshotPath), createGunzip(), createWriteStream(targetPath));
}

/** Keep only the most recent MAX_SNAPSHOTS snapshots */
async function pruneSnapshots(memoryFilePath: string): Promise<void> {
  const dir = historyDir(memoryFilePath);
  try {
    const entries = await readdir(dir);
    const prefix = basename(memoryFilePath);
    const all = entries.filter((e) => e.startsWith(prefix) && e.endsWith('.gz')).sort();

    const toDelete = all.slice(0, Math.max(0, all.length - MAX_SNAPSHOTS));
    for (const name of toDelete) {
      await unlink(join(dir, name)).catch(() => undefined);
    }
  } catch {
    /* ignore */
  }
}
