import { createLogger } from '../core/logger.js';
import type { AgentId } from '../core/types.js';

const logger = createLogger('mesh:registry');

export type MeshRole = 'coordinator' | 'worker' | 'specialist' | 'observer';

export interface MeshAgent {
  agentId: AgentId;
  name: string;
  capabilities: string[];
  model: string;
  role: MeshRole;
  status: 'idle' | 'busy' | 'offline';
  registeredAt: number;
  lastSeenAt: number;
}

export class MeshRegistry {
  private agents = new Map<AgentId, MeshAgent>();

  register(agent: MeshAgent): void {
    this.agents.set(agent.agentId, agent);
    logger.debug('Agent registered on mesh', { agentId: agent.agentId, role: agent.role });
  }

  update(agentId: AgentId, updates: Partial<MeshAgent>): void {
    const existing = this.agents.get(agentId);
    if (!existing) return;
    this.agents.set(agentId, { ...existing, ...updates, lastSeenAt: Date.now() });
  }

  unregister(agentId: AgentId): void {
    this.agents.delete(agentId);
    logger.debug('Agent unregistered from mesh', { agentId });
  }

  get(agentId: AgentId): MeshAgent | undefined {
    return this.agents.get(agentId);
  }

  list(): MeshAgent[] {
    return Array.from(this.agents.values());
  }

  /** Find agents matching a capability filter. */
  findByCapability(capability: string): MeshAgent[] {
    return this.list().filter(
      (a) => a.status !== 'offline' && a.capabilities.includes(capability),
    );
  }

  /** Evict agents that have not sent a heartbeat within `ttlMs`. */
  evictStale(ttlMs = 60_000): number {
    const now = Date.now();
    let evicted = 0;
    for (const [id, agent] of this.agents) {
      if (now - agent.lastSeenAt > ttlMs) {
        this.agents.delete(id);
        evicted++;
        logger.info('Evicted stale mesh agent', { agentId: id });
      }
    }
    return evicted;
  }
}
