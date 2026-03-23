import type { SkillMeta } from './registry.js';

/**
 * Format a list of skills for injection into a system prompt.
 *
 * Compact mode (default): `- <name>: <shortDesc>`
 * Full mode: multi-line with description, tags, api key note
 */
export function formatSkillsForPrompt(skills: SkillMeta[], compact = true): string {
  if (skills.length === 0) return '';

  if (compact) {
    const lines = skills.map((s) => `- ${s.name}: ${s.shortDesc}`);
    return `Available skills:\n${lines.join('\n')}`;
  }

  const lines = skills.map((s) => {
    const parts = [`### ${s.name}`, s.description];
    if (s.tags.length > 0) parts.push(`Tags: ${s.tags.join(', ')}`);
    if (s.apiKeyRequired) parts.push('Requires: API key configured');
    return parts.join('\n');
  });

  return `Available skills:\n\n${lines.join('\n\n')}`;
}

/**
 * Generate the compact skills directory for Layer 1 system prompt injection.
 * Output is intentionally terse to minimise token consumption.
 */
export function buildSkillsDirectory(skills: SkillMeta[], compact: boolean): string {
  return formatSkillsForPrompt(skills, compact);
}

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'it',
  'to',
  'and',
  'or',
  'in',
  'of',
  'for',
  'with',
  'that',
  'this',
  'can',
  'you',
  'how',
  'do',
  'i',
  'me',
  'my',
]);

/**
 * Keyword/tag-based pre-filter: return the top-N most relevant skills for
 * a given user message without calling the LLM. Falls back to the full list
 * when no keyword matches are found or when the list is already small.
 */
export function preFilterSkills(skills: SkillMeta[], userMessage: string, topN = 3): SkillMeta[] {
  if (skills.length <= topN) return skills;
  const words = userMessage
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  if (words.length === 0) return skills;
  const scored = skills.map((s) => {
    const haystack = `${s.name} ${s.tags.join(' ')} ${s.shortDesc}`.toLowerCase();
    const hits = words.filter((w) => haystack.includes(w)).length;
    return { skill: s, hits };
  });
  const top = scored
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, topN)
    .map((x) => x.skill);
  return top.length > 0 ? top : skills;
}
