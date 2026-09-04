export type ResourceLane = 'llm' | 'tool' | 'cpu';

export type ResourcePriority = 'interactive' | 'recovery' | 'workflow' | 'scheduler';

export interface ResourcePermitRequest {
  lane: ResourceLane;
  agentId: string;
  priority?: ResourcePriority;
  signal?: AbortSignal;
}

export interface ResourceLaneSnapshot {
  limit: number;
  active: number;
  queued: number;
}

export type RuntimeResourceSnapshot = Record<ResourceLane, ResourceLaneSnapshot>;

interface Waiter {
  request: ResourcePermitRequest;
  sequence: number;
  resolve: () => void;
  reject: (error: Error) => void;
  abortListener?: () => void;
}

const PRIORITY_WEIGHT: Record<ResourcePriority, number> = {
  interactive: 0,
  recovery: 1,
  workflow: 2,
  scheduler: 3,
};

const DEFAULT_LIMITS: Record<ResourceLane, number> = {
  llm: 4,
  tool: 6,
  cpu: 2,
};

function createAbortError(): Error {
  return new Error('Resource permit request was aborted');
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

export class RuntimeResourceGovernor {
  private readonly limits: Record<ResourceLane, number>;
  private readonly active: Record<ResourceLane, number> = { llm: 0, tool: 0, cpu: 0 };
  private readonly waiters: Record<ResourceLane, Waiter[]> = { llm: [], tool: [], cpu: [] };
  private sequence = 0;
  private disposed = false;

  constructor(limits: Partial<Record<ResourceLane, number>> = {}) {
    this.limits = {
      llm: normalizeLimit(limits.llm, DEFAULT_LIMITS.llm),
      tool: normalizeLimit(limits.tool, DEFAULT_LIMITS.tool),
      cpu: normalizeLimit(limits.cpu, DEFAULT_LIMITS.cpu),
    };
  }

  async run<T>(request: ResourcePermitRequest, task: () => Promise<T>): Promise<T> {
    await this.acquire(request);
    try {
      return await task();
    } finally {
      this.release(request.lane);
    }
  }

  snapshot(): RuntimeResourceSnapshot {
    return {
      llm: this.snapshotLane('llm'),
      tool: this.snapshotLane('tool'),
      cpu: this.snapshotLane('cpu'),
    };
  }

  updateLimits(limits: Partial<Record<ResourceLane, number>>): void {
    this.limits.llm = normalizeLimit(limits.llm, DEFAULT_LIMITS.llm);
    this.limits.tool = normalizeLimit(limits.tool, DEFAULT_LIMITS.tool);
    this.limits.cpu = normalizeLimit(limits.cpu, DEFAULT_LIMITS.cpu);
    for (const lane of Object.keys(this.waiters) as ResourceLane[]) {
      this.drain(lane);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const lane of Object.keys(this.waiters) as ResourceLane[]) {
      const waiters = this.waiters[lane].splice(0);
      for (const waiter of waiters) {
        waiter.abortListener?.();
        waiter.reject(new Error('Resource governor is disposed'));
      }
    }
  }

  private acquire(request: ResourcePermitRequest): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('Resource governor is disposed'));
    }
    if (request.signal?.aborted) {
      return Promise.reject(createAbortError());
    }
    const lane = request.lane;
    if (this.active[lane] < this.limits[lane] && this.waiters[lane].length === 0) {
      this.active[lane] += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { request, sequence: this.sequence++, resolve, reject };
      const onAbort = (): void => {
        const index = this.waiters[lane].indexOf(waiter);
        if (index >= 0) {
          this.waiters[lane].splice(index, 1);
          reject(createAbortError());
        }
      };
      waiter.abortListener = onAbort;
      request.signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters[lane].push(waiter);
      this.drain(lane);
    });
  }

  private release(lane: ResourceLane): void {
    this.active[lane] = Math.max(0, this.active[lane] - 1);
    this.drain(lane);
  }

  private drain(lane: ResourceLane): void {
    while (this.active[lane] < this.limits[lane] && this.waiters[lane].length > 0) {
      this.waiters[lane].sort((left, right) => {
        const leftPriority = PRIORITY_WEIGHT[left.request.priority ?? 'workflow'];
        const rightPriority = PRIORITY_WEIGHT[right.request.priority ?? 'workflow'];
        return leftPriority - rightPriority || left.sequence - right.sequence;
      });
      const waiter = this.waiters[lane].shift();
      if (!waiter) {
        return;
      }
      waiter.request.signal?.removeEventListener('abort', waiter.abortListener as EventListener);
      if (waiter.request.signal?.aborted) {
        waiter.reject(createAbortError());
        continue;
      }
      this.active[lane] += 1;
      waiter.resolve();
    }
  }

  private snapshotLane(lane: ResourceLane): ResourceLaneSnapshot {
    return {
      limit: this.limits[lane],
      active: this.active[lane],
      queued: this.waiters[lane].length,
    };
  }
}
