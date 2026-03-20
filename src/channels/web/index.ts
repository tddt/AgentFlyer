import { createLogger } from '../../core/logger.js';
import type { AgentId, ThreadKey, StreamChunk } from '../../core/types.js';
import type { Channel, InboundHandler, ChannelMessage } from '../types.js';

const logger = createLogger('channels:web');

/**
 * WebChannel stub — placeholder for HTTP/WebSocket chat interface.
 * Phase 2 will wire this to the gateway's WS server.
 */
export class WebChannel implements Channel {
  readonly id = 'web';
  readonly name = 'Web / HTTP-WebSocket';

  private handler: InboundHandler | null = null;

  async start(handler: InboundHandler): Promise<void> {
    this.handler = handler;
    logger.info('Web channel started (stub — awaiting gateway WS binding)');
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  /** Called by the gateway WS router when a message arrives from a browser. */
  async receive(msg: ChannelMessage): Promise<void> {
    if (!this.handler) throw new Error('WebChannel not started');
    await this.handler(msg);
  }

  async sendStream(
    _target: { agentId: AgentId; threadKey: ThreadKey },
    _stream: AsyncIterable<StreamChunk>,
  ): Promise<void> {
    // Stub: gateway WS router handles actual WS writes
    logger.debug('WebChannel.sendStream called (no-op stub)');
  }

  async send(
    _target: { agentId: AgentId; threadKey: ThreadKey },
    _text: string,
  ): Promise<void> {
    logger.debug('WebChannel.send called (no-op stub)');
  }
}
