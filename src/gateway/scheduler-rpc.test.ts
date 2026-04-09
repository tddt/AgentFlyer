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
    refreshMcp: async () => ({ reloaded: [], refreshed: [] }),
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
    getMcpStatus: () => [],
    runningTasks: new Map(),
  };
}

function createRpcContextWithConfig(
  dataDir: string,
  config: { agents?: Array<{ id: string; tools?: { sandboxProfile?: string } }> },
  nextRunAt?: number,
  overrides: Partial<RpcContext> = {},
): RpcContext {
  return {
    ...createRpcContext(dataDir, nextRunAt),
    getConfig: () => config as never,
    ...overrides,
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

async function writeMcpHistoryFile(
  dataDir: string,
  records: Array<Record<string, unknown>>,
): Promise<void> {
  await writeFile(
    join(dataDir, 'mcp-server-history.json'),
    JSON.stringify(records, null, 2),
    'utf-8',
  );
}

async function writeWorkflowsFile(
  dataDir: string,
  workflows: Array<Record<string, unknown>>,
): Promise<void> {
  await writeFile(join(dataDir, 'workflows.json'), JSON.stringify(workflows, null, 2), 'utf-8');
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

  it('returns filtered MCP history with the newest records first', async () => {
    const dataDir = await createTempDir();
    await writeMcpHistoryFile(dataDir, [
      {
        serverId: 'filesystem',
        transport: 'sse',
        trigger: 'auto-retry',
        outcome: 'connected',
        timestamp: 300,
        toolPrefix: 'mcp_filesystem',
        approval: 'inherit',
        timeoutMs: 20_000,
        toolCount: 2,
      },
      {
        serverId: 'github',
        transport: 'stdio',
        trigger: 'manual-refresh',
        outcome: 'error',
        timestamp: 200,
        toolPrefix: 'mcp_github',
        approval: 'inherit',
        timeoutMs: 20_000,
        toolCount: 0,
        lastError: 'command missing',
        lastErrorCode: 'STDIO_COMMAND_MISSING',
        lastErrorPhase: 'config',
      },
      {
        serverId: 'filesystem',
        transport: 'sse',
        trigger: 'startup',
        outcome: 'error',
        timestamp: 100,
        toolPrefix: 'mcp_filesystem',
        approval: 'inherit',
        timeoutMs: 20_000,
        toolCount: 0,
        lastError: 'connect failed',
        lastErrorCode: 'SSE_CONNECT_HTTP',
        lastErrorPhase: 'connect',
      },
    ]);

    const response = await dispatchRpc(
      {
        id: 5,
        method: 'mcp.history',
        params: { serverId: 'filesystem', limit: 1 },
      },
      createRpcContext(dataDir),
    );

    expect(response.error).toBeUndefined();
    const records = (response.result as { records: Array<Record<string, unknown>> }).records;
    expect(records).toEqual([
      expect.objectContaining({
        serverId: 'filesystem',
        trigger: 'auto-retry',
        outcome: 'connected',
        timestamp: 300,
      }),
    ]);
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

  it('returns workflow advisory for workflow-targeted scheduled tasks', async () => {
    const dataDir = await createTempDir();
    await writeScheduledTasksFile(dataDir, [
      {
        id: 'task-workflow',
        name: 'Workflow task',
        workflowId: 'wf-unsafe',
        message: 'hello',
        cronExpr: '0 * * * *',
        outputChannel: 'logs',
        createdAt: 1,
        enabled: true,
        runCount: 0,
      },
    ]);
    await writeWorkflowsFile(dataDir, [
      {
        id: 'wf-unsafe',
        name: 'Unsafe workflow',
        steps: [
          {
            id: 'draft-step',
            type: 'agent',
            agentId: 'agent-main',
            messageTemplate: 'draft',
            condition: 'on_success',
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const response = await dispatchRpc(
      { id: 6, method: 'scheduler.list' },
      createRpcContextWithConfig(dataDir, {
        agents: [
          { id: 'agent-main', tools: {} },
          { id: 'agent-safe', tools: { sandboxProfile: 'readonly-output' } },
        ],
      }),
    );

    const tasks = (response.result as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(tasks[0]?.advisory).toEqual({
      kind: 'workflow-advisory',
      message:
        "agent step 'draft-step' targets 'agent-main' without sandboxProfile. Consider using 'agent-safe' (sandbox:readonly-output) for readonly execution.",
    });
  });

  it('merges MCP advisory into scheduler task views when runtime is degraded', async () => {
    const dataDir = await createTempDir();
    await writeScheduledTasksFile(dataDir, [
      {
        id: 'task-mcp-advisory',
        name: 'MCP task',
        agentId: 'agent-main',
        message: 'hello',
        cronExpr: '0 * * * *',
        outputChannel: 'logs',
        createdAt: 1,
        enabled: true,
        runCount: 0,
      },
    ]);
    await writeMcpHistoryFile(dataDir, [
      {
        serverId: 'github',
        transport: 'stdio',
        trigger: 'startup',
        outcome: 'error',
        timestamp: 300,
        toolPrefix: 'mcp_github',
        approval: 'inherit',
        timeoutMs: 20_000,
        toolCount: 0,
        lastErrorCode: 'STDIO_COMMAND_MISSING',
        autoRetryEligible: false,
      },
    ]);

    const response = await dispatchRpc(
      { id: 6.5, method: 'scheduler.list' },
      createRpcContextWithConfig(
        dataDir,
        {
          agents: [{ id: 'agent-main', tools: {} }],
        },
        undefined,
        {
          getMcpStatus: () => [
            {
              serverId: 'github',
              transport: 'stdio',
              enabled: true,
              toolPrefix: 'mcp_github',
              approval: 'inherit',
              timeoutMs: 20_000,
              status: 'error',
              toolCount: 0,
              tools: [],
              lastErrorCode: 'STDIO_COMMAND_MISSING',
              autoRetryEligible: false,
              retryCount: 1,
            },
          ],
        },
      ),
    );

    const tasks = (response.result as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(tasks[0]?.advisory).toEqual({
      kind: 'sandbox-advisory',
      message:
        'scheduled task targets an agent without sandboxProfile. Consider binding readonly-output or another sandbox profile before unattended execution.',
      details: [
        'scheduled task targets an agent without sandboxProfile. Consider binding readonly-output or another sandbox profile before unattended execution.',
        'MCP runtime is degraded: github needs manual fix (STDIO_COMMAND_MISSING). Automation that depends on MCP tools may stall or fail until recovery.',
      ],
    });
  });

  it('returns MCP server runtime status snapshots', async () => {
    const dataDir = await createTempDir();
    await writeMcpHistoryFile(dataDir, [
      {
        serverId: 'github',
        transport: 'stdio',
        trigger: 'startup',
        outcome: 'connected',
        timestamp: 300,
        toolPrefix: 'mcp_github',
        approval: 'inherit',
        timeoutMs: 20_000,
        toolCount: 2,
      },
      {
        serverId: 'filesystem',
        transport: 'sse',
        trigger: 'manual-refresh',
        outcome: 'error',
        timestamp: 200,
        toolPrefix: 'mcp_filesystem',
        approval: 'always',
        timeoutMs: 10_000,
        toolCount: 0,
        lastErrorCode: 'SSE_CONNECT_HTTP',
        lastErrorPhase: 'connect',
        autoRetryEligible: true,
      },
      {
        serverId: 'filesystem',
        transport: 'sse',
        trigger: 'startup',
        outcome: 'error',
        timestamp: 100,
        toolPrefix: 'mcp_filesystem',
        approval: 'always',
        timeoutMs: 10_000,
        toolCount: 0,
        lastErrorCode: 'SSE_CONNECT_HTTP',
        lastErrorPhase: 'connect',
        autoRetryEligible: true,
      },
    ]);
    const response = await dispatchRpc(
      { id: 7, method: 'mcp.status' },
      {
        ...createRpcContext(dataDir),
        getMcpStatus: () => [
          {
            serverId: 'github',
            transport: 'stdio',
            enabled: true,
            toolPrefix: 'mcp_github',
            approval: 'inherit',
            timeoutMs: 20_000,
            status: 'connected',
            toolCount: 2,
            tools: ['mcp_github_get_issue', 'mcp_github_search_repo'],
          },
          {
            serverId: 'filesystem',
            transport: 'sse',
            enabled: true,
            toolPrefix: 'mcp_filesystem',
            approval: 'always',
            timeoutMs: 10_000,
            status: 'error',
            toolCount: 0,
            tools: [],
            lastErrorCode: 'SSE_CONNECT_HTTP',
            lastErrorPhase: 'connect',
            lastError: 'Unsupported MCP transport: sse',
          },
        ],
      },
    );

    expect(response.result).toEqual({
      servers: [
        {
          serverId: 'github',
          transport: 'stdio',
          enabled: true,
          toolPrefix: 'mcp_github',
          approval: 'inherit',
          timeoutMs: 20_000,
          status: 'connected',
          toolCount: 2,
          tools: ['mcp_github_get_issue', 'mcp_github_search_repo'],
        },
        {
          serverId: 'filesystem',
          transport: 'sse',
          enabled: true,
          toolPrefix: 'mcp_filesystem',
          approval: 'always',
          timeoutMs: 10_000,
          status: 'error',
          toolCount: 0,
          tools: [],
          lastErrorCode: 'SSE_CONNECT_HTTP',
          lastErrorPhase: 'connect',
          lastError: 'Unsupported MCP transport: sse',
        },
      ],
      summaries: [
        {
          serverId: 'github',
          transport: 'stdio',
          totalEvents: 1,
          connectedEvents: 1,
          errorEvents: 0,
          disabledEvents: 0,
          recentAttempts: 1,
          recentConnectedEvents: 1,
          recentSuccessRate: 1,
          consecutiveErrors: 0,
          autoRetryRecoveryCount: 0,
          manualFixErrorCount: 0,
          lastOutcome: 'connected',
          lastTrigger: 'startup',
          lastEventAt: 300,
          lastRecoveryAt: 300,
          lastFailureAt: undefined,
          lastErrorCode: undefined,
        },
        {
          serverId: 'filesystem',
          transport: 'sse',
          totalEvents: 2,
          connectedEvents: 0,
          errorEvents: 2,
          disabledEvents: 0,
          recentAttempts: 2,
          recentConnectedEvents: 0,
          recentSuccessRate: 0,
          consecutiveErrors: 2,
          autoRetryRecoveryCount: 0,
          manualFixErrorCount: 0,
          lastOutcome: 'error',
          lastTrigger: 'manual-refresh',
          lastEventAt: 200,
          lastRecoveryAt: undefined,
          lastFailureAt: 200,
          lastErrorCode: 'SSE_CONNECT_HTTP',
        },
      ],
      attention: [
        {
          serverId: 'filesystem',
          severity: 'warning',
          state: 'recovering',
          message: "MCP server 'filesystem' is still auto-retrying after 2 recent failures.",
          lastErrorCode: 'SSE_CONNECT_HTTP',
          retryCount: undefined,
          nextRetryAt: undefined,
        },
      ],
    });
  });

  it('refreshes MCP runtime through the dedicated MCP seam', async () => {
    const dataDir = await createTempDir();
    let refreshedServerId: string | undefined;

    const response = await dispatchRpc(
      { id: 8, method: 'mcp.refresh', params: { serverId: 'github' } },
      {
        ...createRpcContext(dataDir),
        refreshMcp: async (serverId) => {
          refreshedServerId = serverId;
          return { reloaded: ['agent-main'], refreshed: ['github'] };
        },
        getMcpStatus: () => [
          {
            serverId: 'github',
            transport: 'stdio',
            enabled: true,
            toolPrefix: 'mcp_github',
            approval: 'inherit',
            timeoutMs: 20_000,
            status: 'connected',
            toolCount: 1,
            tools: ['mcp_github_search_repo'],
          },
        ],
      },
    );

    expect(refreshedServerId).toBe('github');
    expect(response.result).toEqual({
      reloaded: ['agent-main'],
      refreshed: ['github'],
      servers: [
        {
          serverId: 'github',
          transport: 'stdio',
          enabled: true,
          toolPrefix: 'mcp_github',
          approval: 'inherit',
          timeoutMs: 20_000,
          status: 'connected',
          toolCount: 1,
          tools: ['mcp_github_search_repo'],
        },
      ],
    });
  });
});
