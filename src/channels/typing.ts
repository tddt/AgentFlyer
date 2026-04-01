/**
 * TypingKeepAlive — repeatedly fires a typing callback to keep the
 * "is typing…" indicator alive in messaging platforms.
 *
 * Behaviour:
 *  - Fires `fn` immediately on start(), then every PULSE_MS thereafter.
 *  - Auto-stops when MAX_FAILURES consecutive errors occur (circuit breaker).
 *  - Auto-stops after TTL_MS regardless (hard cap to avoid runaway loops).
 *  - Errors from `fn` are silently swallowed after counting.
 */

const PULSE_MS = 3_000; // Telegram typing expires in ~5s; 3s keeps it alive
const MAX_FAILURES = 2; // stop after 2 consecutive errors
const TTL_MS = 60_000; // hard cap: 60 seconds max

export class TypingKeepAlive {
  private timer: ReturnType<typeof setInterval> | null = null;
  private failures = 0;
  private readonly startedAt = Date.now();

  /**
   * Start the keepalive loop.
   * `fn` is called immediately and then every PULSE_MS until stop() or auto-stop.
   */
  start(fn: () => Promise<void>): void {
    const pulse = (): void => {
      fn().catch(() => {
        this.failures++;
        if (this.failures >= MAX_FAILURES) this.stop();
      });
    };

    pulse();

    this.timer = setInterval(() => {
      if (Date.now() - this.startedAt >= TTL_MS) {
        this.stop();
        return;
      }
      pulse();
    }, PULSE_MS);
  }

  /** Stop the keepalive loop immediately. Safe to call multiple times. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
