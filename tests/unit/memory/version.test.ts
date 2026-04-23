import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listSnapshots,
  restoreSnapshot,
  snapshotMemoryFile,
} from '../../../src/memory/version.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentflyer-version-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  tempDirs.splice(0).forEach((d) => {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  });
});

describe('snapshotMemoryFile', () => {
  it('no-op when file does not exist', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'MEMORY.md');
    await expect(snapshotMemoryFile(filePath)).resolves.toBeUndefined();
    expect(existsSync(join(dir, '.history'))).toBe(false);
  });

  it('creates a gzip snapshot in .history/ dir', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'MEMORY.md');
    writeFileSync(filePath, '# Memory\n\nSome content.', 'utf-8');

    await snapshotMemoryFile(filePath);

    const historyDir = join(dir, '.history');
    expect(existsSync(historyDir)).toBe(true);

    const snapshots = await listSnapshots(filePath);
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].path.endsWith('.gz')).toBe(true);
  });

  it('creates multiple snapshots on repeated calls', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'MEMORY.md');
    writeFileSync(filePath, 'v1', 'utf-8');
    await snapshotMemoryFile(filePath);

    writeFileSync(filePath, 'v2', 'utf-8');
    await snapshotMemoryFile(filePath);

    const snapshots = await listSnapshots(filePath);
    expect(snapshots.length).toBe(2);
  });
});

describe('listSnapshots', () => {
  it('returns empty array when .history dir does not exist', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'MEMORY.md');
    const result = await listSnapshots(filePath);
    expect(result).toEqual([]);
  });

  it('returns snapshots sorted newest first', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'MEMORY.md');
    writeFileSync(filePath, 'content-1', 'utf-8');
    await snapshotMemoryFile(filePath);
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(filePath, 'content-2', 'utf-8');
    await snapshotMemoryFile(filePath);

    const snapshots = await listSnapshots(filePath);
    expect(snapshots.length).toBe(2);
    // newest first: second timestamp should be lexicographically greater
    expect(snapshots[0].timestamp >= snapshots[1].timestamp).toBe(true);
  });
});

describe('restoreSnapshot', () => {
  it('decompresses a snapshot back to the target path', async () => {
    const dir = makeTempDir();
    const filePath = join(dir, 'MEMORY.md');
    const originalContent = '# Original Content\n\nHello, World!';
    writeFileSync(filePath, originalContent, 'utf-8');

    await snapshotMemoryFile(filePath);
    const snapshots = await listSnapshots(filePath);
    expect(snapshots.length).toBeGreaterThan(0);

    const restorePath = join(dir, 'MEMORY.restored.md');
    await restoreSnapshot(snapshots[0].path, restorePath);

    const restored = await readFile(restorePath, 'utf-8');
    expect(restored).toBe(originalContent);
  });
});
