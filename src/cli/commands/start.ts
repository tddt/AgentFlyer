import { defineCommand } from 'citty';
import { intro, outro, spinner, note, isCancel, cancel } from '@clack/prompts';
import chalk from 'chalk';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../../core/config/loader.js';
import { getDefaultConfigDir } from '../../core/config/loader.js';
import { freePortSync } from '../../core/process/port-cleanup.js';
import { startGateway, isGatewayRunning } from '../../gateway/lifecycle.js';
import { setLogLevel } from '../../core/logger.js';

export const startCommand = defineCommand({
  meta: {
    name: 'start',
    description: 'Start the AgentFlyer gateway',
  },
  args: {
    config: {
      type: 'string',
      alias: 'c',
      description: 'Path to agentflyer.json',
    },
    foreground: {
      type: 'boolean',
      alias: 'f',
      default: true,
      description: 'Run in the foreground (default)',
    },
    verbose: {
      type: 'boolean',
      alias: 'v',
      default: false,
      description: 'Enable verbose logging',
    },
    force: {
      type: 'boolean',
      default: false,
      description: 'Kill the process currently listening on the configured gateway port',
    },
  },
  async run({ args }) {
    if (args.verbose) setLogLevel('debug');

    intro(chalk.bold.cyan('AgentFlyer Gateway'));

    const dataDir = getDefaultConfigDir();

    const s = spinner();
    s.start('Loading configuration');
    let config: Awaited<ReturnType<typeof loadConfig>>;
    try {
      config = loadConfig(args.config as string | undefined);
      // Apply log level from config (--verbose overrides)
      if (!args.verbose && config.log?.level) setLogLevel(config.log.level);
      s.stop('Configuration loaded');
    } catch (err) {
      s.stop(chalk.red('Configuration error'));
      note(String(err), 'Error');
      process.exit(1);
    }

    if (args.force) {
      s.start(`Clearing gateway port ${config.gateway.port}`);
      const cleanup = freePortSync(config.gateway.port);
      await unlink(join(dataDir, 'gateway.pid')).catch(() => undefined);
      if (cleanup.remainingPids.length > 0) {
        s.stop(chalk.red('Configured gateway port is still occupied'));
        note(
          `Port ${config.gateway.port} is still held by PID(s): ${cleanup.remainingPids.join(', ')}`,
          'Port busy',
        );
        process.exit(1);
      }

      const message =
        cleanup.killedPids.length > 0
          ? `Stopped process(es): ${cleanup.killedPids.join(', ')}`
          : `Port ${config.gateway.port} is available`;
      s.stop(message);
    } else {
      const alreadyRunning = await isGatewayRunning(dataDir);
      if (alreadyRunning) {
        note(
          'A gateway process is already running.\nStop it first or use --force.',
          'Already running',
        );
        process.exit(1);
      }
    }

    s.start('Starting gateway');
    try {
      const instance = await startGateway(config, dataDir);
      s.stop(`Gateway running on port ${config.gateway.port}`);

      const tokenHint = instance.state.authToken.slice(0, 8) + '...';
      note(
        [
          `Port:  ${chalk.green(config.gateway.port)}`,
          `Token: ${chalk.yellow(tokenHint)} (see ${dataDir}/agentflyer.json)`,
          `Agents: ${chalk.cyan(config.agents.map((a) => a.id).join(', '))}`,
          '',
          'Run ' + chalk.bold('agentflyer chat') + ' in another terminal to start chatting.',
          'Press Ctrl-C to stop.',
        ].join('\n'),
        'Gateway ready',
      );
    } catch (err) {
      s.stop(chalk.red('Failed to start gateway'));
      note(String(err), 'Error');
      process.exit(1);
    }

    // Keep process alive
    await new Promise<never>(() => undefined);
  },
});
