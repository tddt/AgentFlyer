import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CronScheduler } from '../../../src/scheduler/cron.js';
import type { CronJobSpec } from '../../../src/scheduler/cron.js';

describe('CronScheduler', () => {
  let scheduler: CronScheduler;

  beforeEach(() => {
    scheduler = new CronScheduler();
  });

  afterEach(() => {
    scheduler.stopAll();
  });

  function noop(): void {}

  function makeSpec(overrides: Partial<CronJobSpec> = {}): CronJobSpec {
    return {
      // Every minute — won't actually fire in unit tests
      expression: '* * * * *',
      name: 'Test Job',
      handler: noop,
      ...overrides,
    };
  }

  describe('schedule()', () => {
    it('returns a CronJob with the expected fields', () => {
      const job = scheduler.schedule(makeSpec({ name: 'My Job', expression: '0 * * * *' }));
      expect(job.id).toBeTruthy();
      expect(job.name).toBe('My Job');
      expect(job.expression).toBe('0 * * * *');
      expect(typeof job.createdAt).toBe('number');
    });

    it('auto-generates an id when none is provided', () => {
      const job = scheduler.schedule(makeSpec());
      expect(typeof job.id).toBe('string');
      expect(job.id.length).toBeGreaterThan(0);
    });

    it('uses the provided id when given', () => {
      const job = scheduler.schedule(makeSpec({ id: 'my-specific-id' }));
      expect(job.id).toBe('my-specific-id');
    });

    it('throws when scheduling a duplicate id', () => {
      scheduler.schedule(makeSpec({ id: 'dup-id' }));
      expect(() => scheduler.schedule(makeSpec({ id: 'dup-id' }))).toThrow("'dup-id' already exists");
    });

    it('exposes nextRunAt as a future timestamp', () => {
      const job = scheduler.schedule(makeSpec());
      // nextRunAt should be a future epoch ms
      expect(typeof job.nextRunAt).toBe('number');
      expect(job.nextRunAt!).toBeGreaterThan(Date.now() - 1000);
    });

    it('lastRunAt is undefined before first execution', () => {
      const job = scheduler.schedule(makeSpec());
      expect(job.lastRunAt).toBeUndefined();
    });
  });

  describe('cancel()', () => {
    it('returns true and removes a registered job', () => {
      const job = scheduler.schedule(makeSpec({ id: 'cancellable' }));
      const result = scheduler.cancel('cancellable');
      expect(result).toBe(true);
      expect(scheduler.get(job.id)).toBeUndefined();
    });

    it('returns false for an unknown id', () => {
      expect(scheduler.cancel('no-such-job')).toBe(false);
    });

    it('removes the job from list() after cancel', () => {
      scheduler.schedule(makeSpec({ id: 'job-a' }));
      scheduler.schedule(makeSpec({ id: 'job-b' }));
      scheduler.cancel('job-a');
      const ids = scheduler.list().map((j) => j.id);
      expect(ids).not.toContain('job-a');
      expect(ids).toContain('job-b');
    });
  });

  describe('get()', () => {
    it('returns the job when found', () => {
      const job = scheduler.schedule(makeSpec({ id: 'lookup-me' }));
      expect(scheduler.get('lookup-me')).toBe(job);
    });

    it('returns undefined for unknown id', () => {
      expect(scheduler.get('ghost')).toBeUndefined();
    });
  });

  describe('list()', () => {
    it('returns empty array initially', () => {
      expect(scheduler.list()).toEqual([]);
    });

    it('returns all scheduled jobs', () => {
      scheduler.schedule(makeSpec({ id: 'j1', name: 'Job 1' }));
      scheduler.schedule(makeSpec({ id: 'j2', name: 'Job 2' }));
      const jobs = scheduler.list();
      expect(jobs).toHaveLength(2);
      const names = jobs.map((j) => j.name);
      expect(names).toContain('Job 1');
      expect(names).toContain('Job 2');
    });
  });

  describe('stopAll()', () => {
    it('clears all jobs', () => {
      scheduler.schedule(makeSpec({ id: 'x1' }));
      scheduler.schedule(makeSpec({ id: 'x2' }));
      scheduler.stopAll();
      expect(scheduler.list()).toEqual([]);
    });

    it('is idempotent — calling twice does not throw', () => {
      scheduler.schedule(makeSpec({ id: 'y1' }));
      scheduler.stopAll();
      expect(() => scheduler.stopAll()).not.toThrow();
    });
  });

  describe('stop() on individual job', () => {
    it('job.stop() can be called without error', () => {
      const job = scheduler.schedule(makeSpec());
      expect(() => job.stop()).not.toThrow();
    });
  });
});
