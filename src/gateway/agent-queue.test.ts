import { describe, expect, it } from 'vitest';
import { AgentQueue } from './agent-queue.js';

describe('AgentQueue hooks', () => {
  it('reports queued position and queued start when work is already in progress', async () => {
    const queue = new AgentQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstTask = queue.enqueue(async () => {
      events.push('first:run');
      await firstGate;
      events.push('first:done');
      return 'first';
    });

    const secondTask = queue.enqueue(
      async () => {
        events.push('second:run');
        return 'second';
      },
      {
        onQueued: ({ position }) => {
          events.push(`second:queued:${position}`);
        },
        onStarted: ({ wasQueued, queueDepth }) => {
          events.push(`second:started:${wasQueued ? 'queued' : 'direct'}:${queueDepth}`);
        },
      },
    );

    await Promise.resolve();
    expect(events).toEqual(['first:run', 'second:queued:1']);

    releaseFirst();

    await expect(firstTask).resolves.toBe('first');
    await expect(secondTask).resolves.toBe('second');
    expect(events).toEqual([
      'first:run',
      'second:queued:1',
      'first:done',
      'second:started:queued:0',
      'second:run',
    ]);
  });

  it('removes a pending task by taskKey and updates queue depth', async () => {
    const queue = new AgentQueue();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstTask = queue.enqueue(async () => {
      await firstGate;
      return 'first';
    });

    const secondTask = queue.enqueue(async () => 'second', {
      taskKey: 'queued-run-2',
    });

    expect(queue.snapshot).toMatchObject({
      hasActiveTask: true,
      pendingCount: 1,
      busy: true,
    });
    expect(queue.cancelPending('queued-run-2')).toBe(true);
    expect(queue.snapshot).toMatchObject({
      hasActiveTask: true,
      pendingCount: 0,
      busy: true,
    });
    await expect(secondTask).resolves.toBeUndefined();

    releaseFirst();
    await expect(firstTask).resolves.toBe('first');
  });
});
