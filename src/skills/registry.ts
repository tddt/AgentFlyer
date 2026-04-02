import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import type { Config } from '../core/config/schema.js';
import { createLogger } from '../core/logger.js';
import { asSkillId, type SkillId } from '../core/types.js';

const logger = createLogger('skills:registry');

export interface SkillCommand {
  name: string;
  description: string;
  args?: string[];
}

export type SkillSource = 'builtin' | 'user-global' | 'workspace' | 'extra';

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
  /** Where this skill came from — used for display labels in the console UI */
  source?: SkillSource;
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
      .map((id) => {
        try {
          return this.skills.get(asSkillId(id));
        } catch {
          return undefined;
        }
      })
      .filter((skill): skill is SkillMeta => skill != null);
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
export function scanSkillsDir(dir: string, shortDescMaxLen = 60): SkillMeta[] {
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

    const rawId = (data.id as string | undefined) ?? basename(join(filePath, '../'));
    const id = asSkillId(rawId);
    const name: string = (data.name as string | undefined) ?? id;
    const description: string =
      (data.description as string | undefined) ?? content.slice(0, 200).trim();
    const shortDesc = truncateToSentence(description, shortDescMaxLen);
    const tags: string[] = (data.tags as string[] | undefined) ?? [];
    const apiKeyRequired: boolean = (data.apiKeyRequired as boolean | undefined) ?? false;

    const contentHash = createHash('sha256').update(raw).digest('hex');

    return {
      id,
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
  return `${slice.slice(0, cut).trimEnd()}…`;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Build a SkillRegistry from all skill directories:
 * 1. Built-in skills (bundled with AgentFlyer — src/skills/builtin/)
 * 2. User-global skills (~/.agentflyer/skills/)
 * 3. Workspace-level skills (workspace/skills/)
 * 4. Extra dirs from config
 *
 * NOTE: Per-agent workspace scanning (layer 3 in the 3-layer model) is done
 * in lifecycle.ts after per-agent skill filtering, so each agent can auto-merge
 * its own <workspace>/skills/ directory regardless of explicit skill selection.
 */
export function buildRegistry(config: Config, workspaceDir?: string): SkillRegistry {
  const registry = new SkillRegistry();
  const shortDescLen = config.skills.summaryLength ?? 60;

  // 1. Built-in skills (shipped with AgentFlyer)
  const builtinDir = join(__dirname, 'builtin');
  for (const meta of scanSkillsDir(builtinDir, shortDescLen)) {
    registry.register({ ...meta, source: 'builtin' });
  }

  // 2. User-global (~/.agentflyer/skills/)
  const globalDir = join(homedir(), '.agentflyer', 'skills');
  for (const meta of scanSkillsDir(globalDir, shortDescLen)) {
    registry.register({ ...meta, source: 'user-global' });
  }

  // 3. Default workspace-level skills (config.defaults.workspace/skills/)
  // RATIONALE: This covers the global default workspace only. Per-agent workspace
  // skill merging happens in lifecycle.ts so each agent also gets its own workspace skills.
  if (workspaceDir) {
    const wsDir = join(workspaceDir, 'skills');
    for (const meta of scanSkillsDir(wsDir, shortDescLen)) {
      registry.register({ ...meta, source: 'workspace' });
    }
  }

  // 4. Extra dirs from config
  for (const dir of config.skills.dirs ?? []) {
    for (const meta of scanSkillsDir(dir, shortDescLen)) {
      registry.register({ ...meta, source: 'extra' });
    }
  }

  logger.info('Skill registry built', { count: registry.size() });
  return registry;
}
