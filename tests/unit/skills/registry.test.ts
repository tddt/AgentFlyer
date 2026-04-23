import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asSkillId } from '../../../src/core/types.js';
import { SkillRegistry, parseSkillFile, scanSkillsDir } from '../../../src/skills/registry.js';

describe('SkillRegistry', () => {
  it('ignores blank ids when filtering by allow-list', () => {
    const registry = new SkillRegistry();
    registry.register({
      id: asSkillId('alpha'),
      name: 'alpha',
      description: 'Alpha skill',
      shortDesc: 'Alpha skill',
      tags: [],
      apiKeyRequired: false,
      filePath: '/tmp/alpha/SKILL.md',
      cachedAt: Date.now(),
      contentHash: 'hash-alpha',
    });

    const result = registry.filterByIds(['alpha', '   ', 'missing']);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('alpha');
  });

  it('starts empty', () => {
    const registry = new SkillRegistry();
    expect(registry.size()).toBe(0);
    expect(registry.list()).toEqual([]);
  });

  it('get returns registered skill by id', () => {
    const registry = new SkillRegistry();
    const meta = {
      id: asSkillId('s1'),
      name: 'S1',
      description: 'desc',
      shortDesc: 'desc',
      tags: [],
      apiKeyRequired: false,
      filePath: '/tmp/s1.md',
      cachedAt: Date.now(),
      contentHash: 'abc',
    };
    registry.register(meta);
    expect(registry.get(asSkillId('s1'))).toBe(meta);
    expect(registry.size()).toBe(1);
  });

  it('getByName finds by name and also by id', () => {
    const registry = new SkillRegistry();
    const id = asSkillId('skill-a');
    registry.register({
      id,
      name: 'Skill Alpha',
      description: 'desc',
      shortDesc: '',
      tags: [],
      apiKeyRequired: false,
      filePath: '/tmp/a.md',
      cachedAt: 0,
      contentHash: 'x',
    });
    expect(registry.getByName('Skill Alpha')?.id).toBe(id);
    expect(registry.getByName('skill-a')?.id).toBe(id);
    expect(registry.getByName('nonexistent')).toBeUndefined();
  });

  it('list returns all registered skills', () => {
    const registry = new SkillRegistry();
    for (const name of ['a', 'b', 'c']) {
      registry.register({
        id: asSkillId(name),
        name,
        description: '',
        shortDesc: '',
        tags: [],
        apiKeyRequired: false,
        filePath: '',
        cachedAt: 0,
        contentHash: '',
      });
    }
    expect(registry.list()).toHaveLength(3);
  });

  it('clear removes all entries', () => {
    const registry = new SkillRegistry();
    registry.register({
      id: asSkillId('x'),
      name: 'x',
      description: '',
      shortDesc: '',
      tags: [],
      apiKeyRequired: false,
      filePath: '',
      cachedAt: 0,
      contentHash: '',
    });
    registry.clear();
    expect(registry.size()).toBe(0);
  });
});

describe('parseSkillFile', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeSkillDir(base: string, id: string, content: string): string {
    const skillDir = join(base, id);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf-8');
    return join(skillDir, 'SKILL.md');
  }

  it('returns null when frontmatter id is blank', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentflyer-skill-test-'));
    tempDirs.push(dir);
    const skillDir = join(dir, 'blank-id-skill');
    const skillFile = join(skillDir, 'SKILL.md');

    mkdirSync(skillDir, { recursive: true });

    writeFileSync(
      skillFile,
      ['---', 'id: "   "', 'name: Blank Id', '---', '', 'Skill body'].join('\n'),
      'utf-8',
    );

    expect(parseSkillFile(skillFile)).toBeNull();
  });

  it('parses a valid SKILL.md with all frontmatter fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentflyer-skill-test-'));
    tempDirs.push(dir);
    const content = [
      '---',
      'id: my-skill',
      'name: My Skill',
      'description: A helpful skill.',
      'tags:',
      '  - useful',
      'apiKeyRequired: true',
      '---',
      'Body text.',
    ].join('\n');
    const filePath = makeSkillDir(dir, 'my-skill', content);

    const meta = parseSkillFile(filePath);
    expect(meta).not.toBeNull();
    expect(meta!.id).toBe(asSkillId('my-skill'));
    expect(meta!.name).toBe('My Skill');
    expect(meta!.apiKeyRequired).toBe(true);
    expect(meta!.tags).toContain('useful');
    expect(meta!.contentHash).toBeTruthy();
  });

  it('falls back to directory name when no id in frontmatter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentflyer-skill-test-'));
    tempDirs.push(dir);
    const content = '---\nname: Fallback\n---\nContent.';
    const filePath = makeSkillDir(dir, 'fallback-skill', content);

    const meta = parseSkillFile(filePath);
    expect(meta!.id).toBe(asSkillId('fallback-skill'));
  });

  it('returns null for a nonexistent file', () => {
    expect(parseSkillFile('/nonexistent/SKILL.md')).toBeNull();
  });

  it('truncates long descriptions to shortDesc', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentflyer-skill-test-'));
    tempDirs.push(dir);
    const longDesc = 'A'.repeat(200);
    const content = `---\nid: long-d\nname: Long\ndescription: "${longDesc}"\n---\n`;
    const filePath = makeSkillDir(dir, 'long-d', content);

    const meta = parseSkillFile(filePath, 60);
    expect(meta).not.toBeNull();
    expect(meta!.shortDesc.length).toBeLessThanOrEqual(65);
  });
});

describe('scanSkillsDir', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const SKILL_CONTENT = [
    '---',
    'id: scan-skill',
    'name: Scan Skill',
    'description: For scan tests.',
    '---',
    'Body.',
  ].join('\n');

  it('returns empty array for nonexistent directory', () => {
    expect(scanSkillsDir('/absolutely/does/not/exist')).toEqual([]);
  });

  it('finds direct skill directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentflyer-scan-test-'));
    tempDirs.push(dir);
    const skillDir = join(dir, 'scan-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL_CONTENT, 'utf-8');

    const results = scanSkillsDir(dir);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(asSkillId('scan-skill'));
  });

  it('finds skills nested in collection directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentflyer-scan-test-'));
    tempDirs.push(dir);
    const collectionDir = join(dir, 'my-collection');
    const nestedSkillDir = join(collectionDir, 'nested-skill');
    mkdirSync(nestedSkillDir, { recursive: true });
    writeFileSync(join(nestedSkillDir, 'SKILL.md'), SKILL_CONTENT, 'utf-8');

    const results = scanSkillsDir(dir);
    expect(results).toHaveLength(1);
  });

  it('ignores non-directory entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentflyer-scan-test-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'README.md'), '# readme', 'utf-8');
    const results = scanSkillsDir(dir);
    expect(results).toHaveLength(0);
  });

  it('scans multiple skill directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentflyer-scan-test-'));
    tempDirs.push(dir);
    for (let i = 0; i < 3; i++) {
      const skillDir = join(dir, `skill-${i}`);
      mkdirSync(skillDir, { recursive: true });
      const content = [
        '---',
        `id: skill-${i}`,
        `name: Skill ${i}`,
        'description: Test.',
        '---',
      ].join('\n');
      writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf-8');
    }
    const results = scanSkillsDir(dir);
    expect(results).toHaveLength(3);
  });
});
