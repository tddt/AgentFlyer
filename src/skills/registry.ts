import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import type { Config } from '../core/config/schema.js';
import type { SkillId } from '../core/types.js';
import { createLogger } from '../core/logger.js';

const logger = createLogger('skills:registry');

export interface SkillCommand {
  name: string;
  description: string;
  args?: string[];
}

export interface SkillMeta {
  id: SkillId;
  name: string;
  description: string;
  /** Truncated to ≤ shortDescMaxLen chars for compact system-prompt injection */
  shortDesc: string;
  tags: string[];
  commands?: SkillCommand[];
  apiKeyRequired: boolean;
  filePath: string;
  cachedAt: number;
  contentHash: string;
}

export class SkillRegistry {
  private readonly skills = new Map<SkillId, SkillMeta>();

  register(meta: SkillMeta): void {
    this.skills.set(meta.id, meta);
    logger.debug('Skill registered', { id: meta.id });
  }

  get(id: SkillId): SkillMeta | undefined {
    return this.skills.get(id);
  }

  getByName(name: string): SkillMeta | undefined {
    for (const m of this.skills.values()) {
      if (m.name === name || m.id === name) return m;
    }
    return undefined;
  }

  list(): SkillMeta[] {
    return Array.from(this.skills.values());
  }

  /** Return only skills whose IDs are in the given allow-list */
  filterByIds(ids: string[]): SkillMeta[] {
    return ids
      .map((id) => this.skills.get(id as SkillId))
      .filter((s): s is SkillMeta => s != null);
  }

  size(): number {
    return this.skills.size;
  }

  clear(): void {
    this.skills.clear();
  }
}

// ─── Scanner ──────────────────────────────────────────────────────────────────

/** Scan a directory for SKILL.md files and parse their frontmatter.
 * Supports two levels of nesting:
 *   <dir>/<skill>/SKILL.md           — direct skill dir
 *   <dir>/<collection>/<skill>/SKILL.md — collection dir (no SKILL.md at top level)
 */
export function scanSkillsDir(
  dir: string,
  shortDescMaxLen = 60,
): SkillMeta[] {
  if (!existsSync(dir)) return [];

  const results: SkillMeta[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const subDir = join(dir, entry.name);
    const skillFile = join(subDir, 'SKILL.md');

    if (existsSync(skillFile)) {
      // Direct skill directory
      const meta = parseSkillFile(skillFile, shortDescMaxLen);
      if (meta) results.push(meta);
    } else {
      // Might be a collection directory — scan one level deeper
      try {
        for (const nested of readdirSync(subDir, { withFileTypes: true })) {
          if (!nested.isDirectory()) continue;
          const nestedSkillFile = join(subDir, nested.name, 'SKILL.md');
          if (!existsSync(nestedSkillFile)) continue;
          const meta = parseSkillFile(nestedSkillFile, shortDescMaxLen);
          if (meta) results.push(meta);
        }
      } catch {
        // ignore permission errors or unreadable directories
      }
    }
  }

  return results;
}

/** Parse a single SKILL.md file into SkillMeta */
export function parseSkillFile(filePath: string, shortDescMaxLen = 60): SkillMeta | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const { data, content } = matter(raw);

    const id = (data['id'] as string | undefined) ?? basename(join(filePath, '../')) as SkillId;
    const name: string = (data['name'] as string | undefined) ?? id;
    const description: string = (data['description'] as string | undefined) ?? content.slice(0, 200).trim();
    const shortDesc = truncateToSentence(description, shortDescMaxLen);
    const tags: string[] = (data['tags'] as string[] | undefined) ?? [];
    const apiKeyRequired: boolean = (data['apiKeyRequired'] as boolean | undefined) ?? false;

    const contentHash = createHash('sha256').update(raw).digest('hex');

    return {
      id: id as SkillId,
      name,
      description,
      shortDesc,
      tags,
      apiKeyRequired,
      filePath,
      cachedAt: Date.now(),
      contentHash,
    };
  } catch (err) {
    logger.warn('Failed to parse SKILL.md', { filePath, error: String(err) });
    return null;
  }
}

function truncateToSentence(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  // Try to cut at a period, comma, or space
  const slice = text.slice(0, maxLen);
  const lastPeriod = slice.lastIndexOf('.');
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastPeriod > maxLen / 2 ? lastPeriod + 1 : lastSpace > 0 ? lastSpace : maxLen;
  return slice.slice(0, cut).trimEnd() + '…';
}

/**
 * Build a SkillRegistry from all skill directories:
 * 1. Built-in skills (bundled with AgentFlyer)
 * 2. User-global skills (~/.agentflyer/skills/)
 * 3. Workspace-level skills (workspace/skills/)
 * 4. Extra dirs from config
 */
export function buildRegistry(config: Config, workspaceDir?: string): SkillRegistry {
  const registry = new SkillRegistry();
  const shortDescLen = config.skills.summaryLength ?? 60;

  const dirs: string[] = [];

  // User-global
  dirs.push(join(homedir(), '.agentflyer', 'skills'));

  // Workspace level
  if (workspaceDir) {
    dirs.push(join(workspaceDir, 'skills'));
  }

  // Extra dirs from config
  dirs.push(...(config.skills.dirs ?? []));

  for (const dir of dirs) {
    const found = scanSkillsDir(dir, shortDescLen);
    for (const meta of found) {
      registry.register(meta);
    }
  }

  logger.info('Skill registry built', { count: registry.size() });
  return registry;
}
