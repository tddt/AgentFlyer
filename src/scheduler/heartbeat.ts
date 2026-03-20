import { createLogger } from '../core/logger.js';
import type { AgentId } from '../core/types.js';

const logger = createLogger('scheduler:heartbeat');

export type HeartbeatHandler = (agentId: AgentId, ts: number) => void;

/**
 * Emits periodic heartbeat ticks for all registered agents.
 * Used by the mesh registry to keep lastSeenAt fresh.
 */
export class HeartbeatScheduler {
  private intervals = new Map<AgentId, ReturnType<typeof setInterval>>();
  private handlers: HeartbeatHandler[] = [];

  /** Default heartbeat interval: 30 s */
  private readonly intervalMs: number;

  constructor(intervalMs = 30_000) {
    this.intervalMs = intervalMs;
  }

  onHeartbeat(handler: HeartbeatHandler): void {
    this.handlers.push(handler);
  }

  register(agentId: AgentId): void {
    if (this.intervals.has(agentId)) return;
    const timer = setInterval(() => {
      const ts = Date.now();
      logger.debug('Heartbeat', { agentId });
      for (const h of this.handlers) {
        try { h(agentId, ts); } catch (err) {
          logger.error('Heartbeat handler error', { agentId, error: String(err) });
        }
      }
    }, this.intervalMs);
    // Allow process to exit even if heartbeat is still ticking
    if (timer.unref) timer.unref();
    this.intervals.set(agentId, timer);
  }

  unregister(agentId: AgentId): void {
    const timer = this.intervals.get(agentId);
    if (timer) {
      clearInterval(timer);
      this.intervals.delete(agentId);
    }
  }

  stopAll(): void {
    for (const timer of this.intervals.values()) clearInterval(timer);
    this.intervals.clear();
  }
}
