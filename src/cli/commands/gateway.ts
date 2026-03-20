import { defineCommand } from 'citty';
import { spinner, note, outro } from '@clack/prompts';
import chalk from 'chalk';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { getDefaultConfigDir, loadConfig } from '../../core/config/loader.js';
import { isGatewayRunning, GATEWAY_VERSION } from '../../gateway/lifecycle.js';
import { callRpc } from '../gateway-client.js';
import { startCommand } from './start.js';

const gatewayStop = defineCommand({
  meta: { name: 'stop', description: 'Stop the running gateway' },
  args: {
    config: { type: 'string', alias: 'c', description: 'Path to agentflyer.json' },
  },
  async run({ args }) {
    const dataDir = getDefaultConfigDir();
    const s = spinner();
    s.start('Checking gateway status');

    const running = await isGatewayRunning(dataDir);
    if (!running) {
      s.stop(chalk.yellow('Gateway is not running'));
      note('Nothing to stop.', 'Not running');
      return;
    }
    s.stop('Gateway is running — stopping…');

    let port = 19789;
    let token = '';
    try {
      const cfg = loadConfig(args.config as string | undefined);
      port = cfg.gateway.port;
      token = cfg.gateway.auth.token ?? process.env['AGENTFLYER_TOKEN'] ?? '';
    } catch { /* use defaults */ }

    // Try graceful RPC shutdown first
    if (token) {
      try {
        s.start('Sending shutdown signal via RPC');
        await callRpc(port, token, 'gateway.shutdown', {});
        s.stop('Shutdown signal sent');
      } catch {
        s.stop('RPC shutdown failed — sending SIGTERM');
      }
    }

    // Kill via PID file if still running
    const pidPath = join(dataDir, 'gateway.pid');
    try {
      const pidStr = await readFile(pidPath, 'utf-8');
      const pid = parseInt(pidStr.trim(), 10);
      if (!isNaN(pid)) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      }
    } catch { /* no PID file */ }

    await unlink(pidPath).catch(() => undefined);
    outro(chalk.green('Gateway stopped.'));
  },
});

const gatewayStatus = defineCommand({
  meta: { name: 'status', description: 'Show gateway status' },
  args: {
    config: { type: 'string', alias: 'c', description: 'Path to agentflyer.json' },
  },
  async run({ args }) {
    const dataDir = getDefaultConfigDir();
    const s = spinner();
    s.start('Checking gateway');

    const running = await isGatewayRunning(dataDir);
    if (!running) {
      s.stop(chalk.red('Gateway is NOT running'));
      return;
    }
    s.stop('Gateway is running');

    let port = 19789;
    let token = '';
    try {
      const cfg = loadConfig(args.config as string | undefined);
      port = cfg.gateway.port;
      token = cfg.gateway.auth.token ?? process.env['AGENTFLYER_TOKEN'] ?? '';
    } catch { /* use defaults */ }

    if (!token) {
      note('No auth token — cannot fetch detailed status.\nSet gateway.auth.token in config.', 'Warning');
      return;
    }

    try {
      const status = await callRpc(port, token, 'gateway.status', {}) as {
        version: string;
        agentCount: number;
        uptime: number;
        port: number;
      };
      const upSeconds = Math.floor(status.uptime / 1000);
      const upStr = upSeconds < 60
        ? `${upSeconds}s`
        : upSeconds < 3600
          ? `${Math.floor(upSeconds / 60)}m ${upSeconds % 60}s`
          : `${Math.floor(upSeconds / 3600)}h ${Math.floor((upSeconds % 3600) / 60)}m`;

      process.stdout.write(
        [
          '',
          chalk.bold('  AgentFlyer Gateway Status'),
          '',
          `  Version : ${chalk.cyan(status.version ?? GATEWAY_VERSION)}`,
          `  Port    : ${chalk.green(port)}`,
          `  Agents  : ${chalk.cyan(status.agentCount)}`,
          `  Uptime  : ${chalk.yellow(upStr)}`,
          '',
        ].join('\n'),
      );
    } catch (err) {
      note(String(err), 'Status error');
      process.exit(1);
    }
  },
});

export const gatewayCommand = defineCommand({
  meta: {
    name: 'gateway',
    description: 'Manage the AgentFlyer gateway process',
  },
  subCommands: {
    start: startCommand,
    stop: gatewayStop,
    status: gatewayStatus,
  },
});
