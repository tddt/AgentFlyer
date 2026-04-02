import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../core/logger.js';
import { asAgentId, asThreadKey, type AgentId, type StreamChunk, type ThreadKey } from '../../core/types.js';
import type { Channel, ChannelMessage, ContentAttachment, InboundHandler } from '../types.js';

const logger = createLogger('channels:feishu');

export interface FeishuChannelOptions {
  appId: string;
  appSecret: string;
  /**
   * @deprecated Not needed in WebSocket (long connection) mode.
   * Kept for config backward-compatibility only; value is ignored.
   */
  verificationToken?: string;
  /**
   * @deprecated Not needed in WebSocket (long connection) mode.
   * Kept for config backward-compatibility only; value is ignored.
   */
  encryptKey?: string;
  defaultAgentId: AgentId;
  /** Restrict to these Feishu chat IDs (empty = allow all). */
  allowedChatIds?: string[];
  /**
   * Maps Feishu bot display name (or alias) to agentId.
   * When a user \@mentions a bot matching a key here, the message is routed to that agent.
   * Example: { "工人": "worker-1", "主控": "main" }
   */
  agentMappings?: Record<string, string>;
  /** All known agentIds running in this gateway — used to validate direct name @mentions. */
  knownAgentIds?: string[];
}

interface ThreadInfo {
  chatId: string;
  chatType: string;
  messageId: string;
}

/**
 * FeishuChannel — WebSocket long-connection Feishu (Lark) bot integration.
 *
 * Uses the official @larksuiteoapi/node-sdk WSClient — no public webhook URL needed.
 * The channel connects outbound to Feishu's WebSocket endpoint and receives events
 * via a persistent, auto-reconnecting connection.
 *
 * Event types handled: im.message.receive_v1
 * Sends: im.v1.message.create (p2p) / im.v1.message.reply (group @mention)
 */
export class FeishuChannel implements Channel {
  readonly id = 'feishu';
  readonly name = '飞书 (Lark) Bot';

  private opts: Required<Omit<FeishuChannelOptions, 'agentMappings' | 'knownAgentIds'>> &
    Pick<FeishuChannelOptions, 'agentMappings' | 'knownAgentIds'>;
  private client: Lark.Client | null = null;
  private wsClient: Lark.WSClient | null = null;

  // Maps threadKey → last known message context for outbound replies
  private threadMap = new Map<ThreadKey, ThreadInfo>();

  constructor(opts: FeishuChannelOptions) {
    this.opts = {
      verificationToken: '',
      encryptKey: '',
      allowedChatIds: [],
      agentMappings: {},
      knownAgentIds: [],
      ...opts,
    };
  }

  // ── Channel interface ─────────────────────────────────────────────────────

