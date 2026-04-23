import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeartbeatScheduler } from '../../../src/scheduler/heartbeat.js';
import { asAgentId } from '../../../src/core/types.js';

describe('HeartbeatScheduler', () => {
  let hb: HeartbeatScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    hb = new HeartbeatScheduler(1000); // 1s interval for tests
  });

  afterEach(() => {
    hb.stopAll();
    vi.useRealTimers();
  });

  describe('register()', () => {
    it('registers an agent and fires heartbeat at the configured interval', async () => {
      const handler = vi.fn();
      hb.onHeartbeat(handler);

      hb.register(asAgentId('agent-a'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('passes agentId and timestamp to handler', async () => {
      const handler = vi.fn();
      hb.onHeartbeat(handler);
      hb.register(asAgentId('agent-b'));
      const before = Date.now();
      await vi.advanceTimersByTimeAsync(1000);
      const [agentId, ts] = handler.mock.calls[0] as [string, number];
      expect(agentId).toBe('agent-b');
      expect(ts).toBeGreaterThanOrEqual(before);
    });

    it('does not register the same agent twice', async () => {
      const handler = vi.fn();
      hb.onHeartbeat(handler);
      hb.register(asAgentId('agent-c'));
      hb.register(asAgentId('agent-c')); // duplicate
      await vi.advanceTimersByTimeAsync(1000);
      // Only one interval should fire, so handler called once (not twice)
      expect(handler).toHaveBeenCalledOnce();
    });

    it('fires for multiple registered agents', async () => {
      const handler = vi.fn();
      hb.onHeartbeat(handler);
      hb.register(asAgentId('agent-x'));
      hb.register(asAgentId('agent-y'));
      await vi.advanceTimersByTimeAsync(1000);
      // Two agents → two calls
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('onHeartbeat()', () => {
    it('allows multiple handlers', async () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      hb.onHeartbeat(h1);
      hb.onHeartbeat(h2);
      hb.register(asAgentId('agent-d'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(h1).toHaveBeenCalledOnce();
      expect(h2).toHaveBeenCalledOnce();
    });

    it('continues firing other handlers when one throws', async () => {
      const throwing = vi.fn().mockImplementation(() => {
        throw new Error('boom');
      });
      const safe = vi.fn();
      hb.onHeartbeat(throwing);
      hb.onHeartbeat(safe);
      hb.register(asAgentId('agent-e'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(safe).toHaveBeenCalledOnce();
    });
  });

  describe('unregister()', () => {
    it('stops heartbeat for the given agent', async () => {
      const handler = vi.fn();
      hb.onHeartbeat(handler);
      hb.register(asAgentId('agent-f'));
      hb.unregister(asAgentId('agent-f'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).not.toHaveBeenCalled();
    });

    it('is a no-op for an unregistered agent', () => {
      expect(() => hb.unregister(asAgentId('ghost'))).not.toThrow();
    });
  });

  describe('stopAll()', () => {
    it('stops all registered heartbeat intervals', async () => {
      const handler = vi.fn();
      hb.onHeartbeat(handler);
      hb.register(asAgentId('agent-g'));
      hb.register(asAgentId('agent-h'));
      hb.stopAll();
      await vi.advanceTimersByTimeAsync(2000);
      expect(handler).not.toHaveBeenCalled();
    });

    it('is idempotent', () => {
      hb.register(asAgentId('agent-i'));
      hb.stopAll();
      expect(() => hb.stopAll()).not.toThrow();
    });
  });
});
