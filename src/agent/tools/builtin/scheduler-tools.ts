import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { createLogger } from '../../../core/logger.js';
import type { CronScheduler } from '../../../scheduler/cron.js';
import {
  type ScheduledAgentActiveRunStatus,
  type ScheduledAgentRunStatus,
  appendScheduledTaskHistoryRecord,
  getScheduledTaskExecutionSummaryById,
} from '../../../scheduler/task-history.js';
import {
  abortAgentTurnViaKernel,
  executeAgentTurnViaKernel,
  getAgentTurnRunViaKernel,
  resumeAgentTurnViaKernel,
  waitForAgentTurnViaKernel,
} from '../../kernel-turn-executor.js';
import type { AgentRunner } from '../../runner.js';
import { executeDelegatedAgentRun } from '../../scheduled-agent-run.js';
import { deriveAgentTurnControlState } from '../../turn-run-state.js';
import type { RegisteredTool } from '../registry.js';
import {
  type ScheduledTaskRecord,
  type ScheduledTaskView,
  stripTaskExecutionSummary,
} from './scheduler-task-meta.js';

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

interface ScheduledAgentTurnOutcome {
  text: string;
  runId: string;
  runStatus: ScheduledAgentRunStatus;
}

interface ActiveScheduledRun {
  agentId: string;
  runId: string;
  runStatus: ScheduledAgentActiveRunStatus;
}

interface ScheduledRunFinalizeOptions {
  runKey: string;
  startedAt: number;
  countAsNewExecution: boolean;
}

function deriveActiveScheduledRunStatus(
  run: Parameters<typeof deriveAgentTurnControlState>[0],
): ScheduledAgentActiveRunStatus | null {
  const controlState = deriveAgentTurnControlState(run);
  if (controlState === 'suspended') {
    return 'suspended';
  }
  if (controlState === 'done' || controlState === 'error') {
    return null;
  }
  return 'running';
}

/** Drain an AgentRunner turn and preserve the delegated run metadata. */
async function runTurn(
  agentId: string,
  runner: AgentRunner,
  message: string,
  thread: string,
  dataDir: string,
  runId: string,
): Promise<ScheduledAgentTurnOutcome> {
  return executeDelegatedAgentRun({
    resolveRunId: async () => runId,
    waitForResult: async (resolvedRunId) =>
      await executeAgentTurnViaKernel({
        runners: new Map([[agentId, runner]]),
        dataDir,
        input: {
          runId: resolvedRunId,
          agentId,
          userMessage: message,
          threadKey: thread,
        },
      }),
    readRun: async (resolvedRunId) =>
      await getAgentTurnRunViaKernel({
        runners: new Map([[agentId, runner]]),
        dataDir,
        runId: resolvedRunId,
      }),
  });
}

async function waitForTurn(
  agentId: string,
  runner: AgentRunner,
  dataDir: string,
  runId: string,
  onRunState?: (runId: string) => void,
): Promise<ScheduledAgentTurnOutcome> {
  return executeDelegatedAgentRun({
    resolveRunId: async () => runId,
    beforeWait: async (resolvedRunId) => {
      await resumeAgentTurnViaKernel({
        runners: new Map([[agentId, runner]]),
        dataDir,
        runId: resolvedRunId,
      });
    },
    onRunState: onRunState ? ({ agentRunId }) => onRunState(agentRunId) : undefined,
    waitForResult: async (resolvedRunId) =>
      await waitForAgentTurnViaKernel({
        runners: new Map([[agentId, runner]]),
        dataDir,
        runId: resolvedRunId,
      }),
    readRun: async (resolvedRunId) =>
      await getAgentTurnRunViaKernel({
        runners: new Map([[agentId, runner]]),
        dataDir,
        runId: resolvedRunId,
      }),
  });
}

// ── task metadata store (persistent JSON) ─────────────────────────────────

