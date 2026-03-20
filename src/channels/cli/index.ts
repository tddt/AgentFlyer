import * as readline from 'node:readline';
import * as process from 'node:process';
import chalk from 'chalk';
import { createLogger } from '../../core/logger.js';
import type { AgentId, ThreadKey, StreamChunk } from '../../core/types.js';
import type { Channel, InboundHandler, ChannelMessage } from '../types.js';

const logger = createLogger('channels:cli');

export interface CliChannelOptions {
  /** Target agent for stdin messages. */
  agentId: AgentId;
  /** Default thread key for the CLI session. */
  threadKey?: ThreadKey;
  /** Prompt string shown before each user input line. */
  prompt?: string;
  /** Whether to show token count stats after each turn. */
  showStats?: boolean;
}

/**
 * CLIChannel — reads from stdin and writes to stdout.
 * Used by `agentflyer chat` for interactive conversations.
 */
export class CliChannel implements Channel {
  readonly id = 'cli';
  readonly name = 'CLI / stdin-stdout';

  private rl: readline.Interface | null = null;
  private stopped = false;
  private opts: Required<CliChannelOptions>;

  constructor(opts: CliChannelOptions) {
    this.opts = {
      threadKey: 'cli-default' as ThreadKey,
      prompt: chalk.cyan('You: '),
      showStats: false,
      ...opts,
    };
  }

  async start(handler: InboundHandler): Promise<void> {
    this.stopped = false;
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY,
    });

    logger.info('CLI channel started', { agentId: this.opts.agentId });

    // Interactive prompt loop
    const ask = (): void => {
      if (this.stopped) return;
      this.rl?.question(this.opts.prompt, async (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) { ask(); return; }
        if (trimmed === '/exit' || trimmed === '/quit') {
          process.stdout.write('Goodbye!\n');
          this.stop().catch(() => undefined);
          return;
        }
        const msg: ChannelMessage = {
          channelId: this.id,
          agentId: this.opts.agentId,
          threadKey: this.opts.threadKey,
          text: trimmed,
          receivedAt: Date.now(),
        };
        try {
          await handler(msg);
        } catch (err) {
          process.stderr.write(`\n${chalk.red('Error:')} ${String(err)}\n`);
        }
        ask();
      });
    };

    ask();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.rl?.close();
    this.rl = null;
  }

  async sendStream(
    _target: { agentId: AgentId; threadKey: ThreadKey },
    stream: AsyncIterable<StreamChunk>,
  ): Promise<void> {
    process.stdout.write(chalk.green('Agent: '));
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of stream) {
      if (chunk.type === 'text_delta') {
        process.stdout.write(chunk.text);
      } else if (chunk.type === 'done') {
        inputTokens = chunk.inputTokens;
        outputTokens = chunk.outputTokens;
      } else if (chunk.type === 'error') {
        process.stdout.write(`\n${chalk.red('[error]')} ${chunk.message}`);
      }
      // tool_use_delta: suppress from CLI output (tool activity shown inline)
    }

    process.stdout.write('\n');

    if (this.opts.showStats) {
      process.stdout.write(
        chalk.gray(`  [${inputTokens} in / ${outputTokens} out tokens]\n`),
      );
    }
  }

  async send(
    _target: { agentId: AgentId; threadKey: ThreadKey },
    text: string,
  ): Promise<void> {
    process.stdout.write(`${chalk.green('Agent:')} ${text}\n`);
  }
}