  async start(handler: InboundHandler): Promise<void> {
    if (!this.opts.appId || !this.opts.appSecret) {
      logger.warn('Feishu channel disabled: appId/appSecret not set');
      return;
    }

    const sdkConfig = { appId: this.opts.appId, appSecret: this.opts.appSecret };

    this.client = new Lark.Client(sdkConfig);

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        const { message, sender } = data;
        const { chat_id, chat_type, message_type, content, message_id } = message;

        if (this.opts.allowedChatIds.length > 0 && !this.opts.allowedChatIds.includes(chat_id)) {
          logger.debug('Feishu message from non-allowed chat skipped', { chatId: chat_id });
          return;
        }

        // Only handle text messages
        let text = '';
        let resolvedAgentId: AgentId = this.opts.defaultAgentId;
        if (message_type === 'text') {
          try {
            const parsed = JSON.parse(content) as {
              text?: string;
              mentions?: Array<{ key: string; name?: string; id?: { open_id?: string } }>;
            };

            const rawText = parsed.text ?? '';
            const mentionsList = parsed.mentions ?? [];

            logger.debug('Feishu message raw', {
              rawText,
              mentions: mentionsList.map((m) => ({ key: m.key, name: m.name })),
              agentMappings: this.opts.agentMappings,
              knownAgentIds: this.opts.knownAgentIds,
            });

            // Strategy 1: check actual Feishu @mentions (for real bot @mentions in group chats)
            for (const mention of mentionsList) {
              const name = mention.name ?? '';
              const mapped = this.opts.agentMappings?.[name];
              if (mapped) {
                try {
                  resolvedAgentId = asAgentId(mapped);
                  break;
                } catch {
                  continue;
                }
              }
              if (name && this.opts.knownAgentIds?.includes(name)) {
                try {
                  resolvedAgentId = asAgentId(name);
                  break;
                } catch {
                  continue;
                }
              }
            }

            // Strategy 2: scan raw text for @agentAlias patterns (user types "@一号工人 ..." as plain text)
            // This handles p2p chats and cases where the alias is not a real Feishu bot entity.
            if (resolvedAgentId === this.opts.defaultAgentId) {
              for (const [alias, targetId] of Object.entries(this.opts.agentMappings ?? {})) {
                if (rawText.includes(`@${alias}`)) {
                  try {
                    resolvedAgentId = asAgentId(targetId);
                    logger.debug('Feishu routing via text @alias', { alias, agentId: targetId });
                    break;
                  } catch {
                    continue;
                  }
                }
              }
            }
            // Strategy 3: direct agentId mentioned in text (e.g. "@worker-1 ...")
            if (resolvedAgentId === this.opts.defaultAgentId) {
              for (const agentId of this.opts.knownAgentIds ?? []) {
                if (rawText.includes(`@${agentId}`)) {
                  try {
                    resolvedAgentId = asAgentId(agentId);
                    logger.debug('Feishu routing via text agentId', { agentId });
                    break;
                  } catch {
                    continue;
                  }
                }
              }
            }

            // Strip @placeholder tokens (Feishu keys like "@_user_1") AND custom @alias patterns
            text = rawText.replace(/@\S+\s*/g, '').trim();
          } catch {
            /* ignore malformed content */
          }
        }
        if (!text) return;

        const threadKey = asThreadKey(`feishu:${chat_id}`);
        this.threadMap.set(threadKey, {
          chatId: chat_id,
          chatType: chat_type,
          messageId: message_id,
        });

        const channelMsg: ChannelMessage = {
          channelId: this.id,
          agentId: resolvedAgentId,
          threadKey,
          text,
          meta: {
            chatId: chat_id,
            chatType: chat_type,
            messageId: message_id,
            senderId: sender.sender_id?.open_id ?? '',
          },
          receivedAt: Date.now(),
        };

        handler(channelMsg).catch((e: unknown) => {
          logger.error('Inbound handler error', { error: String(e) });
        });
      },
    });

    this.wsClient = new Lark.WSClient(sdkConfig);
    // start() runs an indefinite reconnect loop; do not await
    this.wsClient.start({ eventDispatcher }).catch((err: unknown) => {
      logger.error('Feishu WSClient fatal error', { error: String(err) });
    });

    logger.info('Feishu channel started (WebSocket mode)', { agentId: this.opts.defaultAgentId });
  }

  async stop(): Promise<void> {
    this.wsClient?.close({ force: true });
    this.wsClient = null;
    this.client = null;
    logger.info('Feishu channel stopped');
  }

  async sendStream(
    target: { agentId: AgentId; threadKey: ThreadKey },
    stream: AsyncIterable<StreamChunk>,
  ): Promise<void> {
    const parts: string[] = [];
    for await (const chunk of stream) {
      if (chunk.type === 'text_delta') parts.push(chunk.text);
    }
    const text = parts.join('').trim();
    if (text) await this.sendToChat(target.threadKey, text);
  }

  async send(target: { agentId: AgentId; threadKey: ThreadKey }, text: string): Promise<void> {
    await this.sendToChat(target.threadKey, text);
  }

  /** Send a plain-text reply to the Feishu chat associated with this thread. */
  async sendToChat(threadKey: ThreadKey, text: string): Promise<void> {
    const info = this.threadMap.get(threadKey);
    if (!info) {
      logger.warn('sendToChat: no thread info for key', { threadKey });
      return;
    }
    if (!this.client) {
      logger.warn('sendToChat: Feishu client not initialized');
      return;
    }

    const MAX = 4000;
    const parts = text.length <= MAX ? [text] : splitText(text, MAX);

    for (const part of parts) {
      try {
        if (info.chatType === 'group') {
          // RATIONALE: Reply threads the response under the original @mention in groups
          await this.client.im.v1.message.reply({
            path: { message_id: info.messageId },
            data: { content: JSON.stringify({ text: part }), msg_type: 'text' },
          });
        } else {
          // p2p: send a new message to the chat
          await this.client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: info.chatId,
              content: JSON.stringify({ text: part }),
              msg_type: 'text',
            },
          });
        }
      } catch (err: unknown) {
        logger.error('Feishu send message failed', { error: String(err), chatId: info.chatId });
      }
    }
  }
  /** Upload a file or image to Feishu and send it as a message to the thread's chat. */
  async sendAttachment(
    target: { agentId: AgentId; threadKey: ThreadKey },
    attachment: ContentAttachment,
  ): Promise<void> {
    const info = this.threadMap.get(target.threadKey);
    if (!info) {
      logger.warn('sendAttachment: no thread info for key', { threadKey: target.threadKey });
      return;
    }
    if (!this.client) {
      logger.warn('sendAttachment: Feishu client not initialized');
      return;
    }

    const { filePath, mimeType, name } = attachment;
    const displayName = name ?? basename(filePath);

    try {
      if (mimeType.startsWith('image/')) {
        // Upload image and send as image message
        const uploadResp = await this.client.im.v1.image.create({
          data: { image_type: 'message', image: createReadStream(filePath) },
        });
        const imageKey = (uploadResp as { image_key?: string }).image_key;
        if (!imageKey) throw new Error('Feishu image upload returned no image_key');

        await this.client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: info.chatId,
            msg_type: 'image',
            content: JSON.stringify({ image_key: imageKey }),
          },
        });
      } else {
        // Upload file and send as file message
        const uploadResp = await this.client.im.v1.file.create({
          data: {
            file_type: 'stream',
            file_name: displayName,
            file: createReadStream(filePath),
          },
        });
        const fileKey = (uploadResp as { file_key?: string }).file_key;
        if (!fileKey) throw new Error('Feishu file upload returned no file_key');

        await this.client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: info.chatId,
            msg_type: 'file',
            content: JSON.stringify({ file_key: fileKey }),
          },
        });
      }

      logger.info('Feishu attachment sent', { chatId: info.chatId, displayName, mimeType });
    } catch (err: unknown) {
      logger.error('Feishu sendAttachment failed', {
        error: String(err),
        chatId: info.chatId,
        displayName,
      });
      throw err;
    }
  }
}

function splitText(text: string, maxLen: number): string[] {
  const parts: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    parts.push(text.slice(pos, pos + maxLen));
    pos += maxLen;
  }
  return parts;
}
