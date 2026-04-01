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
  private readonly _pending: Array<() => Promise<void>> = [];

  /**
   * Enqueue a task. If the agent is idle the task starts immediately.
   * If busy, the task is queued and will run after the current one completes.
   *
   * The returned promise resolves (or rejects) when the enqueued task finishes.
   * This lets channel handlers await the full reply before accepting the next one.
   */
  enqueue(fn: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wrapped = async (): Promise<void> => {
        try {
          await fn();
          resolve();
        } catch (err) {
          reject(err);
        }
      };

      if (!this._busy) {
        this._busy = true;
        void wrapped().finally(() => this._drain());
      } else {
        this._pending.push(wrapped);
      }
    });
  }

  /** Returns true while a task is running or tasks are pending. */
  get busy(): boolean {
    return this._busy || this._pending.length > 0;
  }

  /** How many tasks are waiting behind the current one. */
  get queueDepth(): number {
    return this._pending.length;
  }

  private _drain(): void {
    const next = this._pending.shift();
    if (!next) {
      this._busy = false;
      return;
    }
    void next().finally(() => this._drain());
  }
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

  /** Remove the queue when an agent is unregistered (optional cleanup). */
  remove(agentId: string): void {
    this._queues.delete(agentId);
  }
}
