import * as crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '../../core/logger.js';
import { asThreadKey, type AgentId, type StreamChunk, type ThreadKey } from '../../core/types.js';
import type { Channel, ChannelMessage, InboundHandler } from '../types.js';

const logger = createLogger('channels:qq');

const QQ_API = 'https://api.sgroup.qq.com';
const QQ_TOKEN_API = 'https://bots.qq.com/app/getAppAccessToken';

export interface QQChannelOptions {
  appId: string;
  /** App client secret from QQ Open Platform developer portal. */
  clientSecret: string;
  defaultAgentId: AgentId;
  /** Command prefix — messages must start with this to be processed (default '@bot'). */
  commandPrefix?: string;
  /** Restrict to these group openids (empty = allow all). */
  allowedGroupIds?: string[];
}

interface QQAccessTokenResp {
  access_token: string;
  expires_in: string;
}

/**
 * QQChannel — webhook-based QQ open-platform bot.
 *
 * Receive: POST /channels/qq/event  (QQ pushes events here)
 *          OP 13 verification challenge is handled automatically.
 * Send:    QQ REST API  POST /v2/groups/{group_openid}/messages
 *
 * Events handled: GROUP_AT_MESSAGE_CREATE, C2C_MESSAGE_CREATE
 *
 * IMPORTANT: QQ group bot replies MUST include the `msg_id` of the
 * triggering message (enforced by QQ anti-spam policy).
 */
export class QQChannel implements Channel {
  readonly id = 'qq';
  readonly name = 'QQ 开放平台 Bot';

  private opts: Required<QQChannelOptions>;
  private accessToken = '';
  private tokenExpireAt = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private handler: InboundHandler | null = null;
  private _webhookHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null =
    null;

  // Maps threadKey → { groupOpenid, msgId } for replies
  private threadMeta = new Map<
    ThreadKey,
    { groupOpenid: string; msgId: string; isC2C: boolean; openid: string }
  >();

  constructor(opts: QQChannelOptions) {
    this.opts = {
      commandPrefix: '',
      allowedGroupIds: [],
      ...opts,
    };
  }

  // ── Token management ──────────────────────────────────────────────────────

