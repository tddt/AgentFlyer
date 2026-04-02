import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { createLogger } from '../../../core/logger.js';
import type { CronScheduler } from '../../../scheduler/cron.js';
import type { AgentRunner } from '../../runner.js';
import type { RegisteredTool } from '../registry.js';

const logger = createLogger('tools:scheduler');

// ── helpers ────────────────────────────────────────────────────────────────

/** Convert "every N minutes" to a standard cron expression. */
function intervalToCron(minutes: number): string {
  if (minutes < 1) throw new Error('interval_minutes must be >= 1');
  if (minutes === 60) return '0 * * * *';
  if (minutes < 60) return `*/${minutes} * * * *`;
  const hours = Math.round(minutes / 60);
  return `0 */${hours} * * *`;
}

/** Drain an AgentRunner turn and return the final text reply. */
async function runTurn(runner: AgentRunner, message: string, thread: string): Promise<string> {
  const prev = runner.currentSessionKey;
  runner.setThread(thread);
  try {
    let output = '';
    const gen = runner.turn(message);
    let next = await gen.next();
    while (!next.done) {
      const chunk = next.value;
      if (chunk.type === 'text_delta') output += chunk.text;
      next = await gen.next();
    }
    return next.value.text || output || '(no output)';
  } finally {
    // Restore original thread – parse "agent:<id>:<thread>" format
    const parts = prev.split(':');
    if (parts.length >= 3) runner.setThread(parts.slice(2).join(':'));
  }
}

// ── task metadata store (persistent JSON) ─────────────────────────────────

export interface ScheduledTaskMeta {
  id: string;
  name: string;
  /** agentId is required for agent-targeted tasks; omit when workflowId is set. */
  agentId?: string;
  /** When set, the task triggers this workflow instead of an agent. */
  workflowId?: string;
  message: string;
  cronExpr: string;
  reportTo?: string;
  outputChannel?: 'logs' | 'cli' | 'web';
  publicationTargets?: Array<{
    channelId: string;
    threadKey: string;
    agentId?: string;
  }>;
  publicationChannels?: string[];
  enabled?: boolean;
  createdAt: number;
  runCount: number;
  lastRunAt?: number;
  lastResult?: string;
  latestDeliverableId?: string;
}

class TaskStore {
  private readonly filePath: string;
  private tasks = new Map<string, ScheduledTaskMeta>();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, 'scheduled-tasks.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const arr = JSON.parse(raw) as ScheduledTaskMeta[];
      for (const t of arr) this.tasks.set(t.id, t);
      logger.info('Loaded scheduled tasks', { count: this.tasks.size });
    } catch (err) {
      logger.warn('Failed to load scheduled-tasks.json, starting fresh', { error: String(err) });
    }
  }

  private save(): void {
    try {
      writeFileSync(
        this.filePath,
        JSON.stringify(Array.from(this.tasks.values()), null, 2),
        'utf-8',
      );
    } catch (err) {
      logger.error('Failed to save scheduled-tasks.json', { error: String(err) });
    }
  }

  has(id: string): boolean {
    return this.tasks.has(id);
  }
  get(id: string): ScheduledTaskMeta | undefined {
    return this.tasks.get(id);
  }
  all(): ScheduledTaskMeta[] {
    return Array.from(this.tasks.values());
  }
  size(): number {
    return this.tasks.size;
  }

  set(meta: ScheduledTaskMeta): void {
    this.tasks.set(meta.id, meta);
    this.save();
  }

  update(id: string, patch: Partial<ScheduledTaskMeta>): void {
    const existing = this.tasks.get(id);
    if (!existing) return;
    Object.assign(existing, patch);
    this.save();
  }

  delete(id: string): boolean {
    const deleted = this.tasks.delete(id);
    if (deleted) this.save();
    return deleted;
  }
}

const sharedTaskStores = new Map<string, TaskStore>();
const restoredTaskStores = new Set<string>();

// ── factory ────────────────────────────────────────────────────────────────

/**
 * Create scheduler tools that allow agents to assign recurring tasks
 * to themselves or other mesh agents.
 * @param runners  In-process runner map
 * @param scheduler  Shared CronScheduler instance
 * @param dataDir  Gateway data dir — tasks are persisted to {dataDir}/scheduled-tasks.json
 */
