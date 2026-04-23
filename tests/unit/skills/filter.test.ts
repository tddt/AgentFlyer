import { describe, expect, it } from 'vitest';
import { filterSkillsForAgent, searchSkills } from '../../../src/skills/filter.js';
import type { SkillMeta } from '../../../src/skills/registry.js';
import { asSkillId } from '../../../src/core/types.js';

function makeMeta(id: string, overrides: Partial<SkillMeta> = {}): SkillMeta {
  return {
    id: asSkillId(id),
    name: `Skill ${id}`,
    description: `Description for ${id}`,
    shortDesc: `Short ${id}`,
    tags: [],
    apiKeyRequired: false,
    filePath: `/fake/skills/${id}.md`,
    cachedAt: 0,
    contentHash: 'abc123',
    ...overrides,
  };
}

describe('filterSkillsForAgent', () => {
  it('returns empty array when agentSkillIds is empty', () => {
    const all = [makeMeta('a'), makeMeta('b')];
    expect(filterSkillsForAgent(all, [])).toEqual([]);
  });

  it('returns only skills whose id appears in agentSkillIds', () => {
    const all = [makeMeta('a'), makeMeta('b'), makeMeta('c')];
    const result = filterSkillsForAgent(all, ['a', 'c']);
    expect(result.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('ignores unknown ids in agentSkillIds', () => {
    const all = [makeMeta('x')];
    const result = filterSkillsForAgent(all, ['x', 'unknown']);
    expect(result.map((s) => s.id)).toEqual(['x']);
  });

  it('returns all skills when agentSkillIds matches all', () => {
    const all = [makeMeta('p'), makeMeta('q')];
    const result = filterSkillsForAgent(all, ['p', 'q']);
    expect(result).toHaveLength(2);
  });

  it('preserves original order of the all array', () => {
    const all = [makeMeta('z'), makeMeta('a'), makeMeta('m')];
    const result = filterSkillsForAgent(all, ['m', 'z', 'a']);
    expect(result.map((s) => s.id)).toEqual(['z', 'a', 'm']);
  });
});

describe('searchSkills', () => {
  it('returns empty array when nothing matches', () => {
    const all = [makeMeta('a')];
    expect(searchSkills(all, 'xyzzy')).toEqual([]);
  });

  it('matches on skill name (case-insensitive)', () => {
    const all = [makeMeta('a', { name: 'Weather Forecast' }), makeMeta('b')];
    const result = searchSkills(all, 'weather');
    expect(result.map((s) => s.id)).toContain('a');
  });

  it('matches on description (case-insensitive)', () => {
    const all = [makeMeta('a', { description: 'Fetches live stock prices' }), makeMeta('b')];
    const result = searchSkills(all, 'STOCK');
    expect(result.map((s) => s.id)).toContain('a');
  });

  it('matches on tags', () => {
    const all = [makeMeta('a', { tags: ['finance', 'trading'] }), makeMeta('b', { tags: ['weather'] })];
    const result = searchSkills(all, 'finance');
    expect(result.map((s) => s.id)).toContain('a');
    expect(result.map((s) => s.id)).not.toContain('b');
  });

  it('returns all matching skills', () => {
    const all = [
      makeMeta('a', { name: 'Stock Analysis' }),
      makeMeta('b', { description: 'Analyze stock trends' }),
      makeMeta('c', { name: 'Weather' }),
    ];
    const result = searchSkills(all, 'stock');
    expect(result).toHaveLength(2);
  });
});
