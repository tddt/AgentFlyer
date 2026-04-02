import type { WebSocket as WsSocket } from 'ws';
import { createLogger } from '../../core/logger.js';
import { asAgentId, asThreadKey, type AgentId, type StreamChunk, type ThreadKey } from '../../core/types.js';
import type { Channel, ChannelMessage, InboundHandler } from '../types.js';

const logger = createLogger('channels:web');

/** Inbound JSON payload sent by the browser over WebSocket. */
interface WsInboundMessage {
  text: string;
  agentId?: string;
  threadKey?: string;
}

/**
 * WebChannel — HTTP/WebSocket chat interface.
 *
 * Browser connects to `ws://<host>:<port>/ws/chat?token=<authToken>&agentId=<id>&threadKey=<key>`.
 * The gateway WS handler calls `bindWebSocket()` for each accepted connection.
 * Outbound chunks are forwarded to all sockets registered for that agentId+threadKey pair.
 */
export class WebChannel implements Channel {
  readonly id = 'web';
  readonly name = 'Web / HTTP-WebSocket';

  private handler: InboundHandler | null = null;
  // Key: `${agentId}:${threadKey}` → active WS sockets set
  private readonly connections = new Map<string, Set<WsSocket>>();

  async start(handler: InboundHandler): Promise<void> {
    this.handler = handler;
    logger.info('Web channel started');
  }

  async stop(): Promise<void> {
    for (const sockets of this.connections.values()) {
      for (const ws of sockets) {
        ws.close(1001, 'Server shutting down');
      }
    }
    this.connections.clear();
    this.handler = null;
  }

  /**
   * Register a WebSocket connection for the given agent+thread.
   * Called by the gateway's WS upgrade handler for each new browser connection.
   */
  bindWebSocket(ws: WsSocket, agentId: AgentId, threadKey: ThreadKey): void {
    const connKey = `${agentId}:${threadKey}`;
    if (!this.connections.has(connKey)) {
      this.connections.set(connKey, new Set());
    }
    this.connections.get(connKey)!.add(ws);
    logger.debug('WebChannel: WS connected', { connKey });

    // Send initial handshake so the client knows the connection is live.
    ws.send(JSON.stringify({ type: 'connected', agentId, threadKey }));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data)) as WsInboundMessage;
        const text = msg.text?.trim();
        if (!text) return;
        if (!this.handler) {
          ws.send(JSON.stringify({ type: 'error', message: 'Channel not ready' }));
          return;
        }
        const resolvedAgentId = msg.agentId?.trim() ? asAgentId(msg.agentId) : agentId;
        const resolvedThreadKey = msg.threadKey?.trim() ? asThreadKey(msg.threadKey) : threadKey;
        void this.handler({
          channelId: 'web',
          agentId: resolvedAgentId,
          threadKey: resolvedThreadKey,
          text,
          meta: { connectionKey: connKey },
          receivedAt: Date.now(),
        }).catch((err: unknown) => {
          logger.error('WebChannel inbound handler error', { error: String(err) });
        });
      } catch (err) {
        logger.debug('WebChannel: malformed WS message', { error: String(err) });
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      }
    });

    ws.on('close', () => {
      const set = this.connections.get(connKey);
      if (set) {
        set.delete(ws);
        if (set.size === 0) this.connections.delete(connKey);
      }
      logger.debug('WebChannel: WS disconnected', { connKey });
    });

    ws.on('error', (err) => {
      logger.debug('WebChannel: WS error', { connKey, error: String(err) });
    });
  }

  private _getSockets(target: { agentId: AgentId; threadKey: ThreadKey }): Set<WsSocket> | undefined {
    return this.connections.get(`${target.agentId}:${target.threadKey}`);
  }

  async sendStream(
    target: { agentId: AgentId; threadKey: ThreadKey },
    stream: AsyncIterable<StreamChunk>,
  ): Promise<void> {
    const sockets = this._getSockets(target);
    if (!sockets?.size) {
      logger.debug('WebChannel.sendStream: no active connections', { target });
      // Drain the stream so the generator is not left suspended.
      for await (const _chunk of stream) { /* drain */ }
      return;
    }

    const broadcast = (data: string): void => {
      for (const ws of sockets) {
        // 1 = WebSocket.OPEN
        if (ws.readyState === 1) ws.send(data);
      }
    };

    try {
      for await (const chunk of stream) {
        if (chunk.type === 'text_delta' && chunk.text) {
          broadcast(JSON.stringify({ type: 'chunk', delta: chunk.text }));
        }
      }
      broadcast(JSON.stringify({ type: 'done' }));
    } catch (err) {
      logger.error('WebChannel.sendStream error', { error: String(err) });
      broadcast(JSON.stringify({ type: 'error', message: String(err) }));
    }
  }

  async send(target: { agentId: AgentId; threadKey: ThreadKey }, text: string): Promise<void> {
    const sockets = this._getSockets(target);
    if (!sockets?.size) return;
    const data = JSON.stringify({ type: 'message', text });
    for (const ws of sockets) {
      if (ws.readyState === 1) ws.send(data);
    }
  }
}