export function createSchedulerTools(
  runners: Map<string, AgentRunner>,
  scheduler: CronScheduler,
  dataDir: string,
): RegisteredTool[] {
  let store = sharedTaskStores.get(dataDir);
  if (!store) {
    store = new TaskStore(dataDir);
    sharedTaskStores.set(dataDir, store);
  }
  const taskStore = store;

  /** Wire up the cron handler for a given task spec (used for new + restored tasks). */
  function scheduleTaskHandler(meta: ScheduledTaskMeta): void {
    scheduler.schedule({
      id: meta.id,
      expression: meta.cronExpr,
      name: meta.name,
      handler: async () => {
        const current = taskStore.get(meta.id);
        if (!current) return; // cancelled

        // Workflow-targeted tasks are dispatched by the gateway's RPC layer, not here.
        if (!current.agentId || current.workflowId) {
          logger.info('Scheduled task: workflow target, skipping agent runner', {
            taskId: meta.id,
          });
          return;
        }

        const workerRunner = runners.get(current.agentId);
        if (!workerRunner) {
          logger.warn('Scheduled task: agent no longer available', {
            taskId: meta.id,
            agentId: current.agentId,
          });
          return;
        }

        logger.info('Running scheduled task', {
          taskId: meta.id,
          name: current.name,
          agentId: current.agentId,
        });
        const thread = `sched-${meta.id}-run-${current.runCount + 1}`;
        let result: string;
        try {
          result = await runTurn(workerRunner, current.message, thread);
          taskStore.update(meta.id, {
            runCount: current.runCount + 1,
            lastRunAt: Date.now(),
            lastResult: result.slice(0, 500),
          });
          logger.info('Scheduled task complete', { taskId: meta.id, name: current.name });
        } catch (err) {
          result = `Error: ${String(err)}`;
          logger.error('Scheduled task failed', {
            taskId: meta.id,
            name: current.name,
            error: String(err),
          });
        }

        if (current.reportTo) {
          const reporterRunner = runners.get(current.reportTo);
          if (reporterRunner) {
            const reportThread = `sched-report-${meta.id}`;
            const reportMsg = `[定时任务汇报] 任务名称: ${current.name}\n执行智能体: ${current.agentId}\n\n${result}`;
            try {
              await runTurn(reporterRunner, reportMsg, reportThread);
              logger.info('Task report sent', { taskId: meta.id, reportTo: current.reportTo });
            } catch (err) {
              logger.error('Failed to send task report', {
                taskId: meta.id,
                reportTo: current.reportTo,
                error: String(err),
              });
            }
          }
        }
      },
    });
  }

  // Restore persisted tasks on startup
  if (!restoredTaskStores.has(dataDir)) {
    restoredTaskStores.add(dataDir);
    for (const meta of taskStore.all()) {
      try {
        scheduleTaskHandler(meta);
        logger.info('Restored scheduled task', {
          taskId: meta.id,
          name: meta.name,
          cron: meta.cronExpr,
        });
      } catch (err) {
        logger.warn('Failed to restore scheduled task', { taskId: meta.id, error: String(err) });
      }
    }
  }

  // ── task_schedule ────────────────────────────────────────────────────────
  const taskSchedule: RegisteredTool = {
    category: 'scheduler',
    definition: {
      name: 'task_schedule',
      description:
        'Schedule a recurring task for a specific agent. ' +
        'The agent will run the given message/prompt on the specified schedule and ' +
        'optionally report its output to another agent. ' +
        'Specify either `cron` (cron expression) or `interval_minutes` (number).',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: 'ID of the agent to assign the task to (use mesh_list to discover agents)',
          },
          message: {
            type: 'string',
            description: 'The task prompt/instruction to send to the agent on each run',
          },
          name: {
            type: 'string',
            description: 'Human-readable task name (used in logs and task_list output)',
          },
          cron: {
            type: 'string',
            description: 'Cron expression, e.g. "0 * * * *" for every hour',
          },
          interval_minutes: {
            type: 'number',
            description:
              'Alternative to cron: repeat every N minutes (e.g. 60 = every hour). ' +
              'Ignored when `cron` is also set.',
          },
          report_to: {
            type: 'string',
            description:
              'Optional agent ID to send the task result to after each run. ' +
              'If omitted, the result is only logged.',
          },
        },
        required: ['agent_id', 'message', 'name'],
      },
    },
    async handler(input) {
      const { agent_id, message, name, cron, interval_minutes, report_to } = input as {
        agent_id: string;
        message: string;
        name: string;
        cron?: string;
        interval_minutes?: number;
        report_to?: string;
      };

      if (!runners.has(agent_id)) {
        const available = Array.from(runners.keys()).join(', ');
        return {
          isError: true,
          content: `Agent '${agent_id}' not found. Available: ${available || 'none'}`,
        };
      }
      if (report_to && !runners.has(report_to)) {
        return { isError: true, content: `report_to agent '${report_to}' not found.` };
      }

      // Determine cron expression
      let cronExpr: string;
      try {
        if (cron) {
          cronExpr = cron;
        } else if (typeof interval_minutes === 'number') {
          cronExpr = intervalToCron(interval_minutes);
        } else {
          return { isError: true, content: 'Provide either `cron` or `interval_minutes`.' };
        }
      } catch (err) {
        return { isError: true, content: `Invalid schedule: ${String(err)}` };
      }

      const taskId = ulid();
      const meta: ScheduledTaskMeta = {
        id: taskId,
        name,
        agentId: agent_id,
        message,
        cronExpr,
        reportTo: report_to,
        outputChannel: 'logs',
        enabled: true,
        createdAt: Date.now(),
        runCount: 0,
      };
      store.set(meta);
      scheduleTaskHandler(meta);

      const nextRun = scheduler.get(taskId)?.nextRunAt;
      const nextStr = nextRun ? new Date(nextRun).toLocaleString() : 'unknown';

      return {
        isError: false,
        content: [
          '✅ 任务已调度',
          `- Task ID: ${taskId}`,
          `- 名称: ${name}`,
          `- 执行智能体: ${agent_id}`,
          `- 调度表达式: ${cronExpr}`,
          `- 下次执行: ${nextStr}`,
          report_to ? `- 汇报给: ${report_to}` : '- 汇报: 仅记录日志',
        ].join('\n'),
      };
    },
  };

  // ── task_list ────────────────────────────────────────────────────────────
  const taskList: RegisteredTool = {
    category: 'scheduler',
    definition: {
      name: 'task_list',
      description: 'List all currently scheduled recurring tasks.',
      inputSchema: { type: 'object', properties: {} },
    },
    async handler(_input) {
      if (taskStore.size() === 0) {
        return { isError: false, content: 'No scheduled tasks.' };
      }
      const lines = taskStore.all().map((m) => {
        const lastRun = m.lastRunAt ? new Date(m.lastRunAt).toLocaleString() : 'never';
        const cronJob = scheduler.get(m.id);
        const nextRun = cronJob?.nextRunAt ? new Date(cronJob.nextRunAt).toLocaleString() : 'n/a';
        return [
          `[${m.id}] ${m.name}`,
          `  agent: ${m.agentId} | cron: ${m.cronExpr} | runs: ${m.runCount}`,
          `  last: ${lastRun} | next: ${nextRun}`,
          m.reportTo ? `  reports to: ${m.reportTo}` : '',
          m.lastResult ? `  last result preview: ${m.lastResult.slice(0, 80)}…` : '',
        ]
          .filter(Boolean)
          .join('\n');
      });
      return { isError: false, content: lines.join('\n\n') };
    },
  };

  // ── task_cancel ──────────────────────────────────────────────────────────
  const taskCancel: RegisteredTool = {
    category: 'scheduler',
    definition: {
      name: 'task_cancel',
      description: 'Cancel and remove a scheduled recurring task by its task ID.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID returned by task_schedule' },
        },
        required: ['task_id'],
      },
    },
    async handler(input) {
      const { task_id } = input as { task_id: string };
      const meta = taskStore.get(task_id);
      if (!meta) {
        return { isError: true, content: `Task '${task_id}' not found.` };
      }
      scheduler.cancel(task_id);
      taskStore.delete(task_id);
      return { isError: false, content: `Task '${meta.name}' (${task_id}) cancelled.` };
    },
  };

  return [taskSchedule, taskList, taskCancel];
}
