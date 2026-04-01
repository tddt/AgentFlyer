/**
 * SenderRateLimiter — fixed-window rate limiter keyed by sender identifier.
 *
 * Used in channel inbound handlers to prevent a single user from flooding
 * the gateway with messages. The window resets after `windowMs` milliseconds.
 *
 * Architecture ref: docs/02-baseline-features.md §F2.4 "速率限制（防滥用）"
 */
export interface RateLimitConfig {
  /** Maximum messages allowed per window. Default: 10 */
  maxRequests: number;
  /** Window duration in milliseconds. Default: 60_000 (1 minute) */
  windowMs: number;
}

interface Window {
  count: number;
  resetAt: number;
}

export class SenderRateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private _cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<RateLimitConfig>) {
    this.maxRequests = config?.maxRequests ?? 10;
    this.windowMs = config?.windowMs ?? 60_000;
  }

  /**
   * Check whether the sender is within the rate limit.
   * Returns true if the message is allowed, false if it should be dropped.
   * RATIONALE: call this before dispatching to the agent queue so the queue
   * never backs up due to a single abusive sender.
   */
  check(senderId: string): boolean {
    const now = Date.now();
    const win = this.windows.get(senderId);
    if (!win || now >= win.resetAt) {
      this.windows.set(senderId, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (win.count >= this.maxRequests) return false;
    win.count++;
    return true;
  }

  /**
   * Start a periodic cleanup timer to remove expired windows.
   * Call stop() when the gateway shuts down to avoid timer leaks.
   */
  startCleanup(intervalMs = 300_000): void {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, win] of this.windows) {
        if (now >= win.resetAt) this.windows.delete(key);
      }
    }, intervalMs);
    // Do not block process exit
    this._cleanupTimer.unref?.();
  }

  stop(): void {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }
}
