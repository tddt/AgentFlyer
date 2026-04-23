import { describe, expect, it } from 'vitest';
import {
  agentPartition,
  isAgentPartition,
  isSharedPartition,
  partitionsForAgent,
  sharedPartition,
} from '../../../src/memory/partition.js';

describe('sharedPartition', () => {
  it('returns "shared"', () => {
    expect(sharedPartition()).toBe('shared');
  });
});

describe('agentPartition', () => {
  it('returns "per-agent:<id>"', () => {
    expect(agentPartition('alice')).toBe('per-agent:alice');
  });

  it('handles ids with special characters', () => {
    expect(agentPartition('agent-123')).toBe('per-agent:agent-123');
  });
});

describe('isSharedPartition', () => {
  it('returns true for "shared"', () => {
    expect(isSharedPartition('shared')).toBe(true);
  });

  it('returns false for per-agent partition', () => {
    expect(isSharedPartition('per-agent:alice')).toBe(false);
  });

  it('returns false for arbitrary string', () => {
    expect(isSharedPartition('other')).toBe(false);
  });
});

describe('isAgentPartition', () => {
  it('returns true for matching per-agent partition', () => {
    expect(isAgentPartition('per-agent:alice', 'alice')).toBe(true);
  });

  it('returns false for different agent id', () => {
    expect(isAgentPartition('per-agent:alice', 'bob')).toBe(false);
  });

  it('returns false for shared', () => {
    expect(isAgentPartition('shared', 'alice')).toBe(false);
  });
});

describe('partitionsForAgent', () => {
  it('returns shared and per-agent partitions', () => {
    const ps = partitionsForAgent('alice');
    expect(ps).toContain('shared');
    expect(ps).toContain('per-agent:alice');
    expect(ps).toHaveLength(2);
  });

  it('does not include a different agent partition', () => {
    const ps = partitionsForAgent('alice');
    expect(ps).not.toContain('per-agent:bob');
  });
});
