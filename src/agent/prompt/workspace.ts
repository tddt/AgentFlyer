import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../../core/logger.js';

const logger = createLogger('prompt:workspace');

/** Names of agent-instruction files we look for, in priority order. */
const DOC_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'SOUL.md', '.agentflyer.md'];

/**
 * Read the workspace instruction document from the given directory.
 * Tries DOC_CANDIDATES in order; returns the first found, or null.
 */
export async function readWorkspaceDoc(workspaceDir: string): Promise<string | null> {
  for (const name of DOC_CANDIDATES) {
    const p = join(workspaceDir, name);
    try {
      await access(p);
      const content = await readFile(p, 'utf-8');
      logger.debug('Loaded workspace doc', { file: name, workspaceDir });
      return `## Workspace Instructions (${name})\n\n${content.trim()}`;
    } catch {
      // file not found — try next
    }
  }
  return null;
}

/** Cache of (workspaceDir → content) to avoid re-reading on every turn. */
const docCache = new Map<string, { content: string | null; readAt: number }>();
const CACHE_TTL_MS = 30_000;

export async function readWorkspaceDocCached(workspaceDir: string): Promise<string | null> {
  const cached = docCache.get(workspaceDir);
  if (cached && Date.now() - cached.readAt < CACHE_TTL_MS) {
    return cached.content;
  }
  const content = await readWorkspaceDoc(workspaceDir);
  docCache.set(workspaceDir, { content, readAt: Date.now() });
  return content;
}

/** Invalidate the cache for a directory (e.g. after AGENTS.md is edited). */
export function invalidateWorkspaceDocCache(workspaceDir: string): void {
  docCache.delete(workspaceDir);
}
