import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RegisteredTool } from '../agent/tools/registry.js';
import { createLogger } from '../core/logger.js';
import type { SkillRegistry } from './registry.js';

const logger = createLogger('skills:tools');

/**
 * Create agent tools for browsing and reading skills.
 *
 * - `skill_list` — returns the list of available skill IDs and short descriptions
 * - `skill_read` — returns the full SKILL.md content for a given skill ID
 */
export function createSkillTools(registry: SkillRegistry): RegisteredTool[] {
  const skillList: RegisteredTool = {
    category: 'skill',
    definition: {
      name: 'skill_list',
      description:
        'List all available skills for this agent. Returns skill IDs and short descriptions. Call this to discover what skills you can use before calling skill_read.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    handler: async () => {
      const skills = registry.list();
      if (skills.length === 0) {
        return { content: 'No skills available.', isError: false };
      }
      const lines = skills.map((s) => `- **${s.id}** (${s.name}): ${s.description}`);
      return {
        content: `Available skills (${skills.length}):\n${lines.join('\n')}`,
        isError: false,
      };
    },
  };

  const skillRead: RegisteredTool = {
    category: 'skill',
    definition: {
      name: 'skill_read',
      description:
        'Read the full instructions (SKILL.md) for a specific skill. Use this to get the complete step-by-step guide on how to execute a skill before performing it.',
      inputSchema: {
        type: 'object',
        properties: {
          skill_id: {
            type: 'string',
            description:
              'The skill ID to read (e.g. "z-image-turbo"). Use skill_list to discover available IDs.',
          },
        },
        required: ['skill_id'],
      },
    },
    handler: async (input: unknown) => {
      const { skill_id } = input as { skill_id: string };
      const meta = registry.get(skill_id as import('../core/types.js').SkillId);
      if (!meta) {
        const available = registry
          .list()
          .map((s) => s.id)
          .join(', ');
        logger.warn('skill_read: skill not found', { skill_id });
        return {
          content: `Skill "${skill_id}" not found. Available skills: ${available || '(none)'}`,
          isError: true,
        };
      }
      try {
        const skillDir = dirname(meta.filePath);
        const raw = readFileSync(meta.filePath, 'utf-8');
        // RATIONALE: Prepend the skill directory so the agent knows where to cd before
        // running any scripts referenced in the SKILL.md. Without this, the agent
        // defaults to the workspace dir and cannot find scripts or config files.
        const content = `> **IMPORTANT — Skill directory:** \`${skillDir}\`\n> All scripts and config files in this skill are relative to that directory.\n> Before running any command, execute: \`cd "${skillDir}"\`\n\n${raw}`;
        logger.info('skill_read: returning skill content', { skill_id, bytes: content.length });
        return { content, isError: false };
      } catch (err) {
        logger.error('skill_read: failed to read SKILL.md', { skill_id, error: String(err) });
        return {
          content: `Failed to read skill file: ${String(err)}`,
          isError: true,
        };
      }
    },
  };

  return [skillList, skillRead];
}
