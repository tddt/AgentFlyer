import { describe, expect, it } from 'vitest';
import {
  asAgentId,
  asMemoryEntryId,
  asNodeId,
  asReceiptId,
  asSessionKey,
  asSkillId,
  asTaskId,
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

    it('returns null for blank agent id or thread key', () => {
      expect(parseSessionKey('agent:   :thread' as ReturnType<typeof makeSessionKey>)).toBeNull();
      expect(parseSessionKey('agent:main:   ' as ReturnType<typeof makeSessionKey>)).toBeNull();
    });

    it('round-trips makeSessionKey → parseSessionKey', () => {
      const agentId = 'a' as AgentId;
      const threadKey = 'b:c' as ThreadKey;
      const key = makeSessionKey(agentId, threadKey);
      const parsed = parseSessionKey(key);
      expect(parsed).not.toBeNull();
      if (!parsed) {
        throw new Error('Expected parseSessionKey to return a value');
      }
      expect(parsed.agentId).toBe(agentId);
      expect(parsed.threadKey).toBe(threadKey);
    });
  });

  describe('brand cast helpers', () => {
    it('asAgentId casts string', () => {
      const id = asAgentId('hello');
      expect(id).toBe('hello');
    });

    it('asAgentId rejects blank strings', () => {
      expect(() => asAgentId('   ')).toThrow('AgentId cannot be empty');
    });

    it('asThreadKey casts string', () => {
      const k = asThreadKey('thread-1');
      expect(k).toBe('thread-1');
    });

    it('asThreadKey rejects blank strings', () => {
      expect(() => asThreadKey('')).toThrow('ThreadKey cannot be empty');
    });

    it('asSessionKey casts string', () => {
      const k = asSessionKey('agent:a:b');
      expect(k).toBe('agent:a:b');
    });

    it('asSessionKey rejects invalid format', () => {
      expect(() => asSessionKey('abc')).toThrow(
        'SessionKey must match agent:<agentId>:<threadKey>',
      );
    });

    it('asNodeId rejects blank strings', () => {
      expect(asNodeId('node-1')).toBe('node-1');
      expect(() => asNodeId('   ')).toThrow('NodeId cannot be empty');
    });

    it('asSkillId rejects blank strings', () => {
      expect(asSkillId('search')).toBe('search');
      expect(() => asSkillId('')).toThrow('SkillId cannot be empty');
    });

    it('asMemoryEntryId rejects blank strings', () => {
      expect(asMemoryEntryId('mem-1')).toBe('mem-1');
      expect(() => asMemoryEntryId('')).toThrow('MemoryEntryId cannot be empty');
    });

    it('asTaskId rejects blank strings', () => {
      expect(asTaskId('task-1')).toBe('task-1');
      expect(() => asTaskId('')).toThrow('TaskId cannot be empty');
    });

    it('asReceiptId rejects blank strings', () => {
      expect(asReceiptId('receipt-1')).toBe('receipt-1');
      expect(() => asReceiptId('')).toThrow('ReceiptId cannot be empty');
    });
  });

  describe('makeSessionKey', () => {
    it('rejects blank branded values', () => {
      expect(() => makeSessionKey('   ' as AgentId, 'thread-1' as ThreadKey)).toThrow(
        'AgentId cannot be empty',
      );
      expect(() => makeSessionKey('agent-1' as AgentId, '   ' as ThreadKey)).toThrow(
        'ThreadKey cannot be empty',
      );
    });
  });
});
