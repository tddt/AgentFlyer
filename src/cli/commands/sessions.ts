import { defineCommand } from 'citty';
import { spinner, note, outro } from '@clack/prompts';
import chalk from 'chalk';
import { getDefaultConfigDir, loadConfig } from '../../core/config/loader.js';
import { isGatewayRunning } from '../../gateway/lifecycle.js';
import { callRpc } from '../gateway-client.js';

function requireGateway(token: string, s: ReturnType<typeof spinner>): void {
  if (!token) {
    s.stop('No auth token');
    note('Set gateway.auth.token in config or AGENTFLYER_TOKEN env.', 'Error');
    process.exit(1);
  }
}

const sessionsList = defineCommand({
  meta: { name: 'list', description: 'List all sessions' },
  args: {
    agent: { type: 'string', alias: 'a', description: 'Filter by agent ID' },
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
    requireGateway(token, s);

    s.start('Fetching sessions');
    try {
      const sessions = await callRpc(port, token, 'session.list', {}) as Array<{
        sessionKey: string;
        agentId: string;
        channel: string;
        messageCount: number;
        lastActive: string;
      }>;
      s.stop(`${sessions.length} session(s)`);

      const filtered = (args.agent as string | undefined)
        ? sessions.filter((s) => s.agentId === (args.agent as string))
        : sessions;

      if (filtered.length === 0) {
        note('No sessions found.', 'Info');
        return;
      }

      const colKey   = 40;
      const colAgent = 16;
      const colChan  = 12;
      const colMsgs  = 6;
      process.stdout.write(
        '\n  ' +
        chalk.bold('Session Key'.padEnd(colKey)) +
        chalk.bold('Agent'.padEnd(colAgent)) +
        chalk.bold('Channel'.padEnd(colChan)) +
        chalk.bold('Msgs'.padEnd(colMsgs)) +
        '\n',
      );
      process.stdout.write('  ' + '─'.repeat(colKey + colAgent + colChan + colMsgs) + '\n');

      for (const sess of filtered) {
        const lastTime = sess.lastActive
          ? new Date(sess.lastActive).toLocaleString()
          : '—';
        process.stdout.write(
          '  ' +
          chalk.cyan(sess.sessionKey.padEnd(colKey)) +
          (sess.agentId ?? '').padEnd(colAgent) +
          chalk.gray((sess.channel ?? '').padEnd(colChan)) +
          String(sess.messageCount ?? 0).padEnd(colMsgs) +
          chalk.dim('  ' + lastTime) +
          '\n',
        );
      }
      process.stdout.write('\n');
    } catch (err) {
      s.stop(chalk.red('Failed'));
      note(String(err), 'Error');
      process.exit(1);
    }
  },
});

const sessionsShow = defineCommand({
  meta: { name: 'show', description: 'Show messages in a session' },
  args: {
    key: { type: 'positional', description: 'Session key' },
    limit: { type: 'string', alias: 'n', description: 'Max messages to show (default: 50)' },
    config: { type: 'string', alias: 'c', description: 'Path to agentflyer.json' },
  },
  async run({ args }) {
    const dataDir = getDefaultConfigDir();
    const s = spinner();
    s.start('Fetching messages');

    const running = await isGatewayRunning(dataDir);
    if (!running) {
      s.stop(chalk.red('Gateway is not running'));
      process.exit(1);
    }

    const cfg = loadConfig(args.config as string | undefined);
    const port = cfg.gateway.port;
    const token = cfg.gateway.auth.token ?? process.env['AGENTFLYER_TOKEN'] ?? '';
    requireGateway(token, s);

    const sessionKey = args.key as string;
    const limit = parseInt((args.limit as string | undefined) ?? '50', 10);

    try {
      const messages = await callRpc(port, token, 'session.messages', { sessionKey, limit }) as Array<{
        role: string;
        content: string | Array<{ type: string; text?: string }>;
        timestamp?: string;
      }>;
      s.stop(`${messages.length} message(s) in ${sessionKey}`);

      process.stdout.write('\n');
      for (const msg of messages) {
        const roleColor = msg.role === 'user' ? chalk.blue : chalk.green;
        const roleLabel = roleColor(chalk.bold(`[${msg.role}]`));
        const text = typeof msg.content === 'string'
          ? msg.content
          : (msg.content as Array<{ type: string; text?: string }>)
              .filter((b) => b.type === 'text')
              .map((b) => b.text ?? '')
              .join('');
        process.stdout.write(roleLabel + '  ' + chalk.dim(msg.timestamp ?? '') + '\n');
        process.stdout.write(text + '\n\n');
      }
    } catch (err) {
      s.stop(chalk.red('Failed'));
      note(String(err), 'Error');
      process.exit(1);
    }
  },
});

const sessionsClear = defineCommand({
  meta: { name: 'clear', description: 'Delete a session and its history' },
  args: {
    key: { type: 'positional', description: 'Session key to clear' },
    config: { type: 'string', alias: 'c', description: 'Path to agentflyer.json' },
  },
  async run({ args }) {
    const dataDir = getDefaultConfigDir();
    const s = spinner();
    s.start('Clearing session');

    const running = await isGatewayRunning(dataDir);
    if (!running) {
      s.stop(chalk.red('Gateway is not running'));
      process.exit(1);
    }

    const cfg = loadConfig(args.config as string | undefined);
    const port = cfg.gateway.port;
    const token = cfg.gateway.auth.token ?? process.env['AGENTFLYER_TOKEN'] ?? '';
    requireGateway(token, s);

    const sessionKey = args.key as string;
    try {
      await callRpc(port, token, 'session.clear', { sessionKey });
      s.stop(chalk.green('Session cleared'));
      outro(`Session ${chalk.cyan(sessionKey)} has been deleted.`);
    } catch (err) {
      s.stop(chalk.red('Failed'));
      note(String(err), 'Error');
      process.exit(1);
    }
  },
});

export const sessionsCommand = defineCommand({
  meta: {
    name: 'sessions',
    description: 'Manage agent conversation sessions',
  },
  subCommands: {
    list: sessionsList,
    show: sessionsShow,
    clear: sessionsClear,
  },
});
