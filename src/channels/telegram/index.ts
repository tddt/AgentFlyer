import { createLogger } from '../../core/logger.js';
import type { AgentId, StreamChunk, ThreadKey } from '../../core/types.js';
import type { Channel, ChannelMessage, InboundHandler } from '../types.js';

const logger = createLogger('channels:telegram');

export interface TelegramChannelOptions {
  botToken: string;
  /** Which agent receives inbound messages. */
  defaultAgentId: AgentId;
  /** Restrict to these chat IDs (empty = allow all). */
  allowedChatIds?: number[];
  /** Long-poll timeout in seconds (passed to Telegram API). */
  pollTimeoutSecs?: number;
  /** Interval between polls in ms. */
  pollIntervalMs?: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string; username?: string; first_name?: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
    date: number;
  };
}

interface TelegramApiResult<T> {
  ok: boolean;
  result: T;
  description?: string;
}

/**
 * TelegramChannel — polls the Telegram Bot API for incoming messages and
 * forwards them to the gateway's InboundHandler.
 *
 * Outbound: `sendMessage` REST call.
 * Inbound:  long-poll `getUpdates` loop.
 */
export class TelegramChannel implements Channel {
  readonly id = 'telegram';
  readonly name = 'Telegram Bot';

  private opts: Required<TelegramChannelOptions>;
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  // Track latest chat IDs so we can reply to the right chat for a thread key.
  private threadChatMap = new Map<ThreadKey, number>();

  constructor(opts: TelegramChannelOptions) {
    this.opts = {
      allowedChatIds: [],
      pollTimeoutSecs: 20,
      pollIntervalMs: 2000,
      ...opts,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private apiUrl(method: string): string {
    return `https://api.telegram.org/bot${this.opts.botToken}/${method}`;
  }

  private async apiGet<T>(
    method: string,
    params: Record<string, string | number> = {},
  ): Promise<T> {
    const url = new URL(this.apiUrl(method));
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Telegram API ${method} HTTP ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as TelegramApiResult<T>;
    if (!data.ok) {
      throw new Error(`Telegram API ${method} error: ${data.description ?? 'unknown'}`);
    }
    return data.result;
  }

  private async apiPost<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.apiUrl(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Telegram API ${method} HTTP ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as TelegramApiResult<T>;
    if (!data.ok) {
      throw new Error(`Telegram API ${method} error: ${data.description ?? 'unknown'}`);
    }
    return data.result;
  }

  // ── Channel interface ─────────────────────────────────────────────────────

  async start(handler: InboundHandler): Promise<void> {
    if (!this.opts.botToken) {
      logger.warn('Telegram channel disabled: botToken not set');
      return;
    }
    this.stopped = false;

    const poll = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        const updates = await this.apiGet<TelegramUpdate[]>('getUpdates', {
          offset: this.offset,
          timeout: this.opts.pollTimeoutSecs,
          allowed_updates: 'message',
        });

        for (const update of updates) {
          this.offset = update.update_id + 1;
          const msg = update.message;
          if (!msg?.text) continue;

          const chatId = msg.chat.id;
          // Allowlist check
          if (this.opts.allowedChatIds.length > 0 && !this.opts.allowedChatIds.includes(chatId)) {
            logger.debug('Telegram message from non-allowed chat ignored', { chatId });
            continue;
          }

          const threadKey = `telegram:${chatId}` as ThreadKey;
          this.threadChatMap.set(threadKey, chatId);

          const channelMsg: ChannelMessage = {
            channelId: this.id,
            agentId: this.opts.defaultAgentId,
            threadKey,
            text: msg.text,
            meta: {
              chatId,
              chatType: msg.chat.type,
              username: msg.from?.username ?? msg.chat.username,
              firstName: msg.from?.first_name ?? msg.chat.first_name,
              messageId: msg.message_id,
            },
            receivedAt: msg.date * 1000,
          };

          handler(channelMsg).catch((err: unknown) => {
            logger.error('Inbound handler error', { error: String(err) });
          });
        }
      } catch (err: unknown) {
        if (!this.stopped) {
          logger.error('Telegram poll error', { error: String(err) });
        }
      }
    };

    logger.info('Telegram channel started', { agentId: this.opts.defaultAgentId });
    // Run poll immediately, then on interval
    void poll();
    this.timer = setInterval(poll, this.opts.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('Telegram channel stopped');
  }

  async sendStream(
    target: { agentId: AgentId; threadKey: ThreadKey },
    stream: AsyncIterable<StreamChunk>,
  ): Promise<void> {
    const chatId = this.threadChatMap.get(target.threadKey);
    if (chatId === undefined) {
      logger.warn('sendStream: no chatId for thread', { threadKey: target.threadKey });
      return;
    }

    // Accumulate the full response then send once
    const parts: string[] = [];
    for await (const chunk of stream) {
      if (chunk.type === 'text_delta') parts.push(chunk.text);
    }
    const text = parts.join('').trim();
    if (!text) return;

    await this.sendToChat(chatId, text);
  }

  async send(target: { agentId: AgentId; threadKey: ThreadKey }, text: string): Promise<void> {
    const chatId = this.threadChatMap.get(target.threadKey);
    if (chatId === undefined) {
      logger.warn('send: no chatId for thread', { threadKey: target.threadKey });
      return;
    }
    await this.sendToChat(chatId, text);
  }

  /** Sends a typing indicator for the given thread (fires-and-forgets on error). */
  async sendTyping(threadKey: ThreadKey): Promise<void> {
    const chatId = this.threadChatMap.get(threadKey);
    if (chatId === undefined) return;
    // Errors are intentionally swallowed — typing failures must never crash the agent.
    await this.apiPost('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(
      () => undefined,
    );
  }

  /** Send a raw message to a specific Telegram chat ID. */
  async sendToChat(chatId: number, text: string): Promise<void> {
    // Telegram's message limit is 4096 chars; split if needed
    const MAX = 4096;
    const chunks = splitText(text, MAX);
    for (const chunk of chunks) {
      await this.apiPost('sendMessage', { chat_id: chatId, text: chunk });
    }
  }
}

/** Split text into chunks no larger than maxLen characters. */
function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    parts.push(text.slice(pos, pos + maxLen));
    pos += maxLen;
  }
  return parts;
}
