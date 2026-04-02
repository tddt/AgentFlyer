import { intro, note } from '@clack/prompts';
import chalk from 'chalk';
import { defineCommand } from 'citty';
import { CliChannel } from '../../channels/cli/index.js';
import type { ChannelMessage } from '../../channels/types.js';
import { loadConfig } from '../../core/config/loader.js';
import { getDefaultConfigDir } from '../../core/config/loader.js';
import { setLogLevel } from '../../core/logger.js';
import { type StreamChunk, asAgentId, asThreadKey } from '../../core/types.js';
import { isGatewayRunning, startGateway } from '../../gateway/lifecycle.js';
import { streamChatFromGateway } from '../gateway-client.js';

export const chatCommand = defineCommand({
  meta: {
    name: 'chat',
    description: 'Start an interactive chat with an agent',
  },
  args: {
    agent: {
      type: 'string',
      alias: 'a',
      description: 'Agent ID to chat with (default: first configured agent)',
    },
    thread: {
      type: 'string',
      alias: 't',
      description: 'Thread key for session continuity',
      default: 'cli-default',
    },
    config: {
      type: 'string',
      alias: 'c',
      description: 'Path to agentflyer.json',
    },
    stats: {
      type: 'boolean',
      description: 'Show token usage after each turn',
      default: false,
    },
    verbose: {
      type: 'boolean',
      alias: 'v',
      default: false,
      description: 'Enable verbose logging',
    },
  },
  async run({ args }) {
    if (args.verbose) setLogLevel('debug');
    // Suppress info logs in interactive mode unless verbose
    else setLogLevel('warn');

    intro(chalk.bold.cyan('AgentFlyer Chat'));

    const dataDir = getDefaultConfigDir();

    let config: ReturnType<typeof loadConfig>;
    try {
      config = loadConfig(args.config as string | undefined);
    } catch (err) {
      note(String(err), 'Config error');
      process.exit(1);
    }

    // Pick target agent
    const agentId = (args.agent as string | undefined) ?? config.agents[0]?.id;
    if (!agentId) {
      note('No agents configured. Add an agent to agentflyer.json.', 'Error');
      process.exit(1);
    }
    const agentCfg = config.agents.find((a) => a.id === agentId);
    if (!agentCfg) {
      note(`Agent '${agentId}' not found in config.`, 'Error');
      process.exit(1);
    }

    const brandedAgentId = asAgentId(agentId);
    const threadKey = asThreadKey(args.thread as string);
    const channel = new CliChannel({
      agentId: brandedAgentId,
      threadKey,
      showStats: Boolean(args.stats),
    });

    // ── Detect whether a gateway is already running ───────────────────────
    const gatewayRunning = await isGatewayRunning(dataDir);

    if (gatewayRunning) {
      // ── Remote mode: connect to the running gateway via HTTP SSE ─────────
      const port = config.gateway.port;
      const token = config.gateway.auth.token ?? process.env.AGENTFLYER_TOKEN ?? '';
      if (!token) {
        note('No auth token found. Set gateway.auth.token in agentflyer.json.', 'Error');
        process.exit(1);
      }

      note(
        [
          `Agent:  ${chalk.green(agentId)}`,
          `Model:  ${chalk.cyan(agentCfg.model ?? config.defaults.model)}`,
          `Thread: ${chalk.gray(threadKey)}`,
          `Mode:   ${chalk.yellow('connected to running gateway')} (:${port})`,
          '',
          'Type your message and press Enter.',
          'Commands: /exit  /stats',
        ].join('\n'),
        'Ready',
      );

      await channel.start(async (msg: ChannelMessage) => {
        const text = msg.text;
        if (text === '/stats') {
          process.stdout.write(chalk.gray(`Agent: ${agentId} | Thread: ${threadKey}\n`));
          return;
        }

        async function* remoteStream(): AsyncIterable<StreamChunk> {
          yield* streamChatFromGateway({
            port,
            token,
            agentId: brandedAgentId,
            message: text,
            thread: threadKey,
          });
        }
        await channel.sendStream({ agentId: brandedAgentId, threadKey }, remoteStream());
      });
    } else {
      // ── Local mode: start gateway in-process ──────────────────────────────
      const instance = await startGateway(config, dataDir);
      const runner = instance.state.runners.get(agentId);
      if (!runner) {
        note(`Runner for agent '${agentId}' failed to initialise.`, 'Error');
        process.exit(1);
      }
      runner.setThread(threadKey);

      note(
        [
          `Agent:  ${chalk.green(agentId)}`,
          `Model:  ${chalk.cyan(agentCfg.model ?? config.defaults.model)}`,
          `Thread: ${chalk.gray(threadKey)}`,
          `Mode:   ${chalk.gray('embedded (no separate gateway)')}`,
          '',
          'Type your message and press Enter.',
          'Commands: /exit  /clear  /stats',
        ].join('\n'),
        'Ready',
      );

      await channel.start(async (msg: ChannelMessage) => {
        const text = msg.text;

        if (text === '/clear') {
          await runner.clearHistory();
          process.stdout.write(chalk.gray('History cleared.\n'));
          return;
        }
        if (text === '/stats') {
          process.stdout.write(chalk.gray(`Session: ${runner.currentSessionKey}\n`));
          return;
        }

        const gen = runner.turn(text);
        async function* streamChunks(): AsyncIterable<StreamChunk> {
          let next = await gen.next();
          while (!next.done) {
            yield next.value as StreamChunk;
            next = await gen.next();
          }
        }
        await channel.sendStream({ agentId: brandedAgentId, threadKey }, streamChunks());
      });
    }
  },
});
