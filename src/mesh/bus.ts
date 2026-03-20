import { EventEmitter } from 'node:events';
import { createLogger } from '../core/logger.js';
import type { AgentId } from '../core/types.js';
import { buildEnvelope, parseEnvelope, type MeshEnvelope, type MeshMessageType } from './protocol.js';
import { MeshRegistry, type MeshAgent } from './registry.js';

const logger = createLogger('mesh:bus');

type MeshListener = (envelope: MeshEnvelope) => void;

/**
 * In-process message bus for local mesh communication.
 *
 * Phase 1: pure in-process, no networking.
 * Phase 2+: bridge to WebSocket / gRPC for cross-node messaging.
 */
export class MeshBus extends EventEmitter {
  readonly registry = new MeshRegistry();
  private handlers = new Map<AgentId, MeshListener>();
  private broadcastHandlers: MeshListener[] = [];

  /** Register a handler for messages directed at `agentId` or broadcast. */
  subscribe(agentId: AgentId, handler: MeshListener): void {
    this.handlers.set(agentId, handler);
  }

  unsubscribe(agentId: AgentId): void {
    this.handlers.delete(agentId);
  }

  /** Subscribe to all messages (useful for logging / coordinator agents). */
  subscribeAll(handler: MeshListener): void {
    this.broadcastHandlers.push(handler);
  }

  /** Publish an envelope to the bus. */
  publish(envelope: MeshEnvelope): void {
    logger.debug('Mesh publish', { type: envelope.type, from: envelope.from, to: envelope.to });

    // Notify broadcast handlers
    for (const h of this.broadcastHandlers) {
      try { h(envelope); } catch (err) {
        logger.error('Broadcast handler error', { error: String(err) });
      }
    }

    // Directed delivery
    if (envelope.to !== '*') {
      const handler = this.handlers.get(envelope.to as AgentId);
      if (handler) {
        try { handler(envelope); } catch (err) {
          logger.error('Handler error', { agentId: envelope.to, error: String(err) });
        }
      }
    } else {
      // Fanout to all
      for (const [, h] of this.handlers) {
        try { h(envelope); } catch (err) {
          logger.error('Fanout handler error', { error: String(err) });
        }
      }
    }

    this.emit('message', envelope);
  }

  /** Convenience: build and publish in one call. */
  send(
    type: MeshMessageType,
    from: AgentId,
    to: AgentId | '*',
    payload: MeshEnvelope['payload'],
  ): void {
    this.publish(buildEnvelope(type, from, to, payload));
  }

  /** Register an agent on the mesh and announce its presence. */
  announceAgent(agent: MeshAgent): void {
    this.registry.register(agent);
    this.send('agent.hello', agent.agentId, '*', {
      agentId: agent.agentId,
      capabilities: agent.capabilities,
      model: agent.model,
    });
  }

  /** Deregister and say goodbye. */
  removeAgent(agentId: AgentId): void {
    this.registry.unregister(agentId);
    this.unsubscribe(agentId);
    this.send('agent.bye', agentId, '*', { agentId });
  }
}

/** Singleton bus for the gateway process. */
let _globalBus: MeshBus | null = null;

export function getGlobalBus(): MeshBus {
  if (!_globalBus) _globalBus = new MeshBus();
  return _globalBus;
}

export function resetGlobalBus(): void {
  _globalBus = null;
}
