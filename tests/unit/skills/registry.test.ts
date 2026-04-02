import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asSkillId } from '../../../src/core/types.js';
import { parseSkillFile, SkillRegistry } from '../../../src/skills/registry.js';

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
});

describe('parseSkillFile', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
});