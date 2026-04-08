import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunner } from '../agent/runner.js';
import type { ScheduledTaskView } from '../agent/tools/builtin/scheduler-task-meta.js';
import type { CronScheduler } from '../scheduler/cron.js';
import type { RpcContext } from './rpc.js';
import { dispatchRpc } from './rpc.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentflyer-scheduler-rpc-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createSchedulerStub(nextRunAt?: number): CronScheduler {
  return {
    get(id: string) {
      return nextRunAt ? ({ id, nextRunAt } as ReturnType<CronScheduler['get']>) : undefined;
    },
    cancel() {
      return true;
    },
    schedule() {
      return undefined;
    },
  } as unknown as CronScheduler;
}

function createRpcContext(dataDir: string, nextRunAt?: number): RpcContext {
  return {
    runners: new Map([['agent-main', {} as AgentRunner]]),
    gatewayVersion: 'test',
    startedAt: 0,
    dataDir,
    getConfig: () => ({}) as never,
    saveAndReload: async () => ({ reloaded: [] }),
    scheduler: createSchedulerStub(nextRunAt),
    shutdown: async () => undefined,
    reload: async () => ({ reloaded: [] }),
    listSkills: () => [],
    sessionStore: {} as never,
    metaStore: {} as never,
    contentStore: {
      async list() {
        return [];
      },
    } as never,
    deliverableStore: {} as never,
    channels: new Map(),
    runningTasks: new Map(),
  };
}

function createRpcContextWithConfig(
  dataDir: string,
  config: { agents?: Array<{ id: string; tools?: { sandboxProfile?: string } }> },
  nextRunAt?: number,
): RpcContext {
  return {
    ...createRpcContext(dataDir, nextRunAt),
    getConfig: () => config as never,
  };
}

async function writeScheduledTasksFile(dataDir: string, tasks: ScheduledTaskView[]): Promise<void> {
  await writeFile(join(dataDir, 'scheduled-tasks.json'), JSON.stringify(tasks, null, 2), 'utf-8');
}

async function readScheduledTasksFile(dataDir: string): Promise<Array<Record<string, unknown>>> {
  return JSON.parse(await readFile(join(dataDir, 'scheduled-tasks.json'), 'utf-8')) as Array<
    Record<string, unknown>
  >;
}

async function writeTaskRunHistoryFile(
  dataDir: string,
  records: Array<Record<string, unknown>>,
): Promise<void> {
  await writeFile(
    join(dataDir, 'task-run-history.json'),
    JSON.stringify(records, null, 2),
    'utf-8',
  );
}

