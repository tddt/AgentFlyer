import { ulid } from 'ulid';
import { createLogger } from '../core/logger.js';

const logger = createLogger('scheduler:timer');

export interface TimerHandle {
  id: string;
  cancel(): void;
}

/**
 * Named one-shot and repeating timers with automatic cleanup.
 * Wraps setTimeout / setInterval with an ID + registry so callers
 * can cancel by ID rather than keeping a reference.
 */
export class TimerApi {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Schedule a one-shot callback after `delayMs` milliseconds.
   * Returns a cancellable handle.
   */
  after(delayMs: number, handler: () => void | Promise<void>, name?: string): TimerHandle {
    const id = ulid();
    const label = name ?? id;
    const timer = setTimeout(async () => {
      this.timers.delete(id);
      logger.debug('Timer fired', { id: label });
      try {
        await handler();
      } catch (err) {
        logger.error('Timer handler error', { id: label, error: String(err) });
      }
    }, delayMs);
    if ((timer as unknown as { unref?: () => void }).unref) {
      (timer as unknown as { unref: () => void }).unref();
    }
    this.timers.set(id, timer);
    return { id, cancel: () => this.cancel(id) };
  }

  /**
   * Schedule a repeating callback every `intervalMs` milliseconds.
   */
  every(intervalMs: number, handler: () => void | Promise<void>, name?: string): TimerHandle {
    const id = ulid();
    const label = name ?? id;
    const timer = setInterval(async () => {
      logger.debug('Interval fired', { id: label });
      try {
        await handler();
      } catch (err) {
        logger.error('Interval handler error', { id: label, error: String(err) });
      }
    }, intervalMs);
    if ((timer as unknown as { unref?: () => void }).unref) {
      (timer as unknown as { unref: () => void }).unref();
    }
    this.timers.set(id, timer as unknown as ReturnType<typeof setTimeout>);
    return { id, cancel: () => this.cancel(id) };
  }

  cancel(id: string): boolean {
    const t = this.timers.get(id);
    if (!t) return false;
    clearTimeout(t);
    clearInterval(t);
    this.timers.delete(id);
    return true;
  }

  cancelAll(): void {
    for (const t of this.timers.values()) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers.clear();
  }

  get size(): number {
    return this.timers.size;
  }
}