  private async refreshToken(): Promise<void> {
    const res = await fetch(QQ_TOKEN_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.opts.appId, clientSecret: this.opts.clientSecret }),
    });
    if (!res.ok) throw new Error(`QQ token HTTP ${res.status}`);
    const data = (await res.json()) as QQAccessTokenResp;
    if (!data.access_token) throw new Error('QQ token response missing access_token');
    this.accessToken = data.access_token;
    const expiresIn = Number.parseInt(data.expires_in, 10);
    this.tokenExpireAt = Date.now() + (expiresIn - 60) * 1000;
    logger.debug('QQ access token refreshed');
  }

  private async getToken(): Promise<string> {
    if (!this.accessToken || Date.now() >= this.tokenExpireAt) {
      await this.refreshToken();
    }
    return this.accessToken;
  }

  // ── ED25519 signature for OP 13 challenge ─────────────────────────────────

  // RATIONALE: QQ bot verification uses ED25519 with the clientSecret as
  // the private key seed (first 32 bytes, zero-padded). We build a PKCS8
  // DER structure to import it via Node.js crypto.
  private signChallenge(eventTs: string, plainToken: string): string {
    const seed = Buffer.alloc(32);
    const secretBuf = Buffer.from(this.opts.clientSecret, 'utf-8');
    secretBuf.copy(seed, 0, 0, Math.min(secretBuf.length, 32));

    // PKCS8 DER header for Ed25519 private key: OID 1.3.101.112
    const pkcs8Header = Buffer.from('302e020100300506032b657004220420', 'hex');
    const pkcs8Der = Buffer.concat([pkcs8Header, seed]);

    const privateKey = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });
    const message = Buffer.from(eventTs + plainToken, 'utf-8');
    const signature = crypto.sign(null, message, privateKey);
    return signature.toString('hex');
  }

  // ── REST helpers ──────────────────────────────────────────────────────────

  private async apiPost(path: string, body: Record<string, unknown>): Promise<unknown> {
    const token = await this.getToken();
    const res = await fetch(`${QQ_API}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`QQ API POST ${path} HTTP ${res.status}: ${text}`);
    }
    return res.json();
  }

  // ── Webhook handler ───────────────────────────────────────────────────────

  getWebhookHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
    if (!this._webhookHandler) throw new Error('Call QQChannel.start() first');
    return this._webhookHandler;
  }

  // ── Channel interface ─────────────────────────────────────────────────────

  async start(handler: InboundHandler): Promise<void> {
    if (!this.opts.appId || !this.opts.clientSecret) {
      logger.warn('QQ channel disabled: appId/clientSecret not set');
      return;
    }
    this.handler = handler;
    await this.refreshToken();

    // Auto-refresh token every 100 minutes
    this.refreshTimer = setInterval(
      () => {
        this.refreshToken().catch((e: unknown) => {
          logger.error('QQ token refresh failed', { error: String(e) });
        });
      },
      100 * 60 * 1000,
    );

    this._webhookHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', resolve);
        req.on('error', reject);
      });
      const rawBody = Buffer.concat(chunks).toString('utf-8');

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const op = payload.op as number | undefined;

      // ── OP 13: Webhook validation challenge ──────────────────────────────
      if (op === 13) {
        const d = payload.d as Record<string, string> | undefined;
        if (!d) {
          res.writeHead(400);
          res.end('{}');
          return;
        }
        const { plain_token: plainToken, event_ts: eventTs } = d;
        if (!plainToken || !eventTs) {
          res.writeHead(400);
          res.end('{}');
          return;
        }
        const signature = this.signChallenge(eventTs, plainToken);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ plain_token: plainToken, signature }));
        return;
      }

      // Acknowledge all other events first, then process
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');

      // ── OP 0: Event dispatch ──────────────────────────────────────────────
      if (op !== 0) return;

      const eventType = payload.t as string | undefined;
      const d = payload.d as Record<string, unknown> | undefined;
      if (!d) return;

      let text = '';
      let threadKey: ThreadKey;
      let groupOpenid = '';
      let openid = '';
      let msgId = '';
      let isC2C = false;

      if (eventType === 'GROUP_AT_MESSAGE_CREATE') {
        // Group @mention message
        groupOpenid = (d.group_openid as string) ?? '';
        openid = (d.author as Record<string, string> | undefined)?.member_openid ?? '';
        msgId = (d.id as string) ?? '';
        const rawContent = (d.content as string) ?? '';
        text = rawContent.replace(/<@!\d+>/g, '').trim(); // strip @bot mention

        if (
          this.opts.allowedGroupIds.length > 0 &&
          !this.opts.allowedGroupIds.includes(groupOpenid)
        ) {
          logger.debug('QQ group message from non-allowed group skipped', { groupOpenid });
          return;
        }
        threadKey = asThreadKey(`qq:group:${groupOpenid}`);
      } else if (eventType === 'C2C_MESSAGE_CREATE') {
        // Direct message to bot
        openid = (d.author as Record<string, string> | undefined)?.user_openid ?? '';
        msgId = (d.id as string) ?? '';
        text = ((d.content as string) ?? '').trim();
        isC2C = true;
        threadKey = asThreadKey(`qq:c2c:${openid}`);
      } else {
        return; // Ignore other event types
      }

      // Command prefix filter (if set)
      if (this.opts.commandPrefix && !text.startsWith(this.opts.commandPrefix)) return;
      if (this.opts.commandPrefix) text = text.slice(this.opts.commandPrefix.length).trim();
      if (!text) return;

      this.threadMeta.set(threadKey, { groupOpenid, msgId, isC2C, openid });

      const channelMsg: ChannelMessage = {
        channelId: this.id,
        agentId: this.opts.defaultAgentId,
        threadKey,
        text,
        meta: { groupOpenid, openid, msgId, isC2C, eventType },
        receivedAt: Date.now(),
      };

      this.handler?.(channelMsg).catch((e: unknown) => {
        logger.error('Inbound handler error', { error: String(e) });
      });
    };

    logger.info('QQ channel started', { agentId: this.opts.defaultAgentId });
  }

  async stop(): Promise<void> {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    logger.info('QQ channel stopped');
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
    if (text) await this.sendToThread(target.threadKey, text);
  }

  async send(target: { agentId: AgentId; threadKey: ThreadKey }, text: string): Promise<void> {
    await this.sendToThread(target.threadKey, text);
  }

  /** Send a reply to the QQ group or C2C thread. Includes msg_id per anti-spam policy. */
  async sendToThread(threadKey: ThreadKey, text: string): Promise<void> {
    const meta = this.threadMeta.get(threadKey);
    if (!meta) {
      logger.warn('sendToThread: no metadata for thread', { threadKey });
      return;
    }

    // QQ message limit: 2000 characters
    const MAX = 2000;
    const parts = text.length <= MAX ? [text] : splitText(text, MAX);

    for (const part of parts) {
      const body: Record<string, unknown> = {
        content: part,
        msg_type: 0,
        timestamp: Math.floor(Date.now() / 1000),
        msg_id: meta.msgId,
      };

      const path = meta.isC2C
        ? `/v2/users/${meta.openid}/messages`
        : `/v2/groups/${meta.groupOpenid}/messages`;

      await this.apiPost(path, body);
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
