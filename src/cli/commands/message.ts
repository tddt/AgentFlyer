import { defineCommand } from 'citty';
import { spinner, note, outro } from '@clack/prompts';
import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import { getDefaultConfigDir, loadConfig } from '../../core/config/loader.js';
import { isGatewayRunning } from '../../gateway/lifecycle.js';
import { streamChatFromGateway } from '../gateway-client.js';

export const messageCommand = defineCommand({
  meta: {
    name: 'message',
    description: 'Send a message to an agent',
  },
  subCommands: {
    send: defineCommand({
      meta: { name: 'send', description: 'Send a message to an agent (streaming)' },
      args: {
        agent: {
          type: 'positional',
          description: 'Agent ID to send the message to',
        },
        text: {
          type: 'positional',
          description: 'Message text (omit when using --file)',
          required: false,
        },
        file: {
          type: 'string',
          alias: 'f',
          description: 'Read message content from this file path',
        },
        thread: {
          type: 'string',
          alias: 't',
          description: 'Thread / session key (default: cli-default)',
          default: 'cli-default',
        },
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
        s.stop('Connected');

        const cfg = loadConfig(args.config as string | undefined);
        const port = cfg.gateway.port;
        const token = cfg.gateway.auth.token ?? process.env['AGENTFLYER_TOKEN'] ?? '';
        if (!token) {
          note('Set gateway.auth.token in config or AGENTFLYER_TOKEN env.', 'Error');
          process.exit(1);
        }

        const agentId = args.agent as string;
        let text = (args.text as string | undefined) ?? '';
        if (args.file) {
          try {
            text = await readFile(args.file as string, 'utf-8');
          } catch (err) {
            note(`Cannot read file: ${String(err)}`, 'Error');
            process.exit(1);
          }
        }
        if (!text.trim()) {
          note('Provide message text or --file path.', 'Error');
          process.exit(1);
        }

        const thread = (args.thread as string) || 'cli-default';
        process.stdout.write(chalk.dim(`\n  [${agentId}] ↗ streaming…\n\n`));

        try {
          for await (const chunk of streamChatFromGateway({ port, token, agentId, message: text, thread })) {
            if (chunk.type === 'text_delta' && chunk.text) {
              process.stdout.write(chunk.text);
            }
          }
          process.stdout.write('\n');
          outro(chalk.green('Done'));
        } catch (err) {
          note(String(err), 'Error');
          process.exit(1);
        }
      },
    }),
  },
});
