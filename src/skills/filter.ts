import type { SkillMeta } from './registry.js';

/**
 * Filter skills by an agent's allowlist / denylist.
 * If allowlist is provided, only listed skill IDs are returned.
 * Denylist entries are always excluded.
 */
export function filterSkillsForAgent(all: SkillMeta[], agentSkillIds: string[]): SkillMeta[] {
  const allowed = new Set(agentSkillIds);
  // Empty list means "no skills assigned to this agent"
  if (allowed.size === 0) return [];
  return all.filter((s) => allowed.has(s.id));
}

/**
 * Filter skills by a keyword search (for tool-tip / autocomplete).
 * Matches against name, description, and tags.
 */
export function searchSkills(all: SkillMeta[], query: string): SkillMeta[] {
  const q = query.toLowerCase();
  return all.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags.some((t) => t.toLowerCase().includes(q)),
  );
}
