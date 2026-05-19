import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  abortAgentTurnViaKernel,
  executeAgentTurnViaKernel,
  getAgentTurnRunViaKernel,
  resumeAgentTurnViaKernel,
  waitForAgentTurnViaKernel,
} from '../../kernel-turn-executor.js';
import type { AgentRunner } from '../../runner.js';
import type { ScheduledTaskRecord, ScheduledTaskView } from './scheduler-task-meta.js';
import { createSchedulerTools } from './scheduler-tools.js';

vi.mock('../../kernel-turn-executor.js', () => ({
  abortAgentTurnViaKernel: vi.fn(async () => undefined),
  executeAgentTurnViaKernel: vi.fn(async () => ({ text: 'scheduled tool result' })),
  getAgentTurnRunViaKernel: vi.fn(async () => null),
  resumeAgentTurnViaKernel: vi.fn(async () => ({
    runId: 'resumed-run-id',
    processStatus: 'ready',
  })),
  waitForAgentTurnViaKernel: vi.fn(async () => ({ text: 'resumed scheduled tool result' })),
}));

const tempDirs: string[] = [];
const mockedAbortAgentTurnViaKernel = vi.mocked(abortAgentTurnViaKernel);
const mockedExecuteAgentTurnViaKernel = vi.mocked(executeAgentTurnViaKernel);
const mockedGetAgentTurnRunViaKernel = vi.mocked(getAgentTurnRunViaKernel);
const mockedResumeAgentTurnViaKernel = vi.mocked(resumeAgentTurnViaKernel);
const mockedWaitForAgentTurnViaKernel = vi.mocked(waitForAgentTurnViaKernel);

function resetExecuteMock(): void {
  mockedAbortAgentTurnViaKernel.mockReset();
  mockedAbortAgentTurnViaKernel.mockResolvedValue(undefined);
  mockedExecuteAgentTurnViaKernel.mockReset();
  mockedExecuteAgentTurnViaKernel.mockResolvedValue({ text: 'scheduled tool result' } as never);
  mockedGetAgentTurnRunViaKernel.mockReset();
  mockedGetAgentTurnRunViaKernel.mockResolvedValue(null);
  mockedResumeAgentTurnViaKernel.mockReset();
  mockedResumeAgentTurnViaKernel.mockResolvedValue({
    runId: 'resumed-run-id',
    processStatus: 'ready',
  } as never);
  mockedWaitForAgentTurnViaKernel.mockReset();
  mockedWaitForAgentTurnViaKernel.mockResolvedValue({
    text: 'resumed scheduled tool result',
  } as never);
}

resetExecuteMock();

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentflyer-scheduler-tools-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  resetExecuteMock();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class SchedulerStub {
  private readonly handlers = new Map<string, () => void | Promise<void>>();

  schedule(spec: {
    id?: string;
    expression: string;
    name: string;
    handler: () => void | Promise<void>;
  }) {
    if (!spec.id) {
      throw new Error('scheduler stub expects explicit task id');
    }
    this.handlers.set(spec.id, spec.handler);
    return {
      id: spec.id,
      name: spec.name,
      expression: spec.expression,
      createdAt: Date.now(),
      nextRunAt: 123456,
      stop() {
        return undefined;
      },
    };
  }

  cancel(id: string): boolean {
    return this.handlers.delete(id);
  }

  get(id: string) {
    if (!this.handlers.has(id)) {
      return undefined;
    }
    return {
      id,
      name: id,
      expression: '*/5 * * * *',
      createdAt: 0,
      nextRunAt: 123456,
      stop() {
        return undefined;
      },
    };
  }

  async run(id: string): Promise<void> {
    const handler = this.handlers.get(id);
    if (!handler) {
      throw new Error(`Scheduled handler not found: ${id}`);
    }
    await handler();
  }
}

function getToolHandler(name: string, dataDir: string, scheduler: SchedulerStub) {
  const tools = createSchedulerTools(
    new Map([
      ['agent-main', {} as AgentRunner],
      ['report-agent', {} as AgentRunner],
    ]),
    scheduler as never,
    dataDir,
  );
  const tool = tools.find((entry) => entry.definition.name === name);
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }
  return tool.handler;
}

