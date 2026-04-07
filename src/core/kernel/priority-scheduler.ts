import type { ProcessId } from '../types.js';
import type { KernelProcessSnapshot, ProcessPriority } from './types.js';

const PRIORITY_SCORE: Record<ProcessPriority, number> = {
  critical: 400,
  high: 300,
  normal: 200,
  low: 100,
};

const RUNNABLE_STATUS = new Set(['ready', 'running'] as const);

export class PriorityScheduler {
  selectNext(snapshots: KernelProcessSnapshot[], now: number): KernelProcessSnapshot | null {
    const runnable = snapshots.filter((snapshot) => this.isRunnable(snapshot, now));
    if (runnable.length === 0) return null;

    runnable.sort((left, right) => {
      const leftScore = PRIORITY_SCORE[left.priority];
      const rightScore = PRIORITY_SCORE[right.priority];
      if (leftScore !== rightScore) return rightScore - leftScore;

      const leftNext = left.nextRunAt ?? 0;
      const rightNext = right.nextRunAt ?? 0;
      if (leftNext !== rightNext) return leftNext - rightNext;

      if (left.runCount !== right.runCount) return left.runCount - right.runCount;
      return left.createdAt - right.createdAt;
    });

    return runnable[0] ?? null;
  }

  isRunnable(snapshot: KernelProcessSnapshot, now: number): boolean {
    if (!RUNNABLE_STATUS.has(snapshot.status as 'ready' | 'running')) return false;
    return (snapshot.nextRunAt ?? 0) <= now;
  }

  computeRetryAt(now: number, retryCount: number, requestedDelayMs?: number): number {
    if (requestedDelayMs !== undefined && requestedDelayMs >= 0) {
      return now + requestedDelayMs;
    }
    const boundedRetryCount = Math.max(0, Math.min(retryCount, 6));
    return now + 1000 * 2 ** boundedRetryCount;
  }

  suspend(pid: ProcessId): { pid: ProcessId; status: 'suspended' } {
    return { pid, status: 'suspended' };
  }
}
