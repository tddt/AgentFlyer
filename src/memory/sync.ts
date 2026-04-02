import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import chokidar from 'chokidar';
import { createLogger } from '../core/logger.js';
import { type EmbedConfig, embed } from './embed.js';
import type { MemoryStore } from './store.js';

const logger = createLogger('memory:sync');

/**
 * Synchronise `memory/*.md` files into the vector database.
 *
 * Each .md file becomes a MemoryEntry with id based on content hash.
 * Stale embeddings are rebuilt when the file changes.
 */
export async function syncMemoryDir(
  memoryDir: string,
  store: MemoryStore,
  embedConfig: EmbedConfig,
  agentId: string,
  partition: string,
): Promise<void> {
  if (!existsSync(memoryDir)) return;

  const files = readdirSync(memoryDir).filter((f) => extname(f) === '.md');

  for (const file of files) {
    const filePath = join(memoryDir, file);
    await syncFile(filePath, store, embedConfig, agentId, partition);
  }

  logger.info('Memory dir synced', { dir: memoryDir, files: files.length });
}

async function syncFile(
  filePath: string,
  store: MemoryStore,
  embedConfig: EmbedConfig,
  agentId: string,
  partition: string,
): Promise<void> {
  const content = readFileSync(filePath, 'utf-8').trim();
  if (!content) return;

  const entry = store.upsert({
    agentId,
    partition,
    key: filePath,
    content,
    tags: [],
    source: filePath,
    importance: 0.5,
    superseded: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    accessedAt: Date.now(),
    accessCount: 0,
  });

  // Rebuild embedding if not yet stored
  const existing = store.loadEmbedding(entry.id);
  if (!existing) {
    try {
      const vec = await embed(content, embedConfig);
      store.saveEmbedding(entry.id, vec, embedConfig.model);
    } catch (err) {
      logger.warn('Failed to generate embedding', { file: filePath, error: String(err) });
    }
  }
}

export interface MemorySyncWatcher {
  stop(): void;
}

/** Watch a memory directory for changes and auto-sync */
export function watchMemoryDir(
  memoryDir: string,
  store: MemoryStore,
  embedConfig: EmbedConfig,
  agentId: string,
  partition: string,
): MemorySyncWatcher {
  const watcher = chokidar.watch(join(memoryDir, '*.md'), {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  const handle = (filePath: string): void => {
    void syncFile(filePath, store, embedConfig, agentId, partition).catch((err) => {
      logger.error('Memory sync error', { file: filePath, error: String(err) });
    });
  };

  watcher.on('add', handle);
  watcher.on('change', handle);

  return { stop: () => void watcher.close() };
}
