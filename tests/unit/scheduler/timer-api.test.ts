import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimerApi } from '../../../src/scheduler/timer-api.js';

describe('TimerApi', () => {
  let timers: TimerApi;

  beforeEach(() => {
    vi.useFakeTimers();
    timers = new TimerApi();
  });

  afterEach(() => {
    timers.cancelAll();
    vi.useRealTimers();
  });

  describe('after()', () => {
    it('fires handler after the given delay', async () => {
      const spy = vi.fn();
      timers.after(500, spy);
      expect(spy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(spy).toHaveBeenCalledOnce();
    });

    it('returns a handle with an id', () => {
      const handle = timers.after(1000, vi.fn());
      expect(typeof handle.id).toBe('string');
      expect(handle.id.length).toBeGreaterThan(0);
    });

    it('auto-removes itself from registry after firing', async () => {
      timers.after(100, vi.fn());
      expect(timers.size).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(timers.size).toBe(0);
    });

    it('accepts an optional name without error', () => {
      expect(() => timers.after(100, vi.fn(), 'my-timer')).not.toThrow();
    });
  });

  describe('every()', () => {
    it('fires handler repeatedly on each interval', async () => {
      const spy = vi.fn();
      timers.every(200, spy);
      await vi.advanceTimersByTimeAsync(1000);
      expect(spy).toHaveBeenCalledTimes(5);
    });

    it('returns a handle with an id', () => {
      const handle = timers.every(500, vi.fn());
      expect(typeof handle.id).toBe('string');
    });

    it('stays in registry until cancelled', async () => {
      timers.every(100, vi.fn());
      expect(timers.size).toBe(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(timers.size).toBe(1);
    });
  });

  describe('cancel()', () => {
    it('returns true and stops a registered one-shot timer', async () => {
      const spy = vi.fn();
      const handle = timers.after(500, spy);
      const result = timers.cancel(handle.id);
      expect(result).toBe(true);
      await vi.advanceTimersByTimeAsync(600);
      expect(spy).not.toHaveBeenCalled();
    });

    it('returns true and stops a registered interval timer', async () => {
      const spy = vi.fn();
      const handle = timers.every(100, spy);
      timers.cancel(handle.id);
      await vi.advanceTimersByTimeAsync(500);
      expect(spy).not.toHaveBeenCalled();
    });

    it('returns false for an unknown id', () => {
      expect(timers.cancel('nonexistent-id')).toBe(false);
    });

    it('decrements size after cancellation', () => {
      const h1 = timers.every(100, vi.fn());
      const h2 = timers.every(200, vi.fn());
      expect(timers.size).toBe(2);
      timers.cancel(h1.id);
      expect(timers.size).toBe(1);
      timers.cancel(h2.id);
      expect(timers.size).toBe(0);
    });
  });

  describe('cancelAll()', () => {
    it('cancels all timers and sets size to 0', async () => {
      const spy = vi.fn();
      timers.after(300, spy);
      timers.every(100, spy);
      expect(timers.size).toBe(2);
      timers.cancelAll();
      expect(timers.size).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(spy).not.toHaveBeenCalled();
    });

    it('is a no-op when no timers are registered', () => {
      expect(() => timers.cancelAll()).not.toThrow();
      expect(timers.size).toBe(0);
    });
  });

  describe('size', () => {
    it('starts at 0', () => {
      expect(timers.size).toBe(0);
    });

    it('increments with each timer added', () => {
      timers.after(100, vi.fn());
      expect(timers.size).toBe(1);
      timers.every(200, vi.fn());
      expect(timers.size).toBe(2);
    });
  });
});
