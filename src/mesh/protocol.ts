import { ulid } from 'ulid';
import { createLogger } from '../core/logger.js';
import type { AgentId, NodeId, TaskId } from '../core/types.js';

const logger = createLogger('mesh:protocol');

/** ------------------------------------------------------------------
 *  Wire-protocol message types exchanged between mesh nodes / agents.
 * ------------------------------------------------------------------ */

export type MeshMessageType =
  | 'task.spawn'
  | 'task.result'
  | 'task.status'
  | 'task.cancel'
  | 'agent.hello'
  | 'agent.bye'
  | 'agent.list'
  | 'agent.list.response'
  | 'heartbeat'
  | 'error';

export interface MeshEnvelope {
  /** Monotonic message ID. */
  id: string;
  type: MeshMessageType;
  /** Sending agent / node. */
  from: AgentId | NodeId;
  /** Target agent ID or '*' for broadcast. */
  to: AgentId | '*';
  /** Unix ms timestamp. */
  ts: number;
  /** Payload (type-specific). */
  payload: MeshPayload;
  /** Set on forwarded messages to prevent cycles. */
  ttl?: number;
}

// ── Payload variants ──────────────────────────────────────────────

export interface SpawnPayload {
  agentId: AgentId;
  instruction: string;
  context?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ResultPayload {
  taskId: TaskId;
  success: boolean;
  output: string;
  errorMessage?: string;
  durationMs?: number;
}

export interface StatusPayload {
  taskId: TaskId;
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
  progress?: string;
}

export interface HelloPayload {
  agentId: AgentId;
  capabilities: string[];
  model: string;
}

export interface HeartbeatPayload {
  agentId: AgentId;
  status: 'idle' | 'busy';
}

export type MeshPayload =
  | SpawnPayload
  | ResultPayload
  | StatusPayload
  | HelloPayload
  | HeartbeatPayload
  | Record<string, unknown>;

export function buildEnvelope(
  type: MeshMessageType,
  from: AgentId | NodeId,
  to: AgentId | '*',
  payload: MeshPayload,
): MeshEnvelope {
  return { id: ulid(), type, from, to, ts: Date.now(), payload, ttl: 8 };
}

export function parseEnvelope(raw: string): MeshEnvelope | null {
  try {
    return JSON.parse(raw) as MeshEnvelope;
  } catch (err) {
    logger.warn('Failed to parse mesh envelope', { raw: raw.slice(0, 100), error: String(err) });
    return null;
  }
}
