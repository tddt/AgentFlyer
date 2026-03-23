import { describe, expect, it } from 'vitest';
import {
  asAgentId,
  asSessionKey,
  asThreadKey,
  makeSessionKey,
  parseSessionKey,
} from '../../../src/core/types.js';
import type { AgentId, ThreadKey } from '../../../src/core/types.js';

describe('types — branded helpers', () => {
  describe('makeSessionKey', () => {
    it('produces agent:<agentId>:<threadKey> format', () => {
      const key = makeSessionKey('main' as AgentId, 'cli-123' as ThreadKey);
      expect(key).toBe('agent:main:cli-123');
    });

    it('handles thread keys containing colons', () => {
      const key = makeSessionKey('bot' as AgentId, 'ns:sub:id' as ThreadKey);
      expect(key).toBe('agent:bot:ns:sub:id');
    });
  });

  describe('parseSessionKey', () => {
    it('parses a valid session key', () => {
      const key = makeSessionKey('my-agent' as AgentId, 'thread-abc' as ThreadKey);
      const parsed = parseSessionKey(key);
      expect(parsed).not.toBeNull();
      expect(parsed?.agentId).toBe('my-agent');
      expect(parsed?.threadKey).toBe('thread-abc');
    });

    it('returns null for invalid format', () => {
      expect(parseSessionKey('not-valid' as ReturnType<typeof makeSessionKey>)).toBeNull();
    });

    it('round-trips makeSessionKey → parseSessionKey', () => {
      const agentId = 'a' as AgentId;
      const threadKey = 'b:c' as ThreadKey;
      const key = makeSessionKey(agentId, threadKey);
      const parsed = parseSessionKey(key)!;
      expect(parsed.agentId).toBe(agentId);
      expect(parsed.threadKey).toBe(threadKey);
    });
  });

  describe('brand cast helpers', () => {
    it('asAgentId casts string', () => {
      const id = asAgentId('hello');
      expect(id).toBe('hello');
    });

    it('asThreadKey casts string', () => {
      const k = asThreadKey('thread-1');
      expect(k).toBe('thread-1');
    });

    it('asSessionKey casts string', () => {
      const k = asSessionKey('agent:a:b');
      expect(k).toBe('agent:a:b');
    });
  });
});