async function readScheduledTasksFile(dataDir: string): Promise<Array<Record<string, unknown>>> {
  return JSON.parse(await readFile(join(dataDir, 'scheduled-tasks.json'), 'utf-8')) as Array<
    Record<string, unknown>
  >;
}

async function readTaskRunHistoryFile(dataDir: string): Promise<Array<Record<string, unknown>>> {
  return JSON.parse(await readFile(join(dataDir, 'task-run-history.json'), 'utf-8')) as Array<
    Record<string, unknown>
  >;
}

describe('createSchedulerTools persistence boundary', () => {
  it('strips legacy execution summary fields on startup', async () => {
    const dataDir = await createTempDir();
    await writeFile(
      join(dataDir, 'scheduled-tasks.json'),
      JSON.stringify(
        [
          {
            id: 'task-legacy',
            name: 'Legacy task',
            agentId: 'agent-main',
            message: 'hello',
            cronExpr: '*/5 * * * *',
            outputChannel: 'logs',
            createdAt: 1,
            enabled: true,
            runCount: 2,
            lastRunAt: 100,
            lastResult: 'legacy summary',
            latestDeliverableId: 'deliverable-1',
          } satisfies ScheduledTaskView,
        ],
        null,
        2,
      ),
      'utf-8',
    );

    getToolHandler('task_list', dataDir, new SchedulerStub());

    const persisted = await readScheduledTasksFile(dataDir);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.runCount).toBe(2);
    expect(persisted[0]).not.toHaveProperty('lastRunAt');
    expect(persisted[0]).not.toHaveProperty('lastResult');
    expect(persisted[0]).not.toHaveProperty('latestDeliverableId');
  });

  it('rebuilds task_list execution summary from task history', async () => {
    const dataDir = await createTempDir();
    await writeFile(
      join(dataDir, 'scheduled-tasks.json'),
      JSON.stringify(
        [
          {
            id: 'task-history',
            name: 'History-backed task',
            agentId: 'agent-main',
            message: 'hello',
            cronExpr: '*/5 * * * *',
            outputChannel: 'logs',
            createdAt: 1,
            enabled: true,
            runCount: 3,
          } satisfies ScheduledTaskRecord,
        ],
        null,
        2,
      ),
      'utf-8',
    );
    await writeFile(
      join(dataDir, 'task-run-history.json'),
      JSON.stringify(
        [
          {
            taskId: 'task-history',
            taskName: 'History-backed task',
            runKey: 'run-3',
            startedAt: 90,
            finishedAt: 120,
            ok: true,
            result: 'fresh result from history',
            agentId: 'agent-main',
          },
        ],
        null,
        2,
      ),
      'utf-8',
    );

    const taskList = getToolHandler('task_list', dataDir, new SchedulerStub());
    const listed = await taskList({});

    expect(listed.isError).toBe(false);
    expect(listed.content).toContain('runs: 3');
    expect(listed.content).toContain('fresh result from history');
    expect(listed.content).not.toContain('last: never');
  });

  it('keeps only runCount persisted after a task executes', async () => {
    const dataDir = await createTempDir();
    const scheduler = new SchedulerStub();
    const schedule = getToolHandler('task_schedule', dataDir, scheduler);
    const taskList = getToolHandler('task_list', dataDir, scheduler);

    const scheduled = await schedule({
      agent_id: 'agent-main',
      message: 'do work',
      name: 'Daily sync',
      interval_minutes: 5,
      report_to: 'report-agent',
    });
    expect(scheduled.isError).toBe(false);

    const taskId = /Task ID: (.+)/u.exec(scheduled.content)?.[1];
    expect(taskId).toBeTruthy();
    await scheduler.run(taskId ?? '');

    const persisted = await readScheduledTasksFile(dataDir);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.runCount).toBe(1);
    expect(persisted[0]).not.toHaveProperty('lastRunAt');
    expect(persisted[0]).not.toHaveProperty('lastResult');
    expect(persisted[0]).not.toHaveProperty('latestDeliverableId');

    const history = await readTaskRunHistoryFile(dataDir);
    expect(history).toHaveLength(1);
    expect(history[0]?.taskId).toBe(taskId);
    expect(history[0]?.ok).toBe(true);
    expect(history[0]?.result).toBe('scheduled tool result');
    expect(history[0]?.agentRunStatus).toBe('done');
    expect(typeof history[0]?.agentRunId).toBe('string');

    const listed = await taskList({});
    expect(listed.content).toContain('scheduled tool result');
    expect(listed.content).toContain('last agent run: done');
  });

  it('records failed runs in history and still increments runCount', async () => {
    mockedExecuteAgentTurnViaKernel.mockRejectedValueOnce(new Error('scheduler boom'));

    const dataDir = await createTempDir();
    const scheduler = new SchedulerStub();
    const schedule = getToolHandler('task_schedule', dataDir, scheduler);

    const scheduled = await schedule({
      agent_id: 'agent-main',
      message: 'do work',
      name: 'Failing sync',
      interval_minutes: 5,
    });
    expect(scheduled.isError).toBe(false);

    const taskId = /Task ID: (.+)/u.exec(scheduled.content)?.[1];
    expect(taskId).toBeTruthy();
    await scheduler.run(taskId ?? '');

    const persisted = await readScheduledTasksFile(dataDir);
    expect(persisted[0]?.runCount).toBe(1);
    expect(persisted[0]).not.toHaveProperty('lastRunAt');
    expect(persisted[0]).not.toHaveProperty('lastResult');

    const history = await readTaskRunHistoryFile(dataDir);
    expect(history).toHaveLength(1);
    expect(history[0]?.taskId).toBe(taskId);
    expect(history[0]?.ok).toBe(false);
    expect(history[0]?.result).toContain('Error: Error: scheduler boom');
    expect(history[0]?.agentRunStatus).toBe('error');
  });

  it('records suspended runs with delegated run metadata and surfaces them in task_list', async () => {
    mockedExecuteAgentTurnViaKernel.mockRejectedValueOnce(new Error('quota blocked'));
    mockedGetAgentTurnRunViaKernel.mockResolvedValueOnce({
      runId: 'agent-run-suspended',
      processStatus: 'suspended',
      phase: 'suspended',
      error: {
        code: 'AGENT_LLM_RESOURCE_BLOCKED',
        message:
          '模型服务的计费或配额状态异常，请检查 API Key、余额或项目配额。 当前运行已挂起，可在外部条件恢复后继续。',
        retryable: true,
      },
    } as never);

    const dataDir = await createTempDir();
    const scheduler = new SchedulerStub();
    const schedule = getToolHandler('task_schedule', dataDir, scheduler);
    const taskList = getToolHandler('task_list', dataDir, scheduler);

    const scheduled = await schedule({
      agent_id: 'agent-main',
      message: 'do blocked work',
      name: 'Suspended sync',
      interval_minutes: 5,
    });
    expect(scheduled.isError).toBe(false);

    const taskId = /Task ID: (.+)/u.exec(scheduled.content)?.[1];
    expect(taskId).toBeTruthy();
    await scheduler.run(taskId ?? '');

    const history = await readTaskRunHistoryFile(dataDir);
    expect(history).toHaveLength(1);
    expect(history[0]?.taskId).toBe(taskId);
    expect(history[0]?.ok).toBe(false);
    expect(typeof history[0]?.agentRunId).toBe('string');
    expect(history[0]?.agentRunStatus).toBe('suspended');
    expect(String(history[0]?.result)).toContain('当前运行已挂起');

    const listed = await taskList({});
    expect(listed.content).toContain('last agent run: suspended');
    expect(listed.content).toContain('current agent run: suspended');
    expect(listed.content).toContain(String(history[0]?.agentRunId));
  });

  it('refreshes task_list current run state from kernel while a delegated run is still in flight', async () => {
    let rejectExecution: ((error: Error) => void) | undefined;
    const executionStarted = new Promise<void>((resolve) => {
      mockedExecuteAgentTurnViaKernel.mockImplementationOnce(
        async () =>
          await new Promise((_resolve, reject: (error: Error) => void) => {
            rejectExecution = reject;
            resolve();
          }),
      );
    });
    mockedGetAgentTurnRunViaKernel.mockImplementation(
      async ({ runId }) =>
        ({
          runId,
          processStatus: 'suspended',
          phase: 'suspended',
          error: {
            code: 'AGENT_LLM_RESOURCE_BLOCKED',
            message: '当前运行已挂起，可在外部条件恢复后继续。',
            retryable: true,
          },
        }) as never,
    );

    const dataDir = await createTempDir();
    const scheduler = new SchedulerStub();
    const schedule = getToolHandler('task_schedule', dataDir, scheduler);
    const taskList = getToolHandler('task_list', dataDir, scheduler);

    const scheduled = await schedule({
      agent_id: 'agent-main',
      message: 'do blocked work',
      name: 'Live refresh sync',
      interval_minutes: 5,
    });
    const taskId = /Task ID: (.+)/u.exec(scheduled.content)?.[1];
    expect(taskId).toBeTruthy();

    const runningPromise = scheduler.run(taskId ?? '');
    await executionStarted;
    const delegatedRunId = String(
      mockedExecuteAgentTurnViaKernel.mock.calls.at(-1)?.[0].input.runId,
    );

    const listedWhileRunning = await taskList({});
    expect(listedWhileRunning.isError).toBe(false);
    expect(listedWhileRunning.content).toContain('current agent run: suspended');
    expect(listedWhileRunning.content).toContain(delegatedRunId);

    rejectExecution?.(new Error('quota blocked'));
    await runningPromise;
  });

  it('skips new cron executions while a suspended delegated run is still active', async () => {
    mockedExecuteAgentTurnViaKernel.mockRejectedValueOnce(new Error('quota blocked'));
    mockedGetAgentTurnRunViaKernel.mockResolvedValueOnce({
      runId: 'ignored-suspended-run-id',
      processStatus: 'suspended',
      phase: 'suspended',
      error: {
        code: 'AGENT_LLM_RESOURCE_BLOCKED',
        message: '当前运行已挂起，可在外部条件恢复后继续。',
        retryable: true,
      },
    } as never);

    const dataDir = await createTempDir();
    const scheduler = new SchedulerStub();
    const schedule = getToolHandler('task_schedule', dataDir, scheduler);

    const scheduled = await schedule({
      agent_id: 'agent-main',
      message: 'do blocked work',
      name: 'No overlap while suspended',
      interval_minutes: 5,
    });
    const taskId = /Task ID: (.+)/u.exec(scheduled.content)?.[1];
    expect(taskId).toBeTruthy();

    await scheduler.run(taskId ?? '');
    await scheduler.run(taskId ?? '');

    expect(mockedExecuteAgentTurnViaKernel).toHaveBeenCalledTimes(1);
    const persisted = await readScheduledTasksFile(dataDir);
    expect(persisted[0]?.runCount).toBe(1);

    const history = await readTaskRunHistoryFile(dataDir);
    expect(history).toHaveLength(1);
    expect(history[0]?.agentRunStatus).toBe('suspended');
  });

  it('task_resume resumes a suspended run without incrementing runCount twice', async () => {
    mockedExecuteAgentTurnViaKernel.mockRejectedValueOnce(new Error('quota blocked'));
    mockedGetAgentTurnRunViaKernel.mockResolvedValueOnce({
      runId: 'ignored-suspended-run-id',
      processStatus: 'suspended',
      phase: 'suspended',
      error: {
        code: 'AGENT_LLM_RESOURCE_BLOCKED',
        message: '当前运行已挂起，可在外部条件恢复后继续。',
        retryable: true,
      },
    } as never);
    mockedResumeAgentTurnViaKernel.mockResolvedValueOnce({
      runId: 'resumed-run-id',
      processStatus: 'ready',
    } as never);
    mockedWaitForAgentTurnViaKernel.mockResolvedValueOnce({
      text: 'quota recovered',
    } as never);

    const dataDir = await createTempDir();
    const scheduler = new SchedulerStub();
    const schedule = getToolHandler('task_schedule', dataDir, scheduler);
    const taskResume = getToolHandler('task_resume', dataDir, scheduler);
    const taskList = getToolHandler('task_list', dataDir, scheduler);

    const scheduled = await schedule({
      agent_id: 'agent-main',
      message: 'do blocked work',
      name: 'Recover suspended run',
      interval_minutes: 5,
    });
    const taskId = /Task ID: (.+)/u.exec(scheduled.content)?.[1];
    expect(taskId).toBeTruthy();

    await scheduler.run(taskId ?? '');
    const suspendedHistory = await readTaskRunHistoryFile(dataDir);
    const delegatedRunId = String(suspendedHistory[0]?.agentRunId);

    const resumed = await taskResume({ task_id: taskId });
    expect(resumed.isError).toBe(false);
    expect(resumed.content).toContain('resumed and completed');
    expect(resumed.content).toContain(delegatedRunId);
    expect(mockedResumeAgentTurnViaKernel).toHaveBeenCalledWith(
      expect.objectContaining({
        dataDir,
        runId: delegatedRunId,
      }),
    );
    expect(mockedWaitForAgentTurnViaKernel).toHaveBeenCalledWith(
      expect.objectContaining({
        dataDir,
        runId: delegatedRunId,
      }),
    );

    const persisted = await readScheduledTasksFile(dataDir);
    expect(persisted[0]?.runCount).toBe(1);

    const history = await readTaskRunHistoryFile(dataDir);
    expect(history).toHaveLength(2);
    const suspendedRecord = history.find((entry) => entry.agentRunStatus === 'suspended');
    const doneRecord = history.find((entry) => entry.agentRunStatus === 'done');
    expect(suspendedRecord?.agentRunId).toBe(delegatedRunId);
    expect(doneRecord?.agentRunId).toBe(delegatedRunId);
    expect(doneRecord?.result).toBe('quota recovered');

    const listed = await taskList({});
    expect(listed.content).not.toContain('current agent run:');
    expect(listed.content).toContain('last agent run: done');
    expect(listed.content).toContain('quota recovered');
  });

  it('task_cancel aborts the current suspended delegated run before removing the task', async () => {
    mockedExecuteAgentTurnViaKernel.mockRejectedValueOnce(new Error('quota blocked'));
    mockedGetAgentTurnRunViaKernel.mockResolvedValueOnce({
      runId: 'ignored-by-scheduler-generated-run-id',
      processStatus: 'suspended',
      phase: 'suspended',
      error: {
        code: 'AGENT_LLM_RESOURCE_BLOCKED',
        message: '当前运行已挂起，可在外部条件恢复后继续。',
        retryable: true,
      },
    } as never);

    const dataDir = await createTempDir();
    const scheduler = new SchedulerStub();
    const schedule = getToolHandler('task_schedule', dataDir, scheduler);
    const taskCancel = getToolHandler('task_cancel', dataDir, scheduler);

    const scheduled = await schedule({
      agent_id: 'agent-main',
      message: 'do blocked work',
      name: 'Cancelable suspended sync',
      interval_minutes: 5,
    });
    const taskId = /Task ID: (.+)/u.exec(scheduled.content)?.[1];
    expect(taskId).toBeTruthy();

    await scheduler.run(taskId ?? '');
    const history = await readTaskRunHistoryFile(dataDir);
    const delegatedRunId = String(history[0]?.agentRunId);

    const cancelled = await taskCancel({ task_id: taskId });
    expect(cancelled.isError).toBe(false);
    expect(cancelled.content).toContain(`aborted run ${delegatedRunId}`);
    expect(mockedAbortAgentTurnViaKernel).toHaveBeenCalledWith(
      expect.objectContaining({
        dataDir,
        runId: delegatedRunId,
        message: expect.stringContaining('cancelled'),
      }),
    );

    const persisted = await readScheduledTasksFile(dataDir);
    expect(persisted).toHaveLength(0);
  });
});
