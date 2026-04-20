import { describe, expect, it, vi } from 'vitest';
import { MeshBus, getGlobalBus, resetGlobalBus } from './bus.js';
import { buildEnvelope } from './protocol.js';
import { asAgentId } from '../core/types.js';

const A = asAgentId('agent-a');
const B = asAgentId('agent-b');
const C = asAgentId('agent-c');

// ─── subscribe / publish ──────────────────────────────────────────────────────

describe('MeshBus – directed delivery', () => {
  it('delivers envelope only to the target subscriber', () => {
    const bus = new MeshBus();
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    bus.subscribe(A, handlerA);
    bus.subscribe(B, handlerB);

    const env = buildEnvelope('task.spawn', A, B, { agentId: B, instruction: 'hello B' });
    bus.publish(env);

    expect(handlerB).toHaveBeenCalledOnce();
    expect(handlerB).toHaveBeenCalledWith(env);
    expect(handlerA).not.toHaveBeenCalled();
  });

  it('does not deliver to unsubscribed agents', () => {
    const bus = new MeshBus();
    const handler = vi.fn();
    bus.subscribe(A, handler);
    bus.unsubscribe(A);

    bus.publish(buildEnvelope('task.spawn', B, A, { agentId: A, instruction: 'x' }));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('MeshBus – broadcast delivery', () => {
  it('delivers to all handlers when to="*"', () => {
    const bus = new MeshBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.subscribe(A, h1);
    bus.subscribe(B, h2);

    const env = buildEnvelope('agent.hello', C, '*' as never, { agentId: C, capabilities: [] });
    bus.publish(env);

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('subscribeAll receives every message', () => {
    const bus = new MeshBus();
    const spy = vi.fn();
    bus.subscribeAll(spy);

    const env1 = buildEnvelope('task.spawn', A, B, { agentId: B, instruction: 'x' });
    const env2 = buildEnvelope('task.result', B, A, { taskId: 't1' as never, success: true, output: 'y' });
    bus.publish(env1);
    bus.publish(env2);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, env1);
    expect(spy).toHaveBeenNthCalledWith(2, env2);
  });

  it('subscribeAll also fires for directed messages', () => {
    const bus = new MeshBus();
    const broadcastSpy = vi.fn();
    bus.subscribeAll(broadcastSpy);
    bus.subscribe(B, vi.fn());

    bus.publish(buildEnvelope('task.spawn', A, B, { agentId: B, instruction: 'work' }));
    expect(broadcastSpy).toHaveBeenCalledOnce();
  });
});

// ─── send() convenience ───────────────────────────────────────────────────────

describe('MeshBus – send()', () => {
  it('builds and delivers an envelope via send()', () => {
    const bus = new MeshBus();
    const handler = vi.fn();
    bus.subscribe(B, handler);

    bus.send('task.spawn', A, B, { agentId: B, instruction: 'delegated' });

    expect(handler).toHaveBeenCalledOnce();
    const env = handler.mock.calls[0]?.[0];
    expect(env?.type).toBe('task.spawn');
    expect(env?.from).toBe(A);
    expect(env?.to).toBe(B);
  });
});

// ─── error isolation ──────────────────────────────────────────────────────────

describe('MeshBus – handler errors do not propagate', () => {
  it('continues delivery even if one handler throws', () => {
    const bus = new MeshBus();
    const throwing = vi.fn(() => { throw new Error('boom'); });
    const safe = vi.fn();
    bus.subscribeAll(throwing);
    bus.subscribe(B, safe);

    // Should not throw
    expect(() =>
      bus.publish(buildEnvelope('task.spawn', A, B, { agentId: B, instruction: 'x' })),
    ).not.toThrow();
    expect(safe).toHaveBeenCalled();
  });
});

// ─── announceAgent / removeAgent ─────────────────────────────────────────────

describe('MeshBus – agent lifecycle', () => {
  it('registers agent on announceAgent', () => {
    const bus = new MeshBus();
    bus.announceAgent({ agentId: A, name: 'Agent A', capabilities: ['code'], model: 'claude', role: 'worker', status: 'idle', registeredAt: 0, lastSeenAt: 0 });
    expect(bus.registry.get(A)).not.toBeUndefined();
  });

  it('unregisters agent on removeAgent', () => {
    const bus = new MeshBus();
    bus.announceAgent({ agentId: A, name: 'Agent A', capabilities: [], model: 'claude', role: 'worker', status: 'idle', registeredAt: 0, lastSeenAt: 0 });
    bus.removeAgent(A);
    expect(bus.registry.get(A)).toBeUndefined();
  });

  it('removeAgent unsubscribes directed messages', () => {
    const bus = new MeshBus();
    const handler = vi.fn();
    bus.subscribe(A, handler);
    bus.removeAgent(A);

    bus.publish(buildEnvelope('task.spawn', B, A, { agentId: A, instruction: 'too late' }));
    expect(handler).not.toHaveBeenCalled();
  });
});

// ─── EventEmitter 'message' event ─────────────────────────────────────────────

describe('MeshBus – EventEmitter integration', () => {
  it('emits "message" event on publish', () => {
    const bus = new MeshBus();
    const spy = vi.fn();
    bus.on('message', spy);

    const env = buildEnvelope('task.spawn', A, B, { agentId: B, instruction: 'hi' });
    bus.publish(env);

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(env);
  });
});

// ─── Singleton helpers ────────────────────────────────────────────────────────

describe('getGlobalBus / resetGlobalBus', () => {
  it('returns the same instance on repeated calls', () => {
    resetGlobalBus();
    const b1 = getGlobalBus();
    const b2 = getGlobalBus();
    expect(b1).toBe(b2);
  });

  it('creates a fresh instance after reset', () => {
    resetGlobalBus();
    const b1 = getGlobalBus();
    resetGlobalBus();
    const b2 = getGlobalBus();
    expect(b1).not.toBe(b2);
  });
});
