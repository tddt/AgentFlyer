import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunner } from '../agent/runner.js';
import {
  executeAgentTurnViaKernel,
  getAgentTurnRunViaKernel,
  resumeAgentTurnViaKernel,
  waitForAgentTurnViaKernel,
} from '../agent/kernel-turn-executor.js';
import type { WorkflowDef, WorkflowRunRecord } from './workflow-backend.js';
import { WorkflowKernelService } from './workflow-kernel.js';

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
const mockedExecuteAgentTurnViaKernel = vi.mocked(executeAgentTurnViaKernel);
const mockedGetAgentTurnRunViaKernel = vi.mocked(getAgentTurnRunViaKernel);
const mockedResumeAgentTurnViaKernel = vi.mocked(resumeAgentTurnViaKernel);
const mockedWaitForAgentTurnViaKernel = vi.mocked(waitForAgentTurnViaKernel);

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentflyer-workflow-kernel-suspend-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  mockedExecuteAgentTurnViaKernel.mockClear();
  mockedGetAgentTurnRunViaKernel.mockClear();
  mockedResumeAgentTurnViaKernel.mockClear();
  mockedWaitForAgentTurnViaKernel.mockClear();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createWorkflow(): WorkflowDef {
  return {
    id: 'wf-kernel-suspend',
    name: 'Kernel Workflow Suspend',
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

async function waitForStatus(
  service: WorkflowKernelService,
  runId: string,
  status: WorkflowRunRecord['status'],
): Promise<WorkflowRunRecord> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const current = service.getRun(runId);
    if (current?.status === status) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for workflow ${runId} to reach status ${status}`);
}

describe('WorkflowKernelService suspended resume', () => {
  it('suspends and resumes the same delegated agent run', async () => {
    const dataDir = await createTempDir();
    const completedRuns: WorkflowRunRecord[] = [];
    const service = new WorkflowKernelService({
      dataDir,
      runners: new Map([['agent-main', {} as AgentRunner]]),
      callbacks: {
        async onRunComplete(_workflow, run) {
          completedRuns.push(run);
        },
        async findArchivedRun() {
          return null;
        },
      },
    });
    await service.initialize();

    const started = await service.startWorkflow(createWorkflow(), 'world');
    const suspended = await waitForStatus(service, started.runId, 'suspended');
    expect(suspended.stepResults[0]?.delegatedRunStatus).toBe('suspended');
    const delegatedRunId = suspended.stepResults[0]?.delegatedRunId;
    expect(delegatedRunId).toBeTruthy();

    const suspendedCompletion = await service.waitForCompletion(started.runId);
    expect(suspendedCompletion.status).toBe('suspended');

    const resumed = await service.resumeRun(started.runId);
    expect(resumed?.status).toBe('running');

    const completed = await service.waitForCompletion(started.runId);
    expect(completed.status).toBe('done');
    expect(completed.stepResults[0]?.output).toBe('reply:recovered');
    expect(completed.stepResults[0]?.delegatedRunId).toBe(delegatedRunId);
    expect(completed.stepResults[0]?.delegatedRunStatus).toBe('done');
    expect(mockedResumeAgentTurnViaKernel).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: delegatedRunId,
      }),
    );
    expect(mockedWaitForAgentTurnViaKernel).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: delegatedRunId,
      }),
    );
    expect(completedRuns).toHaveLength(1);
    expect(completedRuns[0]?.status).toBe('done');
  });
});