class TaskStore {
  private readonly filePath: string;
  private tasks = new Map<string, ScheduledTaskRecord>();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, 'scheduled-tasks.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const arr = JSON.parse(raw) as ScheduledTaskView[];
      let strippedLegacySummary = false;
      for (const task of arr) {
        if (
          task.lastRunAt !== undefined ||
          task.lastResult !== undefined ||
          task.latestDeliverableId !== undefined
        ) {
          strippedLegacySummary = true;
        }
        const normalized = stripTaskExecutionSummary(task);
        this.tasks.set(normalized.id, normalized);
      }
      if (strippedLegacySummary) {
        this.save();
      }
      logger.info('Loaded scheduled tasks', { count: this.tasks.size });
    } catch (err) {
      logger.warn('Failed to load scheduled-tasks.json, starting fresh', { error: String(err) });
    }
  }

  private save(): void {
    try {
      writeFileSync(
        this.filePath,
        JSON.stringify(Array.from(this.tasks.values()).map(stripTaskExecutionSummary), null, 2),
        'utf-8',
      );
    } catch (err) {
      logger.error('Failed to save scheduled-tasks.json', { error: String(err) });
    }
  }

  has(id: string): boolean {
    return this.tasks.has(id);
  }
  get(id: string): ScheduledTaskRecord | undefined {
    return this.tasks.get(id);
  }
  all(): ScheduledTaskRecord[] {
    return Array.from(this.tasks.values());
  }
  size(): number {
    return this.tasks.size;
  }

  set(meta: ScheduledTaskRecord): void {
    this.tasks.set(meta.id, meta);
    this.save();
  }

  update(id: string, patch: Partial<ScheduledTaskRecord>): void {
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
const sharedActiveRuns = new Map<string, Map<string, ActiveScheduledRun>>();
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
  const activeRuns = (() => {
    const existing = sharedActiveRuns.get(dataDir);
    if (existing) {
      return existing;
    }
    const created = new Map<string, ActiveScheduledRun>();
    sharedActiveRuns.set(dataDir, created);
    return created;
  })();

  async function refreshActiveRun(taskId: string): Promise<ActiveScheduledRun | null> {
    const activeRun = activeRuns.get(taskId);
    if (!activeRun) {
      return null;
    }
    const current = await getAgentTurnRunViaKernel({
      runners: new Map([[activeRun.agentId, runners.get(activeRun.agentId) as AgentRunner]]),
      dataDir,
      runId: activeRun.runId,
    });
    if (!current) {
      return activeRun;
    }
    const runStatus = deriveActiveScheduledRunStatus(current);
    if (!runStatus) {
      activeRuns.delete(taskId);
      return null;
    }
    if (activeRun.runStatus === runStatus) {
      return activeRun;
    }
    const refreshed = { ...activeRun, runStatus };
    activeRuns.set(taskId, refreshed);
    return refreshed;
  }

  async function finalizeTaskRun(
    current: ScheduledTaskRecord,
    outcome: ScheduledAgentTurnOutcome,
    options: ScheduledRunFinalizeOptions,
  ): Promise<void> {
    if (outcome.runStatus === 'suspended') {
      activeRuns.set(current.id, {
        agentId: current.agentId ?? 'unknown-agent',
        runId: outcome.runId,
        runStatus: 'suspended',
      });
    } else {
      activeRuns.delete(current.id);
    }

    const finishedAt = Date.now();
    if (options.countAsNewExecution) {
      taskStore.update(current.id, {
        runCount: current.runCount + 1,
      });
    }
    const runOk = outcome.runStatus === 'done';
    await appendScheduledTaskHistoryRecord(dataDir, {
      taskId: current.id,
      taskName: current.name,
      runKey: options.runKey,
      startedAt: options.startedAt,
      finishedAt,
      ok: runOk,
      result: outcome.text.slice(0, 2000),
      agentId: current.agentId,
      agentRunId: outcome.runId,
      agentRunStatus: outcome.runStatus,
    }).catch((err) =>
      logger.warn('Failed to write task run history', {
        taskId: current.id,
        error: String(err),
      }),
    );

    if (runOk) {
      logger.info('Scheduled task complete', { taskId: current.id, name: current.name });
    } else {
      logger.error('Scheduled task failed', {
        taskId: current.id,
        name: current.name,
        error: outcome.text,
      });
    }

    if (current.reportTo) {
      const reporterRunner = runners.get(current.reportTo);
      if (reporterRunner) {
        const reportThread = `sched-report-${current.id}`;
        const reportMsg =
          `[定时任务汇报] 任务名称: ${current.name}\n` +
          `执行智能体: ${current.agentId}\n` +
          `运行状态: ${outcome.runStatus}\n` +
          `Run ID: ${outcome.runId}\n\n${outcome.text}`;
        try {
          const reportRunId = ulid();
          const reportTurn = await runTurn(
            current.reportTo,
            reporterRunner,
            reportMsg,
            reportThread,
            dataDir,
            reportRunId,
          );
          if (reportTurn.runStatus === 'done') {
            logger.info('Task report sent', { taskId: current.id, reportTo: current.reportTo });
          } else {
            logger.error('Failed to send task report', {
              taskId: current.id,
              reportTo: current.reportTo,
              error: reportTurn.text,
            });
          }
        } catch (err) {
          logger.error('Failed to send task report', {
            taskId: current.id,
            reportTo: current.reportTo,
            error: String(err),
          });
        }
      }
    }
  }

  /** Wire up the cron handler for a given task spec (used for new + restored tasks). */
  function scheduleTaskHandler(meta: ScheduledTaskRecord): void {
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

        const existingActiveRun = await refreshActiveRun(meta.id);
        if (existingActiveRun) {
          logger.info('Scheduled task skipped because previous run is still active', {
            taskId: meta.id,
            runId: existingActiveRun.runId,
            runStatus: existingActiveRun.runStatus,
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
        const startedAt = Date.now();
        const delegatedRunId = ulid();
        activeRuns.set(meta.id, {
          agentId: current.agentId,
          runId: delegatedRunId,
          runStatus: 'running',
        });
        const turn = await runTurn(
          current.agentId,
          workerRunner,
          current.message,
          thread,
          dataDir,
          delegatedRunId,
        );
        await finalizeTaskRun(current, turn, {
          runKey: thread,
          startedAt,
          countAsNewExecution: true,
        });
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
      const meta: ScheduledTaskRecord = {
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
      const summaryByTaskId = await getScheduledTaskExecutionSummaryById(dataDir);
      const lines = await Promise.all(
        taskStore.all().map(async (m) => {
          const summary = summaryByTaskId.get(m.id);
          const activeRun = await refreshActiveRun(m.id);
          const lastRunAt = summary?.lastRunAt;
          const lastResult = summary?.lastResult;
          const lastAgentRunId = summary?.lastAgentRunId;
          const lastAgentRunStatus = summary?.lastAgentRunStatus;
          const lastRun = lastRunAt ? new Date(lastRunAt).toLocaleString() : 'never';
          const cronJob = scheduler.get(m.id);
          const nextRun = cronJob?.nextRunAt ? new Date(cronJob.nextRunAt).toLocaleString() : 'n/a';
          return [
            `[${m.id}] ${m.name}`,
            `  agent: ${m.agentId} | cron: ${m.cronExpr} | runs: ${m.runCount}`,
            `  last: ${lastRun} | next: ${nextRun}`,
            activeRun
              ? `  current agent run: ${activeRun.runStatus} | runId: ${activeRun.runId}`
              : '',
            lastAgentRunStatus
              ? `  last agent run: ${lastAgentRunStatus} | runId: ${lastAgentRunId ?? 'n/a'}`
              : '',
            m.reportTo ? `  reports to: ${m.reportTo}` : '',
            lastResult ? `  last result preview: ${lastResult.slice(0, 80)}…` : '',
          ]
            .filter(Boolean)
            .join('\n');
        }),
      );
      return { isError: false, content: lines.join('\n\n') };
    },
  };

  const taskResume: RegisteredTool = {
    category: 'scheduler',
    definition: {
      name: 'task_resume',
      description: 'Resume the currently suspended delegated run for a scheduled recurring task.',
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
      const activeRun = await refreshActiveRun(task_id);
      if (!activeRun || activeRun.runStatus !== 'suspended') {
        return {
          isError: true,
          content: `Task '${meta.name}' (${task_id}) does not have a suspended run to resume.`,
        };
      }
      const runner = runners.get(activeRun.agentId);
      if (!runner) {
        return {
          isError: true,
          content: `Agent '${activeRun.agentId}' is no longer available for task '${task_id}'.`,
        };
      }

      const resumedAt = Date.now();
      const resumedOutcome = await waitForTurn(
        activeRun.agentId,
        runner,
        dataDir,
        activeRun.runId,
        (resolvedRunId) => {
          activeRuns.set(task_id, {
            agentId: activeRun.agentId,
            runId: resolvedRunId,
            runStatus: 'running',
          });
        },
      );
      await finalizeTaskRun(meta, resumedOutcome, {
        runKey: `sched-${task_id}-resume-${resumedAt}`,
        startedAt: resumedAt,
        countAsNewExecution: false,
      });

      if (resumedOutcome.runStatus === 'done') {
        return {
          isError: false,
          content: `Task '${meta.name}' (${task_id}) resumed and completed. Run ID: ${resumedOutcome.runId}`,
        };
      }
      if (resumedOutcome.runStatus === 'suspended') {
        return {
          isError: false,
          content:
            `Task '${meta.name}' (${task_id}) resumed but is suspended again. ` +
            `Run ID: ${resumedOutcome.runId}\n${resumedOutcome.text}`,
        };
      }
      return {
        isError: true,
        content:
          `Task '${meta.name}' (${task_id}) resumed but failed. ` +
          `Run ID: ${resumedOutcome.runId}\n${resumedOutcome.text}`,
      };
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
      const activeRun = await refreshActiveRun(task_id);
      if (activeRun) {
        const activeRunner = runners.get(activeRun.agentId);
        try {
          if (activeRunner) {
            await abortAgentTurnViaKernel({
              runners: new Map([[activeRun.agentId, activeRunner]]),
              dataDir,
              runId: activeRun.runId,
              message: `Scheduled task '${meta.name}' (${task_id}) cancelled.`,
            });
          }
        } catch (err) {
          logger.warn('Failed to abort active scheduled task run', {
            taskId: task_id,
            runId: activeRun.runId,
            error: String(err),
          });
        }
        activeRuns.delete(task_id);
      }
      scheduler.cancel(task_id);
      taskStore.delete(task_id);
      return {
        isError: false,
        content: activeRun
          ? `Task '${meta.name}' (${task_id}) cancelled and aborted run ${activeRun.runId}.`
          : `Task '${meta.name}' (${task_id}) cancelled.`,
      };
    },
  };

  return [taskSchedule, taskList, taskResume, taskCancel];
}
