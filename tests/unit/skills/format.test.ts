import { describe, expect, it } from 'vitest';
import {
  buildSkillsDirectory,
  formatSkillsForPrompt,
  preFilterSkills,
} from '../../../src/skills/format.js';
import type { SkillMeta } from '../../../src/skills/registry.js';
import { asSkillId } from '../../../src/core/types.js';

function makeMeta(id: string, overrides: Partial<SkillMeta> = {}): SkillMeta {
  return {
    id: asSkillId(id),
    name: `Skill ${id}`,
    description: `Full description for ${id}`,
    shortDesc: `Short desc ${id}`,
    tags: [],
    apiKeyRequired: false,
    filePath: `/fake/skills/${id}.md`,
    cachedAt: 0,
    contentHash: 'abc123',
    ...overrides,
  };
}

describe('formatSkillsForPrompt', () => {
  it('returns empty string for empty skill list', () => {
    expect(formatSkillsForPrompt([])).toBe('');
  });

  it('compact mode (default) produces "Available skills:" header with bullet lines', () => {
    const skills = [
      makeMeta('a', { name: 'Weather', shortDesc: 'Get current weather' }),
      makeMeta('b', { name: 'Stocks', shortDesc: 'Look up stock prices' }),
    ];
    const result = formatSkillsForPrompt(skills);
    expect(result).toContain('Available skills:');
    expect(result).toContain('- Weather: Get current weather');
    expect(result).toContain('- Stocks: Look up stock prices');
  });

  it('full mode includes description, tags, and api key note', () => {
    const skills = [
      makeMeta('a', {
        name: 'Finance',
        description: 'Fetches financial data',
        tags: ['finance', 'stocks'],
        apiKeyRequired: true,
      }),
    ];
    const result = formatSkillsForPrompt(skills, false);
    expect(result).toContain('### Finance');
    expect(result).toContain('Fetches financial data');
    expect(result).toContain('Tags: finance, stocks');
    expect(result).toContain('Requires: API key configured');
  });

  it('full mode omits Tags line when tags is empty', () => {
    const skills = [makeMeta('a', { tags: [] })];
    const result = formatSkillsForPrompt(skills, false);
    expect(result).not.toContain('Tags:');
  });

  it('full mode omits api key note when apiKeyRequired is false', () => {
    const skills = [makeMeta('a', { apiKeyRequired: false })];
    const result = formatSkillsForPrompt(skills, false);
    expect(result).not.toContain('Requires:');
  });

  it('compact mode does not include detail sections', () => {
    const skills = [makeMeta('a', { description: 'Long description', tags: ['t1'] })];
    const result = formatSkillsForPrompt(skills, true);
    expect(result).not.toContain('###');
    expect(result).not.toContain('Tags:');
  });
});

describe('buildSkillsDirectory', () => {
  it('delegates to formatSkillsForPrompt with compact flag', () => {
    const skills = [makeMeta('a', { name: 'Alpha', shortDesc: 'does alpha' })];
    expect(buildSkillsDirectory(skills, true)).toBe(formatSkillsForPrompt(skills, true));
    expect(buildSkillsDirectory(skills, false)).toBe(formatSkillsForPrompt(skills, false));
  });

  it('returns empty string for empty list', () => {
    expect(buildSkillsDirectory([], true)).toBe('');
  });
});

describe('preFilterSkills', () => {
  it('returns all skills when list size is <= topN', () => {
    const skills = [makeMeta('a'), makeMeta('b')];
    const result = preFilterSkills(skills, 'whatever', 3);
    expect(result).toHaveLength(2);
  });

  it('returns all skills when no keyword matches', () => {
    const skills = [makeMeta('a'), makeMeta('b'), makeMeta('c'), makeMeta('d')];
    const result = preFilterSkills(skills, 'xyzzy invisible nothing', 2);
    expect(result).toHaveLength(4);
  });

  it('filters by keyword and returns up to topN skills', () => {
    const skills = [
      makeMeta('finance', { name: 'Finance Tool', shortDesc: 'track finance data', tags: ['finance'] }),
      makeMeta('weather', { name: 'Weather Tool', shortDesc: 'get weather forecast', tags: ['weather'] }),
      makeMeta('travel', { name: 'Travel Tool', shortDesc: 'book flights', tags: ['travel'] }),
      makeMeta('stock', { name: 'Stock Tool', shortDesc: 'stock market prices', tags: ['stocks'] }),
    ];
    const result = preFilterSkills(skills, 'I want finance stock data', 2);
    expect(result.length).toBeLessThanOrEqual(2);
    const ids = result.map((s) => s.id as string);
    expect(ids.some((id) => id === 'finance' || id === 'stock')).toBe(true);
  });

  it('ignores stop words during keyword scoring', () => {
    const skills = [
      makeMeta('a', { name: 'Alpha', shortDesc: 'do stuff', tags: [] }),
      makeMeta('b', { name: 'Beta', shortDesc: 'other thing', tags: [] }),
      makeMeta('c', { name: 'Gamma', shortDesc: 'another item', tags: [] }),
      makeMeta('d', { name: 'Delta', shortDesc: 'some work', tags: [] }),
    ];
    // "the", "and", "is" are stop words — no substantive keywords → fallback to full list
    const result = preFilterSkills(skills, 'the and is or a', 2);
    expect(result).toHaveLength(4);
  });

  it('scores by tag matches as well', () => {
    const skills = [
      makeMeta('a', { shortDesc: 'generic tool', tags: ['python', 'code'] }),
      makeMeta('b', { shortDesc: 'another tool', tags: ['weather', 'forecast'] }),
      makeMeta('c', { shortDesc: 'third tool', tags: ['finance'] }),
      makeMeta('d', { shortDesc: 'fourth tool', tags: [] }),
    ];
    const result = preFilterSkills(skills, 'python code execution', 1);
    expect(result.map((s) => s.id as string)).toContain('a');
  });
});
