import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunner } from '../agent/runner.js';
import { DeliverableStore } from './deliverables.js';
import type { RpcContext } from './rpc.js';
import {
  type WorkflowDef,
  type WorkflowRunRecord,
  dispatchWorkflowRpc,
  getWorkflowKernelService,
} from './workflow-backend.js';

vi.mock('../agent/kernel-turn-executor.js', () => ({
  executeAgentTurnViaKernel: vi.fn(async () => {
    throw new Error('quota blocked');
  }),
  getAgentTurnRunViaKernel: vi.fn(async ({ runId }: { runId: string }) => ({
    runId,
    processStatus: 'suspended',
    phase: 'suspended',
    error: {
      code: 'AGENT_LLM_RESOURCE_BLOCKED',
      message: 'quota blocked',
      retryable: true,
    },
  })),
  resumeAgentTurnViaKernel: vi.fn(async ({ runId }: { runId: string }) => ({
    runId,
    processStatus: 'ready',
  })),
  waitForAgentTurnViaKernel: vi.fn(async () => ({ text: 'reply:recovered' })),
}));

const tempDirs: string[] = [];
const services: Array<Promise<import('./workflow-kernel.js').WorkflowKernelService>> = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentflyer-workflow-backend-resume-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    services.splice(0).map(async (servicePromise) => {
      const service = await servicePromise;
      await service.dispose();
    }),
  );
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createWorkflow(): WorkflowDef {
  return {
    id: 'wf-rpc-resume',
    name: 'RPC Resume Workflow',
    steps: [
      {
        id: 'agent-step',
        type: 'agent',
        agentId: 'agent-main',
        messageTemplate: 'hello {{input}}',
        condition: 'on_success',
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
}

function createRpcContext(dataDir: string): RpcContext {
  return {
    runners: new Map([['agent-main', {} as AgentRunner]]),
    gatewayVersion: 'test',
    startedAt: 0,
    dataDir,
    getConfig: () => ({}) as never,
    saveAndReload: async () => ({ reloaded: [] }),
    scheduler: {} as never,
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
    deliverableStore: new DeliverableStore(dataDir),
    channels: new Map(),
    getMcpStatus: () => [],
    runningTasks: new Map(),
  };
}

async function writeWorkflows(dataDir: string, workflows: WorkflowDef[]): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'workflows.json'), JSON.stringify(workflows, null, 2), 'utf-8');
}

async function waitForWorkflowStatus(
  ctx: RpcContext,
  runId: string,
  status: WorkflowRunRecord['status'],
): Promise<WorkflowRunRecord> {
  const deadline = Date.now() + 2_000;
  let lastSeen: WorkflowRunRecord | null = null;
  while (Date.now() < deadline) {
    const response = await dispatchWorkflowRpc('workflow.runStatus', 200, { runId }, ctx);
    const run = (response.result as WorkflowRunRecord | null) ?? null;
    lastSeen = run;
    if (run?.status === status) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for workflow ${runId} to reach status ${status}; last=${JSON.stringify(lastSeen)}`,
  );
}

describe('workflow backend resume rpc', () => {
  it('resumes a suspended workflow through workflow.resume', async () => {
    const dataDir = await createTempDir();
    const workflow = createWorkflow();
    await writeWorkflows(dataDir, [workflow]);
    const ctx = createRpcContext(dataDir);
    services.push(getWorkflowKernelService(ctx));

    const started = await dispatchWorkflowRpc(
      'workflow.run',
      1,
      { workflowId: workflow.id, input: 'world' },
      ctx,
    );
    const runId = (started.result as { runId: string }).runId;

    const suspended = await waitForWorkflowStatus(ctx, runId, 'suspended');
    expect(suspended.stepResults[0]?.delegatedRunStatus).toBe('suspended');
    const delegatedRunId = suspended.stepResults[0]?.delegatedRunId;
    expect(delegatedRunId).toBeTruthy();

    const resumed = await dispatchWorkflowRpc(
      'workflow.resume',
      2,
      { runId, childStepId: 'agent-step' },
      ctx,
    );
    expect(resumed.result).toMatchObject({
      action: 'resume',
      accepted: true,
      sourceRunId: runId,
      resultRunId: runId,
      targetScope: 'step',
      targetStepId: 'agent-step',
      targetChildStepId: 'agent-step',
      resumed: true,
      runId,
      childStepId: 'agent-step',
      status: 'running',
    });

    const statusResponse = await dispatchWorkflowRpc('workflow.runStatus', 3, { runId }, ctx);
    const completed = statusResponse.result as WorkflowRunRecord;
    expect(['running', 'done']).toContain(completed.status);
    expect(completed.stepResults[0]?.delegatedRunId).toBe(delegatedRunId);
  });

  it('cancels a suspended workflow through workflow.cancel', async () => {
    const dataDir = await createTempDir();
    const workflow = createWorkflow();
    await writeWorkflows(dataDir, [workflow]);
    const ctx = createRpcContext(dataDir);
    services.push(getWorkflowKernelService(ctx));

    const started = await dispatchWorkflowRpc(
      'workflow.run',
      10,
      { workflowId: workflow.id, input: 'world' },
      ctx,
    );
    const runId = (started.result as { runId: string }).runId;

    await waitForWorkflowStatus(ctx, runId, 'suspended');

    const cancelled = await dispatchWorkflowRpc(
      'workflow.cancel',
      11,
      { runId, childStepId: 'agent-step' },
      ctx,
    );
    expect(cancelled.result).toMatchObject({
      action: 'cancel',
      accepted: true,
      sourceRunId: runId,
      resultRunId: runId,
      targetScope: 'step',
      targetStepId: 'agent-step',
      targetChildStepId: 'agent-step',
      cancelled: true,
      runId,
      childStepId: 'agent-step',
      status: 'cancelled',
    });

    const cancelledRun = await waitForWorkflowStatus(ctx, runId, 'cancelled');
    expect(cancelledRun.status).toBe('cancelled');
  });
});
