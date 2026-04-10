/**
 * AgentQueue — FIFO per-agent command queue.
 *
 * Prevents concurrent turn() calls on the same AgentRunner which would corrupt
 * shared instance state (threadKey, sessionKey, toolResultCache, promptLayerHashes).
 *
 * Architecture ref: docs/04-technical-architecture.md §5.1
 * "同一 Agent 同时只运行一个任务（防止 LLM 上下文混乱）"
 */
export class AgentQueue {
  private _busy = false;
  private readonly _pending: Array<QueuedTask<unknown>> = [];

  private startTask<T>(task: QueuedTask<T>, wasQueued: boolean): void {
    task.hooks?.onStarted?.({
      wasQueued,
      queueDepth: this._pending.length,
    });
    void task.run().finally(() => this._drain());
  }

  /**
   * Enqueue a task. If the agent is idle the task starts immediately.
   * If busy, the task is queued and will run after the current one completes.
   *
   * The returned promise resolves (or rejects) when the enqueued task finishes.
   * This lets channel handlers await the full reply before accepting the next one.
   */
  enqueue<T>(fn: () => Promise<T>, hooks?: AgentQueueHooks): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask<T> = {
        hooks,
        taskKey: hooks?.taskKey,
        cancel: (): void => {
          resolve(undefined as T);
        },
        run: async (): Promise<void> => {
        try {
            resolve(await fn());
        } catch (err) {
          reject(err);
        }
        },
      };

      if (!this._busy) {
        this._busy = true;
        this.startTask(task, false);
      } else {
        hooks?.onQueued?.({ position: this._pending.length + 1 });
        this._pending.push(task);
      }
    });
  }

  cancelPending(taskKey: string): boolean {
    const index = this._pending.findIndex((task) => task.taskKey === taskKey);
    if (index < 0) {
      return false;
    }
    const [task] = this._pending.splice(index, 1);
    task?.cancel();
    return true;
  }

  /** Returns true while a task is running or tasks are pending. */
  get busy(): boolean {
    return this._busy || this._pending.length > 0;
  }

  /** How many tasks are waiting behind the current one. */
  get queueDepth(): number {
    return this._pending.length;
  }

  /** Snapshot of current execution/queue state for status surfaces. */
  get snapshot(): AgentQueueSnapshot {
    return {
      hasActiveTask: this._busy,
      pendingCount: this._pending.length,
      busy: this._busy || this._pending.length > 0,
    };
  }

  private _drain(): void {
    const next = this._pending.shift();
    if (!next) {
      this._busy = false;
      return;
    }
    this.startTask(next, true);
  }
}

interface AgentQueueHooks {
  taskKey?: string;
  onQueued?: (event: { position: number }) => void;
  onStarted?: (event: { wasQueued: boolean; queueDepth: number }) => void;
}

export interface AgentQueueSnapshot {
  hasActiveTask: boolean;
  pendingCount: number;
  busy: boolean;
}

interface QueuedTask<T> {
  taskKey?: string;
  cancel: () => void;
  run: () => Promise<void>;
  hooks?: AgentQueueHooks;
}

/**
 * Registry that creates and caches one AgentQueue per agent ID.
 * The gateway creates a single AgentQueueRegistry and reuses it across all
 * channel inbound handlers so the same logical agent always shares one queue.
 */
export class AgentQueueRegistry {
  private readonly _queues = new Map<string, AgentQueue>();

  /** Get (or lazily create) the queue for the given agent. */
  for(agentId: string): AgentQueue {
    let q = this._queues.get(agentId);
    if (!q) {
      q = new AgentQueue();
      this._queues.set(agentId, q);
    }
    return q;
  }

  /** Peek the queue without creating a new one. */
  get(agentId: string): AgentQueue | undefined {
    return this._queues.get(agentId);
  }

  /** Return current queue status for an agent. */
  status(agentId: string): AgentQueueSnapshot {
    return this._queues.get(agentId)?.snapshot ?? {
      hasActiveTask: false,
      pendingCount: 0,
      busy: false,
    };
  }

  cancelPending(agentId: string, taskKey: string): boolean {
    return this._queues.get(agentId)?.cancelPending(taskKey) ?? false;
  }

  /** Remove the queue when an agent is unregistered (optional cleanup). */
  remove(agentId: string): void {
    this._queues.delete(agentId);
  }
}
