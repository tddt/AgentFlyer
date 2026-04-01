import { createLogger } from '../../core/logger.js';
import type { AgentId, StreamChunk, ThreadKey } from '../../core/types.js';
import type { Channel, ChannelMessage, InboundHandler } from '../types.js';

const logger = createLogger('channels:discord');

export interface DiscordChannelOptions {
  botToken: string;
  /** Which agent receives inbound messages. */
  defaultAgentId: AgentId;
  /** Only respond in these channel IDs (empty = all channels in guilds). */
  allowedChannelIds?: string[];
  /** Prefix that triggers the bot (default '!agent'). */
  commandPrefix?: string;
}

// ── Discord Gateway constants ────────────────────────────────────────────────
const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_GW_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

/** Discord opcodes we care about. */
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_MESSAGE_CONTENT = 1 << 15;

interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

interface MessageCreateEvent {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string; username: string; bot?: boolean };
  timestamp: string;
}

/**
 * DiscordChannel — connects to Discord Gateway via WebSocket.
 *
 * Inbound: listens for MESSAGE_CREATE events; responds when message starts
 *          with `commandPrefix` (default '!agent').
 * Outbound: Discord REST  POST /channels/{id}/messages.
 */
export class DiscordChannel implements Channel {
  readonly id = 'discord';
  readonly name = 'Discord Bot';

  private opts: Required<DiscordChannelOptions>;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private stopped = false;
  private handler: InboundHandler | null = null;

  // Maps threadKey → Discord channel ID for replies
  private threadChannelMap = new Map<ThreadKey, string>();

  constructor(opts: DiscordChannelOptions) {
    this.opts = {
      allowedChannelIds: [],
      commandPrefix: '!agent',
      ...opts,
    };
  }

  // ── REST helpers ─────────────────────────────────────────────────────────

