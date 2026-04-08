import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeAgentTurnViaKernel } from '../../kernel-turn-executor.js';
import type { AgentRunner } from '../../runner.js';
import type { ScheduledTaskRecord, ScheduledTaskView } from './scheduler-task-meta.js';
import { createSchedulerTools } from './scheduler-tools.js';

vi.mock('../../kernel-turn-executor.js', () => ({
  executeAgentTurnViaKernel: vi.fn(async () => ({ text: 'scheduled tool result' })),
}));

const tempDirs: string[] = [];
const mockedExecuteAgentTurnViaKernel = vi.mocked(executeAgentTurnViaKernel);

function resetExecuteMock(): void {
  mockedExecuteAgentTurnViaKernel.mockReset();
  mockedExecuteAgentTurnViaKernel.mockResolvedValue({ text: 'scheduled tool result' } as never);
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

    const listed = await taskList({});
    expect(listed.content).toContain('scheduled tool result');
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
  });
});
