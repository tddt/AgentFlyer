import { defineCommand } from 'citty';
import { spinner, note, outro } from '@clack/prompts';
import chalk from 'chalk';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { getDefaultConfigDir, loadConfig } from '../../core/config/loader.js';
import { isGatewayRunning, readRunningPort, GATEWAY_VERSION } from '../../gateway/lifecycle.js';
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
      process.exit(0);
    }
    s.stop('Gateway is running — stopping…');

    // Read the port the gateway actually bound (not what config says now)
    const port = await readRunningPort(dataDir, 19789);
    let token = '';
    try {
      const cfg = loadConfig(args.config as string | undefined);
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
      const pidRaw = await readFile(pidPath, 'utf-8');
      // Handle both JSON ({pid,port}) and legacy plain-number formats
      let pid: number;
      try { pid = (JSON.parse(pidRaw) as { pid: number }).pid; } catch { pid = parseInt(pidRaw.trim(), 10); }
      if (!isNaN(pid) && pid > 0) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      }
    } catch { /* no PID file */ }

    await unlink(pidPath).catch(() => undefined);
    outro(chalk.green('Gateway stopped.'));
    process.exit(0);
  },
});

const gatewayStatus = defineCommand({
  meta: { name: 'status', description: 'Show gateway and agent status' },
  args: {
    config: { type: 'string', alias: 'c', description: 'Path to agentflyer.json' },
  },
  async run({ args }) {
    const dataDir = getDefaultConfigDir();
    const s = spinner();
    s.start('Checking gateway');

    const running = await isGatewayRunning(dataDir);
    if (!running) {
      s.stop(chalk.red('  ● Gateway is NOT running'));
      process.stdout.write(
        [
          '',
          chalk.bold('  AgentFlyer Status'),
          '',
          `  ${chalk.red('●')} Gateway    ${chalk.red('Stopped')}`,
          `  Data dir  ${chalk.dim(dataDir)}`,
          '',
          `  Run ${chalk.cyan('agentflyer start')} to start the gateway.`,
          '',
        ].join('\n'),
      );
      process.exit(0);
    }
    s.stop('Gateway is running');

    // Use the port the gateway actually bound, falling back to config then default
    let configPort = 19789;
    let token = '';
    try {
      const cfg = loadConfig(args.config as string | undefined);
      configPort = cfg.gateway.port;
      token = cfg.gateway.auth.token ?? process.env['AGENTFLYER_TOKEN'] ?? '';
    } catch { /* use defaults */ }
    const port = await readRunningPort(dataDir, configPort);

    if (!token) {
      process.stdout.write(
        [
          '',
          chalk.bold('  AgentFlyer Status'),
          '',
          `  ${chalk.green('●')} Gateway    ${chalk.green('Running')}  :${port}`,
          `  Data dir  ${chalk.dim(dataDir)}`,
          '',
          chalk.yellow('  ⚠  No auth token — detailed status unavailable.'),
          `  Set ${chalk.cyan('gateway.auth.token')} in config for full output.`,
          '',
        ].join('\n'),
      );
      process.exit(0);
    }

    try {
      // Fetch all data in parallel
      const [gwStatus, agentResult, sessionResult] = await Promise.all([
        callRpc(port, token, 'gateway.status', {}) as Promise<{
          version: string;
          agents: number;
          uptime: number;
        }>,
        callRpc(port, token, 'agent.list', {}).catch(() => ({ agents: [] })) as Promise<{
          agents: Array<{ id: string; name: string; model: string; role: string }>;
        }>,
        callRpc(port, token, 'session.list', {}).catch(() => ({ sessions: [] })) as Promise<{
          sessions: Array<{ sessionKey: string; agentId: string; lastActivity: number; messageCount: number }>;
        }>,
      ]);

      // Read PID
      let pid = '';
      try {
        const { readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const raw = (await readFile(join(dataDir, 'gateway.pid'), 'utf-8')).trim();
        try { pid = String((JSON.parse(raw) as { pid: number }).pid); } catch { pid = raw; }
      } catch { /* no pid file */ }

      // Format uptime
      const upSeconds = Math.floor(gwStatus.uptime / 1000);
      const upStr = upSeconds < 60
        ? `${upSeconds}s`
        : upSeconds < 3600
          ? `${Math.floor(upSeconds / 60)}m ${upSeconds % 60}s`
          : `${Math.floor(upSeconds / 3600)}h ${Math.floor((upSeconds % 3600) / 60)}m`;

      const agents = agentResult.agents ?? [];
      const sessions = sessionResult.sessions ?? [];

      // Most recently active sessions (top 5)
      const recentSessions = [...sessions]
        .sort((a, b) => b.lastActivity - a.lastActivity)
        .slice(0, 5);

      const sep = chalk.dim('  ' + '─'.repeat(52));

      const lines: string[] = [
        '',
        chalk.bold('  AgentFlyer Status') + chalk.dim(`  v${gwStatus.version ?? GATEWAY_VERSION}`),
        '',
        sep,
        chalk.bold('  Gateway'),
        sep,
        `  ${chalk.green('●')} Status    ${chalk.green('Running')}`,
        `  Port      ${chalk.cyan(String(port))}`,
        `  Uptime    ${chalk.yellow(upStr)}`,
        ...(pid ? [`  PID       ${chalk.dim(pid)}`] : []),
        `  Data dir  ${chalk.dim(dataDir)}`,
      ];

      // Agents section
      lines.push('', sep, chalk.bold(`  Agents (${agents.length})`), sep);
      if (agents.length === 0) {
        lines.push(chalk.dim('  No agents running'));
      } else {
        const idW = Math.max(10, ...agents.map((a) => a.id.length));
        const modelW = Math.max(12, ...agents.map((a) => (a.model ?? '').length));
        lines.push(
          chalk.dim(
            `  ${'ID'.padEnd(idW + 2)}${'MODEL'.padEnd(modelW + 2)}ROLE`,
          ),
        );
        for (const a of agents) {
          lines.push(
            `  ${chalk.cyan(a.id.padEnd(idW + 2))}${chalk.green((a.model ?? '').padEnd(modelW + 2))}${chalk.dim(a.role ?? 'worker')}`,
          );
        }
      }

      // Sessions section
      lines.push('', sep, chalk.bold(`  Sessions (${sessions.length} total)`), sep);
      if (sessions.length === 0) {
        lines.push(chalk.dim('  No sessions found'));
      } else {
        const now = Date.now();
        const fmtAge = (ts: number): string => {
          const sec = Math.floor((now - ts) / 1000);
          if (sec < 60) return `${sec}s ago`;
          if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
          if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
          return `${Math.floor(sec / 86400)}d ago`;
        };
        lines.push(
          chalk.dim('  AGENT              THREAD                  MSGS  LAST ACTIVE'),
        );
        for (const sess of recentSessions) {
          // sessionKey format: "agent:{agentId}:{threadKey}" — use as fallback when agentId is empty
          const parts = sess.sessionKey.split(':');
          const agentId = sess.agentId || (parts.length >= 3 ? parts[1] : '') || '?';
          const agentPart = agentId.padEnd(18);
          const threadPart = (parts.length >= 3 ? parts.slice(2).join(':') : sess.sessionKey).slice(0, 22).padEnd(24);
          const msgs = String(sess.messageCount ?? 0).padStart(4);
          const age = fmtAge(sess.lastActivity);
          lines.push(
            `  ${chalk.cyan(agentPart)}${chalk.dim(threadPart)}${chalk.yellow(msgs)}  ${chalk.dim(age)}`,
          );
        }
        if (sessions.length > 5) {
          lines.push(chalk.dim(`  … and ${sessions.length - 5} more`));
        }
      }

      lines.push('');
      process.stdout.write(lines.join('\n'));
      process.exit(0);
    } catch (err) {
      note(String(err), 'Status error');
      process.exit(1);
    }
  },
});

export { gatewayStop, gatewayStatus };

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
