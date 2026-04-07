import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createLogger } from '../logger.js';
import { atomicWriteFile, readFileText } from '../runtime-compat.js';
import type { ProcessId } from '../types.js';
import { asProcessId } from '../types.js';
import type { CheckpointStore, KernelProcessSnapshot } from './types.js';

const logger = createLogger('kernel:checkpoint-store');

export class JsonFileCheckpointStore implements CheckpointStore {
  private readonly rootDir: string;

  constructor(dataDir: string) {
    this.rootDir = join(dataDir, 'kernel-checkpoints');
  }

  async save(snapshot: KernelProcessSnapshot): Promise<void> {
    const filePath = this.filePath(snapshot.pid);
    await mkdir(dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, JSON.stringify(snapshot, null, 2));
  }

  async load(pid: ProcessId): Promise<KernelProcessSnapshot | null> {
    const filePath = this.filePath(pid);
    try {
      const raw = await readFileText(filePath);
      return this.parseSnapshot(raw);
    } catch {
      return null;
    }
  }

  async list(): Promise<KernelProcessSnapshot[]> {
    try {
      const names = await readdir(this.rootDir);
      const snapshots = await Promise.all(
        names
          .filter((name) => name.endsWith('.json'))
          .map(async (name) => {
            const raw = await readFileText(join(this.rootDir, name));
            return this.parseSnapshot(raw);
          }),
      );
      return snapshots;
    } catch {
      return [];
    }
  }

  async delete(pid: ProcessId): Promise<void> {
    await rm(this.filePath(pid), { force: true });
  }

  private filePath(pid: ProcessId): string {
    return join(this.rootDir, `${pid}.json`);
  }

  private parseSnapshot(raw: string): KernelProcessSnapshot {
    const parsed = JSON.parse(raw) as KernelProcessSnapshot & { pid: string };
    const snapshot: KernelProcessSnapshot = {
      ...parsed,
      pid: asProcessId(parsed.pid),
    };
    logger.debug('Checkpoint loaded', { pid: snapshot.pid, status: snapshot.status });
    return snapshot;
  }
}

export class ScopedCheckpointStore implements CheckpointStore {
  constructor(
    private readonly inner: CheckpointStore,
    private readonly processType: string,
  ) {}

  async save(snapshot: KernelProcessSnapshot): Promise<void> {
    if (snapshot.processType !== this.processType) {
      throw new Error(
        `ScopedCheckpointStore expected processType '${this.processType}', got '${snapshot.processType}'`,
      );
    }
    await this.inner.save(snapshot);
  }

  async load(pid: ProcessId): Promise<KernelProcessSnapshot | null> {
    const snapshot = await this.inner.load(pid);
    if (!snapshot || snapshot.processType !== this.processType) {
      return null;
    }
    return snapshot;
  }

  async list(): Promise<KernelProcessSnapshot[]> {
    const snapshots = await this.inner.list();
    return snapshots.filter((snapshot) => snapshot.processType === this.processType);
  }

  async delete(pid: ProcessId): Promise<void> {
    await this.inner.delete(pid);
  }
}
