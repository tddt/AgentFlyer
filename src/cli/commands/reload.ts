import { note, outro, spinner } from '@clack/prompts';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { getDefaultConfigDir, loadConfig } from '../../core/config/loader.js';
import { isGatewayRunning } from '../../gateway/lifecycle.js';
import { callRpc } from '../gateway-client.js';

export const reloadCommand = defineCommand({
  meta: {
    name: 'reload',
    description: 'Reload agent configuration without restarting the gateway',
  },
  args: {
    agent: {
      type: 'string',
      alias: 'a',
      description: 'Agent ID to reload (default: all agents)',
    },
    config: {
      type: 'string',
      alias: 'c',
      description: 'Path to agentflyer.json',
    },
  },
  async run({ args }) {
    const dataDir = getDefaultConfigDir();

    const s = spinner();
    s.start('Checking gateway status');

    const running = await isGatewayRunning(dataDir);
    if (!running) {
      s.stop(chalk.yellow('Gateway is not running'));
      note(
        `Start the gateway first with ${chalk.bold('agentflyer start')}, then retry.`,
        'Not running',
      );
      process.exit(1);
    }
    s.stop('Gateway is running');

    let config: ReturnType<typeof loadConfig>;
    try {
      config = loadConfig(args.config as string | undefined);
    } catch (err) {
      note(String(err), 'Config error');
      process.exit(1);
    }

    const port = config.gateway.port;
    const token = config.gateway.auth.token ?? process.env.AGENTFLYER_TOKEN ?? '';
    if (!token) {
      note(
        'No auth token found. Set gateway.auth.token in agentflyer.json or AGENTFLYER_TOKEN env.',
        'Error',
      );
      process.exit(1);
    }

    const agentId = args.agent as string | undefined;
    const label = agentId ? `agent "${agentId}"` : 'all agents';
    s.start(`Reloading ${label}…`);

    try {
      const result = (await callRpc(port, token, 'agent.reload', agentId ? { agentId } : {})) as {
        reloaded: string[];
      };
      s.stop(chalk.green('Reload complete'));
      outro(
        [
          `Reloaded: ${chalk.cyan(result.reloaded.join(', ') || '(none)')}`,
          '',
          'The gateway picked up the latest workspace configuration.',
        ].join('\n'),
      );
      process.exit(0);
    } catch (err) {
      s.stop(chalk.red('Reload failed'));
      note(String(err), 'Error');
      process.exit(1);
    }
  },
});
