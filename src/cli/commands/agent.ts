import { defineCommand } from 'citty';
import { spinner, note, outro } from '@clack/prompts';
import chalk from 'chalk';
import { getDefaultConfigDir, loadConfig } from '../../core/config/loader.js';
import { isGatewayRunning } from '../../gateway/lifecycle.js';
import { callRpc } from '../gateway-client.js';

const agentList = defineCommand({
  meta: { name: 'list', description: 'List all running agents' },
  args: {
    config: { type: 'string', alias: 'c', description: 'Path to agentflyer.json' },
  },
  async run({ args }) {
    const dataDir = getDefaultConfigDir();
    const s = spinner();
    s.start('Connecting to gateway');

    const running = await isGatewayRunning(dataDir);
    if (!running) {
      s.stop(chalk.red('Gateway is not running'));
      note('Start the gateway first with ' + chalk.bold('agentflyer start'), 'Not running');
      process.exit(1);
    }

    const cfg = loadConfig(args.config as string | undefined);
    const port = cfg.gateway.port;
    const token = cfg.gateway.auth.token ?? process.env['AGENTFLYER_TOKEN'] ?? '';
    if (!token) {
      s.stop('No auth token');
      note('Set gateway.auth.token in config or AGENTFLYER_TOKEN env.', 'Error');
      process.exit(1);
    }

    s.start('Fetching agents');
    try {
      const rpcResult = await callRpc(port, token, 'agent.list', {}) as {
        agents: Array<{ id: string; name: string; model: string; role?: string }>;
      };
      const agents = rpcResult.agents ?? [];
      s.stop(`${agents.length} agent(s)`);

      if (agents.length === 0) {
        note('No agents configured.', 'Info');
        return;
      }

      // Table header
      const colId   = 20;
      const colName = 20;
      const colModel = 24;
      const colRole = 10;
      const header =
        chalk.bold('  ' +
          'ID'.padEnd(colId) +
          'Name'.padEnd(colName) +
          'Model'.padEnd(colModel) +
          'Role'.padEnd(colRole));

      process.stdout.write('\n' + header + '\n');
      process.stdout.write('  ' + '─'.repeat(colId + colName + colModel + colRole) + '\n');

      for (const a of agents) {
        process.stdout.write(
          '  ' +
          chalk.cyan(a.id.padEnd(colId)) +
          (a.name ?? '').padEnd(colName) +
          chalk.yellow((a.model ?? '').padEnd(colModel)) +
          chalk.gray((a.role ?? 'worker').padEnd(colRole)) +
          '\n',
        );
      }
      process.stdout.write('\n');
      process.exit(0);
    } catch (err) {
      s.stop(chalk.red('Failed'));
      note(String(err), 'Error');
      process.exit(1);
    }
  },
});

const agentReload = defineCommand({
  meta: { name: 'reload', description: 'Reload one or all agents' },
  args: {
    id: { type: 'positional', description: 'Agent ID (omit for all)', required: false },
    config: { type: 'string', alias: 'c', description: 'Path to agentflyer.json' },
  },
  async run({ args }) {
    const dataDir = getDefaultConfigDir();
    const s = spinner();
    s.start('Checking gateway');

    const running = await isGatewayRunning(dataDir);
    if (!running) {
      s.stop(chalk.red('Gateway is not running'));
      process.exit(1);
    }

    const cfg = loadConfig(args.config as string | undefined);
    const port = cfg.gateway.port;
    const token = cfg.gateway.auth.token ?? process.env['AGENTFLYER_TOKEN'] ?? '';
    if (!token) {
      s.stop('No auth token');
      process.exit(1);
    }

    const agentId = args.id as string | undefined;
    const label = agentId ? `agent "${agentId}"` : 'all agents';
    s.start(`Reloading ${label}…`);

    try {
      const result = await callRpc(port, token, 'agent.reload', agentId ? { agentId } : {}) as {
        reloaded: string[];
      };
      s.stop(chalk.green('Reload complete'));
      outro(`Reloaded: ${chalk.cyan(result.reloaded.join(', ') || '(none)')}`);
    } catch (err) {
      s.stop(chalk.red('Reload failed'));
      note(String(err), 'Error');
      process.exit(1);
    }
  },
});

export const agentCommand = defineCommand({
  meta: {
    name: 'agent',
    description: 'Manage agents',
  },
  subCommands: {
    list: agentList,
    reload: agentReload,
  },
});
