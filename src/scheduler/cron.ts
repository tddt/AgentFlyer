import { Cron } from 'croner';
import { ulid } from 'ulid';
import { createLogger } from '../core/logger.js';

const logger = createLogger('scheduler:cron');

export interface CronJobSpec {
  id?: string;
  /** Cron expression, e.g. '0 * * * *' or '@hourly' */
  expression: string;
  name: string;
  handler: () => void | Promise<void>;
  /** Prevent concurrent executions (default true). */
  protect?: boolean;
}

export interface CronJob {
  id: string;
  name: string;
  expression: string;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  stop(): void;
}

export class CronScheduler {
  private jobs = new Map<string, { job: CronJob; cron: Cron }>();

  schedule(spec: CronJobSpec): CronJob {
    const id = spec.id ?? ulid();
    if (this.jobs.has(id)) {
      throw new Error(`Cron job with id '${id}' already exists`);
    }

    const protect = spec.protect !== false;
    let lastRunAt: number | undefined;

    const cron = new Cron(spec.expression, { protect }, async () => {
      lastRunAt = Date.now();
      logger.debug('Cron job fired', { id, name: spec.name });
      try {
        await spec.handler();
      } catch (err) {
        logger.error('Cron job error', { id, name: spec.name, error: String(err) });
      }
    });

    const job: CronJob = {
      id,
      name: spec.name,
      expression: spec.expression,
      createdAt: Date.now(),
      get lastRunAt() {
        return lastRunAt;
      },
      get nextRunAt() {
        const next = cron.nextRun();
        return next ? next.getTime() : undefined;
      },
      stop() {
        cron.stop();
      },
    };

    this.jobs.set(id, { job, cron });
    logger.info('Cron job scheduled', { id, name: spec.name, expression: spec.expression });
    return job;
  }

  cancel(id: string): boolean {
    const entry = this.jobs.get(id);
    if (!entry) return false;
    entry.cron.stop();
    this.jobs.delete(id);
    logger.info('Cron job cancelled', { id });
    return true;
  }

  /** Retrieve a scheduled job by id (returns undefined if not found). */
  get(id: string): CronJob | undefined {
    return this.jobs.get(id)?.job;
  }

  list(): CronJob[] {
    return Array.from(this.jobs.values()).map((e) => e.job);
  }

  stopAll(): void {
    for (const [, { cron }] of this.jobs) cron.stop();
    this.jobs.clear();
  }
}
