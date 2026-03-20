import { note, outro } from '@clack/prompts';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { getDefaultConfigDir, loadConfig } from '../../core/config/loader.js';
import { isGatewayRunning } from '../../gateway/lifecycle.js';

export const webCommand = defineCommand({
  meta: {
    name: 'web',
    description: 'Print the web console URL for the running gateway',
  },
  args: {
    config: {
      type: 'string',
      alias: 'c',
      description: 'Path to agentflyer.json',
    },
  },
  async run({ args }) {
    const dataDir = getDefaultConfigDir();
    const running = await isGatewayRunning(dataDir);
    if (!running) {
      note(
        `Start the gateway first with ${chalk.bold('agentflyer start')}, then retry.`,
        'Gateway is not running',
      );
      process.exit(1);
    }

    let cfg: ReturnType<typeof loadConfig>;
    try {
      cfg = loadConfig(args.config as string | undefined);
    } catch (err) {
      note(String(err), 'Config error');
      process.exit(1);
    }

    const port = cfg.gateway.port;
    const token = cfg.gateway.auth.token ?? process.env.AGENTFLYER_TOKEN ?? '';
    if (!token) {
      note(
        'No auth token found. Set gateway.auth.token in agentflyer.json or AGENTFLYER_TOKEN env.',
        'Error',
      );
      process.exit(1);
    }

    const url = `http://127.0.0.1:${port}/console?token=${encodeURIComponent(token)}`;
    outro(chalk.cyan(url));
    process.exit(0);
  },
});
