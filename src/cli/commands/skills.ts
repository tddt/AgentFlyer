import { note } from '@clack/prompts';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { loadConfig } from '../../core/config/loader.js';
import { buildRegistry } from '../../skills/registry.js';

export const skillsCommand = defineCommand({
  meta: {
    name: 'skills',
    description: 'List and inspect loaded skills',
  },
  subCommands: {
    list: defineCommand({
      meta: { name: 'list', description: 'List all available skills' },
      args: {
        config: { type: 'string', alias: 'c', description: 'Config file path' },
        json: { type: 'boolean', description: 'Output JSON', default: false },
      },
      async run({ args }) {
        const cfg = loadConfig(args.config as string | undefined);
        const registry = await buildRegistry(cfg);
        const skills = registry.list();

        if (args.json) {
          process.stdout.write(`${JSON.stringify(skills, null, 2)}\n`);
          return;
        }

        if (skills.length === 0) {
          note(
            'No skills found.\nAdd skill files to ~/.agentflyer/skills/ or a workspace skills/ dir.',
            'Skills',
          );
          process.exit(0);
        }

        process.stdout.write(chalk.bold(`\n${skills.length} skill(s) loaded:\n\n`));
        for (const s of skills) {
          process.stdout.write(`  ${chalk.cyan(s.id.padEnd(24))} ${chalk.white(s.shortDesc)}\n`);
          if (s.tags.length) {
            process.stdout.write(`  ${''.padEnd(24)} ${chalk.gray(s.tags.join(', '))}\n`);
          }
        }
        process.stdout.write('\n');
        process.exit(0);
      },
    }),

    show: defineCommand({
      meta: { name: 'show', description: 'Show details for one skill' },
      args: {
        id: { type: 'positional', description: 'Skill ID' },
        config: { type: 'string', alias: 'c', description: 'Config file path' },
      },
      async run({ args }) {
        const cfg = loadConfig(args.config as string | undefined);
        const registry = await buildRegistry(cfg);
        const skill = registry.get(args.id as Parameters<typeof registry.get>[0]);
        if (!skill) {
          note(`Skill '${args.id}' not found.`, 'Not found');
          process.exit(1);
        }
        process.stdout.write(`${JSON.stringify(skill, null, 2)}\n`);
        process.exit(0);
      },
    }),
  },
});