describe('scheduler RPC summaries', () => {
  it('derives latest execution summary from task history instead of stale task metadata', async () => {
    const dataDir = await createTempDir();
    await writeScheduledTasksFile(dataDir, [
      {
        id: 'task-1',
        name: 'Daily digest',
        agentId: 'agent-main',
        message: 'hello',
        cronExpr: '0 * * * *',
        outputChannel: 'logs',
        createdAt: 1,
        enabled: true,
        runCount: 3,
        lastRunAt: 10,
        lastResult: 'stale result',
        latestDeliverableId: 'deliverable-stale',
      },
    ]);
    await writeTaskRunHistoryFile(dataDir, [
      {
        taskId: 'task-1',
        taskName: 'Daily digest',
        runKey: 'run-2',
        startedAt: 90,
        finishedAt: 120,
        ok: true,
        result: 'fresh result from history',
        agentId: 'agent-main',
        deliverableId: 'deliverable-fresh',
      },
    ]);

    const response = await dispatchRpc(
      { id: 1, method: 'scheduler.list' },
      createRpcContext(dataDir, 456),
    );
    const tasks = (response.result as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.lastRunAt).toBe(120);
    expect(tasks[0]?.lastResult).toBe('fresh result from history');
    expect(tasks[0]?.latestDeliverableId).toBe('deliverable-fresh');
    expect(tasks[0]?.nextRunAt).toBe(456);
    expect(tasks[0]?.runCount).toBe(3);
  });

  it('strips stale execution summary fields when rewriting scheduled tasks', async () => {
    const dataDir = await createTempDir();
    await writeScheduledTasksFile(dataDir, [
      {
        id: 'task-1',
        name: 'Old task',
        agentId: 'agent-main',
        message: 'hello',
        cronExpr: '0 * * * *',
        outputChannel: 'logs',
        createdAt: 1,
        enabled: true,
        runCount: 2,
        lastRunAt: 10,
        lastResult: 'stale result',
        latestDeliverableId: 'deliverable-stale',
      },
    ]);

    const response = await dispatchRpc(
      {
        id: 2,
        method: 'scheduler.update',
        params: {
          taskId: 'task-1',
          name: 'Renamed task',
        },
      },
      createRpcContext(dataDir),
    );

    expect(response.error).toBeUndefined();
    const persisted = await readScheduledTasksFile(dataDir);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.name).toBe('Renamed task');
    expect(persisted[0]).not.toHaveProperty('lastRunAt');
    expect(persisted[0]).not.toHaveProperty('lastResult');
    expect(persisted[0]).not.toHaveProperty('latestDeliverableId');
  });

  it('returns sandbox advisory for scheduled tasks that target unprofiled agents', async () => {
    const dataDir = await createTempDir();
    await writeScheduledTasksFile(dataDir, [
      {
        id: 'task-unsafe',
        name: 'Unsafe task',
        agentId: 'agent-main',
        message: 'hello',
        cronExpr: '0 * * * *',
        outputChannel: 'logs',
        createdAt: 1,
        enabled: true,
        runCount: 1,
      },
    ]);

    const response = await dispatchRpc(
      { id: 3, method: 'scheduler.list' },
      createRpcContextWithConfig(
        dataDir,
        {
          agents: [
            { id: 'agent-main', tools: {} },
            { id: 'agent-safe', tools: { sandboxProfile: 'readonly-output' } },
          ],
        },
        456,
      ),
    );

    const tasks = (response.result as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(tasks[0]?.advisory).toEqual({
      kind: 'sandbox-advisory',
      message:
        "scheduled task targets 'agent-main' without sandboxProfile. Prefer 'agent-safe' (sandbox:readonly-output) for unattended execution.",
      recommendedAgentId: 'agent-safe',
      recommendedSandboxProfile: 'readonly-output',
    });
  });

  it('returns sandbox advisory from scheduler.create without blocking task creation', async () => {
    const dataDir = await createTempDir();

    const response = await dispatchRpc(
      {
        id: 4,
        method: 'scheduler.create',
        params: {
          name: 'Create with advisory',
          agentId: 'agent-main',
          message: 'hello',
          cronExpr: '0 * * * *',
        },
      },
      createRpcContextWithConfig(dataDir, {
        agents: [
          { id: 'agent-main', tools: {} },
          { id: 'agent-safe', tools: { sandboxProfile: 'readonly-output' } },
        ],
      }),
    );

    expect(response.error).toBeUndefined();
    expect((response.result as { task: Record<string, unknown> }).task.advisory).toEqual({
      kind: 'sandbox-advisory',
      message:
        "scheduled task targets 'agent-main' without sandboxProfile. Prefer 'agent-safe' (sandbox:readonly-output) for unattended execution.",
      recommendedAgentId: 'agent-safe',
      recommendedSandboxProfile: 'readonly-output',
    });
  });

  it('returns sandbox advisory from scheduler.update when retargeting to an unsafe agent', async () => {
    const dataDir = await createTempDir();
    await writeScheduledTasksFile(dataDir, [
      {
        id: 'task-update',
        name: 'Retarget me',
        agentId: 'agent-safe',
        message: 'hello',
        cronExpr: '0 * * * *',
        outputChannel: 'logs',
        createdAt: 1,
        enabled: true,
        runCount: 0,
      },
    ]);

    const response = await dispatchRpc(
      {
        id: 5,
        method: 'scheduler.update',
        params: {
          taskId: 'task-update',
          agentId: 'agent-main',
        },
      },
      createRpcContextWithConfig(dataDir, {
        agents: [
          { id: 'agent-main', tools: {} },
          { id: 'agent-safe', tools: { sandboxProfile: 'readonly-output' } },
        ],
      }),
    );

    expect(response.error).toBeUndefined();
    expect((response.result as { task: Record<string, unknown> }).task.advisory).toEqual({
      kind: 'sandbox-advisory',
      message:
        "scheduled task targets 'agent-main' without sandboxProfile. Prefer 'agent-safe' (sandbox:readonly-output) for unattended execution.",
      recommendedAgentId: 'agent-safe',
      recommendedSandboxProfile: 'readonly-output',
    });
  });
});
