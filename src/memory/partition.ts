/**
 * Memory partitioning scheme
 *
 * Partitions:
 *   'shared'            — visible to all agents in this instance
 *   'per-agent:<id>'    — private to a specific agent
 */

export type MemoryPartition = 'shared' | `per-agent:${string}`;

export function sharedPartition(): MemoryPartition {
  return 'shared';
}

export function agentPartition(agentId: string): MemoryPartition {
  return `per-agent:${agentId}`;
}

export function isSharedPartition(partition: string): boolean {
  return partition === 'shared';
}

export function isAgentPartition(partition: string, agentId: string): boolean {
  return partition === `per-agent:${agentId}`;
}

/** Return all partitions an agent is allowed to search */
export function partitionsForAgent(agentId: string): MemoryPartition[] {
  return [sharedPartition(), agentPartition(agentId)];
}
