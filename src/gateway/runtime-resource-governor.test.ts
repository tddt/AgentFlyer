import { describe, expect, it } from 'vitest';
import { RuntimeResourceGovernor } from './runtime-resource-governor.js';

describe('RuntimeResourceGovernor', () => {
  it('enforces lane limits and releases permits after errors', async () => {
    const governor = new RuntimeResourceGovernor({ llm: 1 });
    let active = 0;
    let peak = 0;
    let releaseFirst: (() => void) | undefined;
    const first = governor.run({ lane: 'llm', agentId: 'a' }, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      active -= 1;
      throw new Error('expected');
    });
    const second = governor.run({ lane: 'llm', agentId: 'b' }, async () => {
      active += 1;
      peak = Math.max(peak, active);
      active -= 1;
      return 'ok';
    });
    await Promise.resolve();
    expect(governor.snapshot().llm).toMatchObject({ active: 1, queued: 1 });
    releaseFirst?.();
    await expect(first).rejects.toThrow('expected');
    await expect(second).resolves.toBe('ok');
    expect(peak).toBe(1);
  });

  it('prioritizes interactive work while preserving FIFO order within a priority', async () => {
    const governor = new RuntimeResourceGovernor({ tool: 1 });
    let release: (() => void) | undefined;
    const order: string[] = [];
    const first = governor.run({ lane: 'tool', agentId: 'first' }, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await Promise.resolve();
    const workflow = governor.run(
      { lane: 'tool', agentId: 'workflow', priority: 'workflow' },
      async () => {
        order.push('workflow');
      },
    );
    const interactive = governor.run(
      { lane: 'tool', agentId: 'chat', priority: 'interactive' },
      async () => {
        order.push('chat');
      },
    );
    release?.();
    await Promise.all([first, workflow, interactive]);
    expect(order).toEqual(['chat', 'workflow']);
  });

  it('removes aborted queued requests', async () => {
    const governor = new RuntimeResourceGovernor({ cpu: 1 });
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const active = governor.run({ lane: 'cpu', agentId: 'active' }, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const queued = governor.run(
      { lane: 'cpu', agentId: 'cancelled', signal: controller.signal },
      async () => 'unexpected',
    );
    controller.abort();
    await expect(queued).rejects.toThrow('aborted');
    expect(governor.snapshot().cpu.queued).toBe(0);
    release?.();
    await active;
  });

  it('applies updated limits to queued work', async () => {
    const governor = new RuntimeResourceGovernor({ llm: 1 });
    let release: (() => void) | undefined;
    const active = governor.run({ lane: 'llm', agentId: 'active' }, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    let started = false;
    const queued = governor.run({ lane: 'llm', agentId: 'queued' }, async () => {
      started = true;
    });

    governor.updateLimits({ llm: 2 });
    await queued;
    expect(started).toBe(true);
    release?.();
    await active;
  });

  it('resets omitted limits to defaults during an update', () => {
    const governor = new RuntimeResourceGovernor({ llm: 1, tool: 1, cpu: 1 });

    governor.updateLimits({ llm: 3 });

    expect(governor.snapshot()).toMatchObject({
      llm: { limit: 3 },
      tool: { limit: 6 },
      cpu: { limit: 2 },
    });
  });
});
