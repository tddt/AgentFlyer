import { defineCommand } from 'citty';
import { note } from '@clack/prompts';
import chalk from 'chalk';
import { loadConfig } from '../../core/config/loader.js';
import { getDefaultConfigDir } from '../../core/config/loader.js';
import { MemoryStore } from '../../memory/store.js';

export const memoryCommand = defineCommand({
  meta: {
    name: 'memory',
    description: 'Manage agent memory',
  },
  subCommands: {
    list: defineCommand({
      meta: { name: 'list', description: 'List recent memory entries' },
      args: {
        limit: { type: 'string', description: 'Max entries (default 20)', default: '20' },
        partition: {
          type: 'string',
          alias: 'p',
          description: 'Partition (default "shared")',
          default: 'shared',
        },
        config: { type: 'string', alias: 'c', description: 'Config file path' },
      },
      async run({ args }) {
        const dataDir = getDefaultConfigDir();
        const store = new MemoryStore(dataDir);
        await store.open();
        const entries = store.listRecent(
          args.partition as string,
          Math.max(1, parseInt(args.limit as string, 10) || 20),
        );
        store.close();
        if (entries.length === 0) {
          note(`No memory entries in partition '${args.partition}'.`, 'Memory');
          process.exit(0);
        }
        process.stdout.write(chalk.bold(`\n${entries.length} memory entries (${args.partition}):\n\n`));
        for (const e of entries) {
          const date = new Date(e.updatedAt).toLocaleString();
          process.stdout.write(`  ${chalk.cyan(e.key.padEnd(30))} ${chalk.gray(date)}\n`);
          process.stdout.write(`  ${''.padEnd(30)} ${e.content.slice(0, 80)}${e.content.length > 80 ? '\u2026' : ''}\n\n`);
        }
        process.exit(0);
      },
    }),

    search: defineCommand({
      meta: { name: 'search', description: 'Full-text search memory' },
      args: {
        query: { type: 'positional', description: 'Search query' },
        partition: {
          type: 'string',
          alias: 'p',
          description: 'Partition (default "shared")',
          default: 'shared',
        },
        limit: { type: 'string', description: 'Max results (default 10)', default: '10' },
      },
      async run({ args }) {
        const dataDir = getDefaultConfigDir();
        const store = new MemoryStore(dataDir);
        await store.open();
        const results = store.searchFts(
          args.query as string,
          args.partition as string,
          parseInt(args.limit as string, 10) || 10,
        );
        store.close();
        if (results.length === 0) {
          note(`No results for '${args.query}'.`, 'Memory search');
          process.exit(0);
        }
        for (const r of results) {
          process.stdout.write(`${chalk.cyan(r.key)}\n${r.content}\n\n`);
        }
        process.exit(0);
      },
    }),

    delete: defineCommand({
      meta: { name: 'delete', description: 'Delete a memory entry by key' },
      args: {
        key: { type: 'positional', description: 'Memory key' },
        partition: {
          type: 'string',
          alias: 'p',
          description: 'Partition (default "shared")',
          default: 'shared',
        },
      },
      async run({ args }) {
        const dataDir = getDefaultConfigDir();
        const store = new MemoryStore(dataDir);
        await store.open();
        const deleted = store.deleteByKey(args.key as string, args.partition as string);
        store.close();
        if (deleted) {
          note(`Deleted: ${args.key}`, 'Memory');
          process.exit(0);
        } else {
          note(`Not found: ${args.key}`, 'Memory');
          process.exit(1);
        }
      },
    }),
  },
});
