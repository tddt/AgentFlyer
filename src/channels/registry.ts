import { createLogger } from '../core/logger.js';
import type { Channel } from './types.js';

const logger = createLogger('channels:registry');

export class ChannelRegistry {
  private channels = new Map<string, Channel>();

  register(channel: Channel): void {
    this.channels.set(channel.id, channel);
    logger.debug('Channel registered', { id: channel.id, name: channel.name });
  }

  get(id: string): Channel | undefined {
    return this.channels.get(id);
  }

  list(): Channel[] {
    return Array.from(this.channels.values());
  }

  has(id: string): boolean {
    return this.channels.has(id);
  }
}
