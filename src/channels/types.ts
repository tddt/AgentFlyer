import type { AgentId, StreamChunk, ThreadKey } from '../core/types.js';

/** A single inbound message from a channel. */
export interface ChannelMessage {
  channelId: string;
  agentId: AgentId;
  threadKey: ThreadKey;
  text: string;
  /** Raw channel-specific metadata (e.g. username, chat id). */
  meta?: Record<string, unknown>;
  receivedAt: number;
}

/** Response sent back to a channel. */
export interface ChannelResponse {
  channelId: string;
  agentId: AgentId;
  threadKey: ThreadKey;
  text: string;
  isError: boolean;
}

/** Handler that the gateway passes incoming messages to. */
export type InboundHandler = (msg: ChannelMessage) => Promise<void>;

/**
 * A file or media attachment that can optionally be shared through a channel.
 */
export interface ContentAttachment {
  /** Absolute path on disk. */
  filePath: string;
  /** MIME type, e.g. "image/png". Used by channels to choose the appropriate API. */
  mimeType: string;
  /** Human-readable file name shown to the recipient. */
  name?: string;
}

/**
 * A Channel is a two-way communication adapter.
 * The gateway calls `start()` on all registered channels.
 */
export interface Channel {
  /** Unique identifier, e.g. 'cli', 'web', 'telegram'. */
  readonly id: string;

  /** Human-readable name for logging/UI. */
  readonly name: string;

  /** Called by the gateway to start listening. */
  start(handler: InboundHandler): Promise<void>;

  /** Called by the gateway to shut down. */
  stop(): Promise<void>;

  /** Stream a response back to the originating user/session. */
  sendStream(
    target: { agentId: AgentId; threadKey: ThreadKey },
    stream: AsyncIterable<StreamChunk>,
  ): Promise<void>;

  /** Send a plain text response. */
  send(target: { agentId: AgentId; threadKey: ThreadKey }, text: string): Promise<void>;

  /**
   * Send a file/image attachment to a target thread.
   * Optional — channels that do not support binary uploads may leave this undefined.
   */
  sendAttachment?(
    target: { agentId: AgentId; threadKey: ThreadKey },
    attachment: ContentAttachment,
  ): Promise<void>;

  /**
   * Send a typing indicator to the thread.
   * Optional — channels that do not expose a typing API may leave this undefined.
   * Intended to be called repeatedly (e.g. via TypingKeepAlive) while the agent
   * is processing, so the user sees "typing…" until the reply arrives.
   */
  sendTyping?(threadKey: ThreadKey): Promise<void>;
}
