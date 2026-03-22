import { defineCommand } from 'citty';
import { note } from '@clack/prompts';
import chalk from 'chalk';
import { loadConfig } from '../../core/config/loader.js';

/**
 * Federation commands — Phase 1 stub.
 * Interfaces are pre-designed; actual federation networking ships in Phase 2.
 */
export const federationCommand = defineCommand({
  meta: {
    name: 'federation',
    description: 'Manage federated node connections (Phase 2)',
  },
  subCommands: {
    status: defineCommand({
      meta: { name: 'status', description: 'Show federation status' },
      run() {
        note(
          [
            'Federation is not yet enabled.',
            '',
            'To enable, set ' + chalk.cyan('federation.enabled = true') + ' in agentflyer.json',
            'and configure peer nodes under ' + chalk.cyan('federation.peers') + '.',
            '',
            'See docs/05-decentralized-economy.md for design details.',
          ].join('\n'),
          'Federation (Phase 2)',
        );
        process.exit(0);
      },
    }),

    peers: defineCommand({
      meta: { name: 'peers', description: 'List configured peers' },
      args: {
        config: { type: 'string', alias: 'c', description: 'Config file path' },
      },
      run({ args }) {
        const cfg = loadConfig(args.config as string | undefined);
        const peers = cfg.federation.peers;
        if (peers.length === 0) {
          note('No federation peers configured.', 'Peers');
          process.exit(0);
        }
        process.stdout.write(chalk.bold(`\n${peers.length} peer(s):\n\n`));
        for (const p of peers) {
          process.stdout.write(`  ${chalk.cyan(p.nodeId)} ${p.host}:${p.port}\n`);
        }
        process.stdout.write('\n');
        process.exit(0);
      },
    }),
  },
});
