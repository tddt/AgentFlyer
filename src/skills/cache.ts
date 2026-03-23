import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../core/logger.js';
import type { SkillMeta } from './registry.js';
import { parseSkillFile } from './registry.js';

const logger = createLogger('skills:cache');

/** Persistent cache of parsed SkillMeta to avoid re-parsing SKILL.md on every startup. */
export class SkillCache {
  constructor(private readonly cacheDir: string) {
    mkdirSync(cacheDir, { recursive: true });
  }

  private cachePath(skillId: string): string {
    return join(this.cacheDir, `${skillId}.meta.json`);
  }

  /** Load cached meta if content hash still matches the SKILL.md file. */
  async load(skillId: string, skillFilePath: string): Promise<SkillMeta | null> {
    const path = this.cachePath(skillId);
    if (!existsSync(path)) return null;

    try {
      const cached = JSON.parse(await readFile(path, 'utf-8')) as SkillMeta;
      const currentHash = fileHash(skillFilePath);
      if (cached.contentHash !== currentHash) {
        logger.debug('Skill cache stale', { skillId });
        return null;
      }
      return cached;
    } catch {
      return null;
    }
  }

  /** Persist SkillMeta to the cache directory. */
  async save(meta: SkillMeta): Promise<void> {
    await writeFile(this.cachePath(meta.id), JSON.stringify(meta, null, 2), 'utf-8');
  }

  /**
   * Return SkillMeta for a SKILL.md file, using cache when possible.
   * Re-parses and updates cache when the file has changed.
   */
  async getOrParse(skillFilePath: string, shortDescMaxLen = 60): Promise<SkillMeta | null> {
    const { basename } = await import('node:path');
    const skillId = basename(join(skillFilePath, '..'));
    const cached = await this.load(skillId, skillFilePath);
    if (cached) return cached;

    const meta = parseSkillFile(skillFilePath, shortDescMaxLen);
    if (!meta) return null;

    await this.save(meta);
    return meta;
  }
}

function fileHash(filePath: string): string {
  if (!existsSync(filePath)) return '';
  const content = readFileSync(filePath, 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}