  private async restPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${DISCORD_API}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${this.opts.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Discord API POST ${path} HTTP ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  // ── WebSocket / Gateway ──────────────────────────────────────────────────

  private connect(url: string): void {
    this.ws = new WebSocket(url);

    this.ws.addEventListener('open', () => {
      logger.debug('Discord WS open');
    });

    this.ws.addEventListener('close', (ev) => {
      logger.warn('Discord WS closed', { code: ev.code });
      this.clearHeartbeat();
      if (!this.stopped) this.scheduleReconnect();
    });

    this.ws.addEventListener('error', (ev) => {
      logger.error('Discord WS error', { msg: String(ev) });
    });

    this.ws.addEventListener('message', (ev) => {
      let payload: GatewayPayload;
      try {
        payload = JSON.parse(ev.data as string) as GatewayPayload;
      } catch {
        return;
      }
      this.handlePayload(payload);
    });
  }

  private handlePayload(payload: GatewayPayload): void {
    if (payload.s !== null && payload.s !== undefined) {
      this.seq = payload.s;
    }

    switch (payload.op) {
      case OP.HELLO: {
        const d = payload.d as { heartbeat_interval: number };
        this.startHeartbeat(d.heartbeat_interval);
        this.identify();
        break;
      }
      case OP.HEARTBEAT_ACK:
        logger.debug('Heartbeat ACK');
        break;
      case OP.HEARTBEAT:
        this.sendHeartbeat();
        break;
      case OP.RECONNECT:
        logger.info('Discord requested reconnect');
        this.ws?.close();
        break;
      case OP.INVALID_SESSION:
        logger.warn('Invalid session; re-identifying');
        this.sessionId = null;
        setTimeout(() => this.identify(), 1000 + Math.random() * 4000);
        break;
      case OP.DISPATCH:
        this.handleDispatch(payload);
        break;
    }
  }

  private handleDispatch(payload: GatewayPayload): void {
    if (payload.t === 'READY') {
      const d = payload.d as { session_id: string; resume_gateway_url: string };
      this.sessionId = d.session_id;
      this.resumeUrl = d.resume_gateway_url;
      logger.info('Discord Gateway READY', { sessionId: this.sessionId });
    }

    if (payload.t === 'MESSAGE_CREATE') {
      const msg = payload.d as MessageCreateEvent;
      // Ignore bot messages
      if (msg.author?.bot) return;

      const channelId = msg.channel_id;
      // Allowlist check
      if (
        this.opts.allowedChannelIds.length > 0 &&
        !this.opts.allowedChannelIds.includes(channelId)
      )
        return;

      // Prefix check
      const prefix = this.opts.commandPrefix;
      if (!msg.content.startsWith(prefix)) return;

      const text = msg.content.slice(prefix.length).trim();
      if (!text) return;

      const threadKey = `discord:${channelId}` as ThreadKey;
      this.threadChannelMap.set(threadKey, channelId);

      const channelMsg: ChannelMessage = {
        channelId: this.id,
        agentId: this.opts.defaultAgentId,
        threadKey,
        text,
        meta: {
          discordChannelId: channelId,
          messageId: msg.id,
          authorId: msg.author.id,
          username: msg.author.username,
        },
        receivedAt: new Date(msg.timestamp).getTime(),
      };

      this.handler?.(channelMsg).catch((err: unknown) => {
        logger.error('Inbound handler error', { error: String(err) });
      });
    }
  }

  private identify(): void {
    this.sendWs({
      op: OP.IDENTIFY,
      d: {
        token: this.opts.botToken,
        intents: INTENT_GUILD_MESSAGES | INTENT_MESSAGE_CONTENT,
        properties: { os: 'linux', browser: 'agentflyer', device: 'agentflyer' },
      },
    });
  }

  private sendWs(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
    // Jitter on first heartbeat
    setTimeout(() => this.sendHeartbeat(), Math.random() * intervalMs);
  }

  private sendHeartbeat(): void {
    this.sendWs({ op: OP.HEARTBEAT, d: this.seq });
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    setTimeout(() => {
      if (this.stopped) return;
      logger.info('Discord reconnecting...');
      const url = this.resumeUrl ?? DISCORD_GW_URL;
      this.connect(url);
    }, 5000);
  }

  // ── Channel interface ─────────────────────────────────────────────────────

  async start(handler: InboundHandler): Promise<void> {
    if (!this.opts.botToken) {
      logger.warn('Discord channel disabled: botToken not set');
      return;
    }
    this.handler = handler;
    this.stopped = false;
    logger.info('Discord channel starting', { agentId: this.opts.defaultAgentId });
    this.connect(DISCORD_GW_URL);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearHeartbeat();
    this.ws?.close();
    this.ws = null;
    logger.info('Discord channel stopped');
  }

  async sendStream(
    target: { agentId: AgentId; threadKey: ThreadKey },
    stream: AsyncIterable<StreamChunk>,
  ): Promise<void> {
    const channelId = this.threadChannelMap.get(target.threadKey);
    if (!channelId) {
      logger.warn('sendStream: no channelId for thread', { threadKey: target.threadKey });
      return;
    }
    const parts: string[] = [];
    for await (const chunk of stream) {
      if (chunk.type === 'text_delta') parts.push(chunk.text);
    }
    const text = parts.join('').trim();
    if (text) await this.sendToChannel(channelId, text);
  }

  async send(target: { agentId: AgentId; threadKey: ThreadKey }, text: string): Promise<void> {
    const channelId = this.threadChannelMap.get(target.threadKey);
    if (!channelId) {
      logger.warn('send: no channelId for thread', { threadKey: target.threadKey });
      return;
    }
    await this.sendToChannel(channelId, text);
  }

  /** Sends a typing indicator to the Discord channel for this thread. */
  async sendTyping(threadKey: ThreadKey): Promise<void> {
    const channelId = this.threadChannelMap.get(threadKey);
    if (!channelId) return;
    // Discord typing indicator lasts 10s; we pulse every 3s for safety.
    // Errors are intentionally swallowed — typing failures must never crash the agent.
    await fetch(`${DISCORD_API}/channels/${channelId}/typing`, {
      method: 'POST',
      headers: { Authorization: `Bot ${this.opts.botToken}` },
    }).catch(() => undefined);
  }

  /** Low-level send to a Discord text channel, splitting >2000 char messages. */
  async sendToChannel(channelId: string, text: string): Promise<void> {
    // Discord max message length is 2000 chars
    const MAX = 2000;
    const chunks = splitText(text, MAX);
    for (const chunk of chunks) {
      await this.restPost(`/channels/${channelId}/messages`, { content: chunk });
    }
  }
}

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
