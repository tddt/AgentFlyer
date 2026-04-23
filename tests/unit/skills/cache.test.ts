import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillCache } from '../../../src/skills/cache.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentflyer-skillcache-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const SKILL_CONTENT = `---
id: test-skill
name: Test Skill
description: A skill used for testing purposes
tags:
  - test
  - demo
apiKeyRequired: false
---

This is the skill description body.
`;

describe('SkillCache', () => {
  describe('load()', () => {
    it('returns null when no cache file exists', async () => {
      const cacheDir = await createTempDir();
      const cache = new SkillCache(cacheDir);
      const result = await cache.load('nonexistent', '/fake/path/SKILL.md');
      expect(result).toBeNull();
    });

    it('returns null when cached hash does not match current file', async () => {
      const baseDir = await createTempDir();
      const cacheDir = join(baseDir, 'cache');
      const skillDir = join(baseDir, 'test-skill');
      await mkdir(skillDir, { recursive: true });
      const skillFile = join(skillDir, 'SKILL.md');
      await writeFile(skillFile, SKILL_CONTENT, 'utf-8');

      const cache = new SkillCache(cacheDir);
      // Manually write a cache entry with a wrong hash
      const fakeMeta = {
        id: 'test-skill',
        name: 'Test Skill',
        description: 'A skill used for testing purposes',
        shortDesc: 'A skill used for testing…',
        tags: ['test'],
        apiKeyRequired: false,
        filePath: skillFile,
        cachedAt: Date.now(),
        contentHash: 'wrong-hash-value',
      };
      await writeFile(join(cacheDir, 'test-skill.meta.json'), JSON.stringify(fakeMeta), 'utf-8');

      const result = await cache.load('test-skill', skillFile);
      expect(result).toBeNull();
    });

    it('returns cached meta when hash matches', async () => {
      const baseDir = await createTempDir();
      const cacheDir = join(baseDir, 'cache');
      const skillDir = join(baseDir, 'test-skill');
      await mkdir(skillDir, { recursive: true });
      const skillFile = join(skillDir, 'SKILL.md');
      await writeFile(skillFile, SKILL_CONTENT, 'utf-8');

      const correctHash = createHash('sha256').update(SKILL_CONTENT).digest('hex');
      const cache = new SkillCache(cacheDir);
      const meta = {
        id: 'test-skill',
        name: 'Test Skill',
        description: 'A skill used for testing purposes',
        shortDesc: 'A skill used for testing…',
        tags: ['test'],
        apiKeyRequired: false,
        filePath: skillFile,
        cachedAt: Date.now(),
        contentHash: correctHash,
      };
      await writeFile(join(cacheDir, 'test-skill.meta.json'), JSON.stringify(meta), 'utf-8');

      const result = await cache.load('test-skill', skillFile);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('test-skill');
      expect(result!.name).toBe('Test Skill');
    });

    it('returns null when skill file does not exist (hash will be empty string, mismatch)', async () => {
      const baseDir = await createTempDir();
      const cacheDir = join(baseDir, 'cache');
      const cache = new SkillCache(cacheDir);

      const meta = {
        id: 'ghost-skill',
        name: 'Ghost',
        description: 'Ghost skill',
        shortDesc: 'Ghost skill',
        tags: [],
        apiKeyRequired: false,
        filePath: '/nonexistent/SKILL.md',
        cachedAt: Date.now(),
        contentHash: 'some-hash',
      };
      await writeFile(join(cacheDir, 'ghost-skill.meta.json'), JSON.stringify(meta), 'utf-8');

      const result = await cache.load('ghost-skill', '/nonexistent/SKILL.md');
      // fileHash returns '' for missing file, won't match 'some-hash'
      expect(result).toBeNull();
    });
  });

  describe('save()', () => {
    it('writes a JSON file for the given meta', async () => {
      const cacheDir = await createTempDir();
      const cache = new SkillCache(cacheDir);
      const meta = {
        id: 'saved-skill' as import('../../../src/core/types.js').SkillId,
        name: 'Saved Skill',
        description: 'A saved skill',
        shortDesc: 'A saved skill',
        tags: ['save'],
        apiKeyRequired: true,
        filePath: '/fake/SKILL.md',
        cachedAt: 12345,
        contentHash: 'deadbeef',
      };
      await cache.save(meta);

      const raw = await readFile(join(cacheDir, 'saved-skill.meta.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.id).toBe('saved-skill');
      expect(parsed.name).toBe('Saved Skill');
      expect(parsed.contentHash).toBe('deadbeef');
    });
  });

  describe('getOrParse()', () => {
    it('parses a real SKILL.md file and returns meta', async () => {
      const baseDir = await createTempDir();
      const cacheDir = join(baseDir, 'cache');
      // getOrParse derives skillId from parent directory name
      const skillDir = join(baseDir, 'my-cool-skill');
      await mkdir(skillDir, { recursive: true });
      const skillFile = join(skillDir, 'SKILL.md');
      await writeFile(skillFile, SKILL_CONTENT, 'utf-8');

      const cache = new SkillCache(cacheDir);
      const result = await cache.getOrParse(skillFile);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Test Skill');
      expect(result!.tags).toContain('test');
    });

    it('persists cache after first parse', async () => {
      const baseDir = await createTempDir();
      const cacheDir = join(baseDir, 'cache');
      const skillDir = join(baseDir, 'cached-skill');
      await mkdir(skillDir, { recursive: true });
      const skillFile = join(skillDir, 'SKILL.md');
      await writeFile(skillFile, SKILL_CONTENT, 'utf-8');

      const cache = new SkillCache(cacheDir);
      await cache.getOrParse(skillFile);

      // Second parse should be served from cache (file is unchanged)
      const result2 = await cache.getOrParse(skillFile);
      expect(result2).not.toBeNull();
      expect(result2!.name).toBe('Test Skill');
    });

    it('returns null for a non-existent SKILL.md file', async () => {
      const cacheDir = await createTempDir();
      const cache = new SkillCache(cacheDir);
      const result = await cache.getOrParse('/nonexistent/skill-xyz/SKILL.md');
      expect(result).toBeNull();
    });
  });
});
