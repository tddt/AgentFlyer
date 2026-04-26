import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LLMProvider, RunParams } from '../agent/llm/provider.js';
import { AgentRunner } from '../agent/runner.js';
import type { ApprovalHandler } from '../agent/tools/policy.js';
import { ToolRegistry } from '../agent/tools/registry.js';
import type { AgentKernel } from '../core/kernel/agent-kernel.js';
import { SessionMetaStore } from '../core/session/meta.js';
import { SessionStore } from '../core/session/store.js';
import type { StreamChunk } from '../core/types.js';
import { AgentKernelService, getAgentKernelService } from './agent-kernel.js';
import { AgentQueueRegistry } from './agent-queue.js';
import type { RpcContext } from './rpc.js';
import { dispatchRpc } from './rpc.js';

const tempDirs: string[] = [];
const services: AgentKernelService[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentflyer-gateway-agent-kernel-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function trackService(service: AgentKernelService): AgentKernelService {
  services.push(service);
  return service;
}

async function readPersistedRunRecords(
  dataDir: string,
): Promise<Array<{ runId: string; processStatus: string; phase: string }>> {
  try {
    return JSON.parse(await readFile(join(dataDir, 'agent-run-records.json'), 'utf-8')) as Array<{
      runId: string;
      processStatus: string;
      phase: string;
    }>;
  } catch {
    return [];
  }
}

class FakeProvider implements LLMProvider {
  readonly id = 'fake';

  async *run(_params: RunParams): AsyncIterable<StreamChunk> {
    yield { type: 'text_delta', text: 'kernel hello' };
    yield {
      type: 'done',
      inputTokens: 1,
      outputTokens: 2,
      stopReason: 'end_turn',
    };
  }

  async countTokens(): Promise<number> {
    return 0;
  }

  supports(): boolean {
    return true;
  }
}

class FakeToolProvider implements LLMProvider {
  readonly id = 'fake-tool';

  async *run(params: RunParams): AsyncIterable<StreamChunk> {
    const hasToolResult = params.messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((content) => content.type === 'tool_result'),
    );

    if (!hasToolResult) {
      yield {
        type: 'tool_use_delta',
        id: 'tool-1',
        name: 'echo_tool',
        inputJson: '{"message":"kernel tool"}',
      };
      yield {
        type: 'done',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'tool_use',
      };
      return;
    }

    yield { type: 'text_delta', text: 'kernel tool done' };
    yield {
      type: 'done',
      inputTokens: 1,
      outputTokens: 2,
      stopReason: 'end_turn',
    };
  }

  async countTokens(): Promise<number> {
    return 0;
  }

  supports(): boolean {
    return true;
  }
}

class FakeBlockedLlmProvider implements LLMProvider {
  readonly id = 'fake-blocked-llm';

  async *run(_params: RunParams): AsyncIterable<StreamChunk> {
    yield { type: 'error', message: '429 insufficient_quota: billing quota exceeded' };
  }

  async countTokens(): Promise<number> {
    return 0;
  }

  supports(): boolean {
    return true;
  }
}

class FakeRecoverableBlockedLlmProvider implements LLMProvider {
  readonly id = 'fake-recoverable-blocked-llm';

  constructor(private readonly isBlocked: () => boolean) {}

  async *run(_params: RunParams): AsyncIterable<StreamChunk> {
    if (this.isBlocked()) {
      yield { type: 'error', message: '429 insufficient_quota: billing quota exceeded' };
      return;
    }

    yield { type: 'text_delta', text: 'quota recovered' };
    yield {
      type: 'done',
      inputTokens: 1,
      outputTokens: 2,
      stopReason: 'end_turn',
    };
  }

  async countTokens(): Promise<number> {
    return 0;
  }

  supports(): boolean {
    return true;
  }
}

class BlockingProvider implements LLMProvider {
  readonly id = 'fake-blocking-llm';

  private runCount = 0;

  constructor(private readonly releaseFirstRun: Promise<void>) {}

  async *run(_params: RunParams): AsyncIterable<StreamChunk> {
    this.runCount += 1;
    if (this.runCount === 1) {
      await this.releaseFirstRun;
      yield { type: 'text_delta', text: 'first run released' };
      yield {
        type: 'done',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'end_turn',
      };
      return;
    }

    yield { type: 'text_delta', text: 'queued rpc reply' };
    yield {
      type: 'done',
      inputTokens: 1,
      outputTokens: 1,
      stopReason: 'end_turn',
    };
  }

  async countTokens(): Promise<number> {
    return 0;
  }

  supports(): boolean {
    return true;
  }
}

function createRunner(
  dataDir: string,
  provider: LLMProvider = new FakeProvider(),
  options: { approval?: string[]; approvalHandler?: ApprovalHandler } = {},
): AgentRunner {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register({
    category: 'test',
    definition: {
      name: 'echo_tool',
      description: 'Echo test tool',
      inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
    },
    async handler(input) {
      const message = (input as { message?: string }).message ?? '';
      return { isError: false, content: `echo:${message}` };
    },
  });

  return new AgentRunner(
    {
      id: 'agent-main',
      name: 'Agent Main',
      mentionAliases: [],
      workspace: dataDir,
      skills: [],
      model: 'fake-model',
      mesh: {
        role: 'worker',
        capabilities: [],
        accepts: ['task', 'query', 'notification'],
        visibility: 'public',
        triggers: [],
      },
      owners: [],
      tools: { allow: [], deny: [], approval: options.approval ?? [], maxRounds: 4 },
      persona: { language: 'zh-CN', outputDir: 'output' },
    },
    {
      provider,
      toolRegistry,
      sessionStore: new SessionStore(join(dataDir, 'sessions')),
      metaStore: new SessionMetaStore(join(dataDir, 'sessions')),
      approvalHandler: options.approvalHandler,
      skillsText: '',
    },
  );
}

function createRpcContext(
  dataDir: string,
  runner: AgentRunner,
  overrides: Partial<RpcContext> = {},
): RpcContext {
  return {
    runners: new Map([['agent-main', runner]]),
    gatewayVersion: 'test',
    startedAt: 0,
    dataDir,
    getConfig: () => ({}) as never,
    saveAndReload: async () => ({ reloaded: [] }),
    scheduler: {} as never,
    shutdown: async () => undefined,
    reload: async () => ({ reloaded: [] }),
    listSkills: () => [],
    sessionStore: new SessionStore(join(dataDir, 'sessions')),
    metaStore: new SessionMetaStore(join(dataDir, 'sessions')),
    contentStore: {
      async list() {
        return [];
      },
    } as never,
    deliverableStore: {} as never,
    channels: new Map(),
    runningTasks: new Map(),
    ...overrides,
  };
}

async function waitForRunPhase(
  service: AgentKernelService,
  runId: string,
  phase: 'suspended' | 'done',
): Promise<NonNullable<ReturnType<AgentKernelService['getRun']>>> {
  let lastRun: ReturnType<AgentKernelService['getRun']> = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = service.getRun(runId);
    lastRun = run;
    if (run?.phase === phase) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Run ${runId} did not reach phase ${phase}; last=${JSON.stringify(lastRun)}`);
}

async function waitForArchivedRun(
  service: AgentKernelService,
  runId: string,
): Promise<NonNullable<ReturnType<AgentKernelService['getRun']>>> {
  let lastRun: ReturnType<AgentKernelService['getRun']> = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = service.getRun(runId);
    const snapshot = (service as unknown as { kernel: AgentKernel }).kernel.getSnapshot(
      runId as never,
    );
    lastRun = run;
    if (run?.phase === 'done' && !snapshot) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Run ${runId} was not archived; last=${JSON.stringify(lastRun)}`);
}

async function waitForRpcRunPhase(
  ctx: RpcContext,
  runId: string,
  phase: 'pending' | 'suspended' | 'done',
): Promise<{
  phase: 'pending' | 'suspended' | 'done';
  processStatus: string;
  error?: { code: string; message: string };
  result?: { text: string };
}> {
  let lastRun: {
    phase: 'pending' | 'suspended' | 'done';
    processStatus: string;
    error?: { code: string; message: string };
    result?: { text: string };
  } | null = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await dispatchRpc(
      { id: attempt, method: 'agent.runStatus', params: { runId } },
      ctx,
    );
    const run = response.result as {
      phase: 'suspended' | 'done';
      processStatus: string;
      error?: { code: string; message: string };
      result?: { text: string };
    } | null;
    lastRun = run;
    if (run?.phase === phase) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`RPC run ${runId} did not reach phase ${phase}; last=${JSON.stringify(lastRun)}`);
}

describe('AgentKernelService', () => {
  it('executes a non-streaming turn through the kernel', async () => {
    const dataDir = await createTempDir();
    const service = trackService(
      new AgentKernelService({
        dataDir,
        runners: new Map([['agent-main', createRunner(dataDir)]]),
      }),
    );

    const result = await service.executeTurn({
      agentId: 'agent-main',
      userMessage: 'say hello',
      threadKey: 'kernel-thread',
    });

    expect(result.text).toContain('kernel hello');
    expect(result.sessionKey).toContain('kernel-thread');
  });

  it('streams chunks through the kernel service', async () => {
    const dataDir = await createTempDir();
    const service = trackService(
      new AgentKernelService({
        dataDir,
        runners: new Map([['agent-main', createRunner(dataDir)]]),
      }),
    );

    const chunks: StreamChunk[] = [];
    const stream = service.streamTurn({
      agentId: 'agent-main',
      userMessage: 'say hello',
      threadKey: 'stream-thread',
    });
    let next = await stream.next();
    while (!next.done) {
      chunks.push(next.value);
      next = await stream.next();
    }

    expect(
      chunks.some((chunk) => chunk.type === 'text_delta' && chunk.text.includes('kernel hello')),
    ).toBe(true);
    expect(chunks.some((chunk) => chunk.type === 'done')).toBe(true);
    expect(next.value?.text).toContain('kernel hello');
  });

  it('auto-resolves tool syscalls and completes the turn', async () => {
    const dataDir = await createTempDir();
    const service = trackService(
      new AgentKernelService({
        dataDir,
        runners: new Map([['agent-main', createRunner(dataDir, new FakeToolProvider())]]),
      }),
    );

    const result = await service.executeTurn({
      agentId: 'agent-main',
      userMessage: 'use tool',
      threadKey: 'tool-thread',
    });

    expect(result.text).toContain('kernel tool done');
  });

  it('auto-resolves approval and tool syscalls in sequence', async () => {
    const dataDir = await createTempDir();
    const service = trackService(
      new AgentKernelService({
        dataDir,
        runners: new Map([
          [
            'agent-main',
            createRunner(dataDir, new FakeToolProvider(), {
              approval: ['echo_tool'],
              approvalHandler: async () => true,
            }),
          ],
        ]),
      }),
    );

    const result = await service.executeTurn({
      agentId: 'agent-main',
      userMessage: 'use approved tool',
      threadKey: 'approval-thread',
    });

    expect(result.text).toContain('kernel tool done');
  });

  it('rejects suspended turns when approval is denied', async () => {
    const dataDir = await createTempDir();
    const service = trackService(
      new AgentKernelService({
        dataDir,
        runners: new Map([
          [
            'agent-main',
            createRunner(dataDir, new FakeToolProvider(), {
              approval: ['echo_tool'],
              approvalHandler: async () => false,
            }),
          ],
        ]),
      }),
    );

    await expect(
      service.executeTurn({
        agentId: 'agent-main',
        userMessage: 'use denied tool',
        threadKey: 'denied-approval-thread',
      }),
    ).rejects.toThrow('工具调用需要审批，当前处于挂起状态：echo_tool');

    const sessionMeta = (await new SessionMetaStore(join(dataDir, 'sessions')).listAll())[0];
    expect(sessionMeta?.status).toBe('suspended');
    expect(sessionMeta?.errorCode).toBe('approval_required');
  });

  it('emits an error chunk before ending a suspended stream', async () => {
    const dataDir = await createTempDir();
    const service = trackService(
      new AgentKernelService({
        dataDir,
        runners: new Map([
          [
            'agent-main',
            createRunner(dataDir, new FakeToolProvider(), {
              approval: ['echo_tool'],
              approvalHandler: async () => false,
            }),
          ],
        ]),
      }),
    );

    const chunks: StreamChunk[] = [];
    const stream = service.streamTurn({
      agentId: 'agent-main',
      userMessage: 'use denied tool in stream',
      threadKey: 'stream-suspended-thread',
    });
    let next = await stream.next();
    while (!next.done) {
      chunks.push(next.value);
      next = await stream.next();
    }

    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(true);
    expect(
      chunks.some((chunk) => chunk.type === 'error' && chunk.message.includes('工具调用需要审批')),
    ).toBe(true);
    expect(next.value).toBeNull();
  });

  it('rejects suspended turns when the model quota is blocked', async () => {
    const dataDir = await createTempDir();
    const service = trackService(
      new AgentKernelService({
        dataDir,
        runners: new Map([['agent-main', createRunner(dataDir, new FakeBlockedLlmProvider())]]),
      }),
    );

    await expect(
      service.executeTurn({
        agentId: 'agent-main',
        userMessage: 'trigger blocked quota',
        threadKey: 'blocked-quota-thread',
      }),
    ).rejects.toThrow(
      '模型服务的计费或配额状态异常，请检查 API Key、余额或项目配额。 当前运行已挂起，可在外部条件恢复后继续。',
    );

    const sessionMeta = (await new SessionMetaStore(join(dataDir, 'sessions')).listAll())[0];
    expect(sessionMeta?.status).toBe('suspended');
    expect(sessionMeta?.errorCode).toBe('billing');
  });

  it('resumes suspended turns after the model quota recovers', async () => {
    const dataDir = await createTempDir();
    let blocked = true;
    const provider = new FakeRecoverableBlockedLlmProvider(() => blocked);
    const service = trackService(
      new AgentKernelService({
        dataDir,
        runners: new Map([['agent-main', createRunner(dataDir, provider)]]),
      }),
    );

    const started = await service.startTurn({
      agentId: 'agent-main',
      userMessage: 'resume after quota recovery',
      threadKey: 'resume-thread',
    });

    const suspended = await waitForRunPhase(service, started.runId, 'suspended');
    expect(suspended.error?.code).toBe('AGENT_LLM_RESOURCE_BLOCKED');

    const suspendedMeta = (await new SessionMetaStore(join(dataDir, 'sessions')).listAll())[0];
    expect(suspendedMeta?.status).toBe('suspended');
    expect(suspendedMeta?.errorCode).toBe('billing');

    blocked = false;
    const resumed = await service.resumeTurn(started.runId);
    const rawSnapshot = (service as unknown as { kernel: AgentKernel }).kernel.getSnapshot(
      started.runId as never,
    );
    expect(resumed?.processStatus, JSON.stringify({ resumed, rawSnapshot })).toBe('ready');
    expect(rawSnapshot?.status).toBe('ready');

    const completed = await waitForRunPhase(service, started.runId, 'done');
    expect(completed.result?.text).toContain('quota recovered');

    const resumedMeta = (await new SessionMetaStore(join(dataDir, 'sessions')).listAll())[0];
    expect(resumedMeta?.status).toBe('idle');
    expect(resumedMeta?.errorCode).toBeUndefined();
  });

  it('restores completed run records after service restart', async () => {
    const dataDir = await createTempDir();
    const firstService = trackService(
      new AgentKernelService({
        dataDir,
        runners: new Map([['agent-main', createRunner(dataDir)]]),
      }),
    );

    const started = await firstService.startTurn({
      agentId: 'agent-main',
      userMessage: 'persist completed run',
      threadKey: 'persisted-run-thread',
    });

    const completed = await waitForArchivedRun(firstService, started.runId);
    expect(completed.result?.text).toContain('kernel hello');

    const restartedService = trackService(
      new AgentKernelService({
        dataDir,
        runners: new Map([['agent-main', createRunner(dataDir)]]),
      }),
    );
    await restartedService.initialize();

    const restored = restartedService.getRun(started.runId);
    expect(restored?.runId).toBe(started.runId);
    expect(restored?.phase).toBe('done');
    expect(restored?.processStatus).toBe('done');
    expect(restored?.threadKey).toBe('persisted-run-thread');
    expect(restored?.result?.text).toContain('kernel hello');
  });

  it('resolves archived completion outcomes after service restart', async () => {
    const dataDir = await createTempDir();
    const firstService = trackService(
      new AgentKernelService({
        dataDir,
        runners: new Map([['agent-main', createRunner(dataDir)]]),
      }),
    );

    const started = await firstService.startTurn({
      agentId: 'agent-main',
      userMessage: 'await archived completion',
      threadKey: 'archived-completion-thread',
    });

    await waitForArchivedRun(firstService, started.runId);

    const restartedService = trackService(
      new AgentKernelService({
        dataDir,
        runners: new Map([['agent-main', createRunner(dataDir)]]),
      }),
    );
    await restartedService.initialize();

    const result = await (
      restartedService as unknown as { waitForCompletion(runId: string): Promise<{ text: string }> }
    ).waitForCompletion(started.runId);

    expect(result.text).toContain('kernel hello');
  });

  it('restores suspended runs from checkpoints without persisting live run records', async () => {
    const dataDir = await createTempDir();
    let blocked = true;
    const provider = new FakeRecoverableBlockedLlmProvider(() => blocked);
    const firstService = trackService(
      new AgentKernelService({
        dataDir,
        runners: new Map([['agent-main', createRunner(dataDir, provider)]]),
      }),
    );

    const started = await firstService.startTurn({
      agentId: 'agent-main',
      userMessage: 'persist only archived states',
      threadKey: 'checkpoint-only-suspended-thread',
    });

    const suspended = await waitForRunPhase(firstService, started.runId, 'suspended');
    expect(suspended.processStatus).toBe('suspended');

    const persistedBeforeRestart = await readPersistedRunRecords(dataDir);
    expect(persistedBeforeRestart.some((record) => record.runId === started.runId)).toBe(false);

    const restartedService = trackService(
      new AgentKernelService({
        dataDir,
        runners: new Map([['agent-main', createRunner(dataDir, provider)]]),
      }),
    );
    await restartedService.initialize();

    const restored = restartedService.getRun(started.runId);
    expect(restored).toBeTruthy();
    expect(['ready', 'suspended']).toContain(restored?.processStatus);

    blocked = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const current = restartedService.getRun(started.runId);
      if (!current || current.phase === 'done') {
        break;
      }
      if (current.processStatus === 'suspended') {
        await restartedService.resumeTurn(started.runId);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const completed = await waitForArchivedRun(restartedService, started.runId);
    expect(completed.result?.text).toContain('quota recovered');

    const persistedAfterCompletion = await readPersistedRunRecords(dataDir);
    expect(persistedAfterCompletion.some((record) => record.runId === started.runId)).toBe(true);
  });

  it('resolves completion after archive on the same service instance', async () => {
    const dataDir = await createTempDir();
    const service = trackService(
      new AgentKernelService({
        dataDir,
        runners: new Map([['agent-main', createRunner(dataDir)]]),
      }),
    );

    const started = await service.startTurn({
      agentId: 'agent-main',
      userMessage: 'await archived completion locally',
      threadKey: 'archived-completion-same-service-thread',
    });

    await waitForArchivedRun(service, started.runId);

    const result = await (
      service as unknown as { waitForCompletion(runId: string): Promise<{ text: string }> }
    ).waitForCompletion(started.runId);

    expect(result.text).toContain('kernel hello');
  });

  it('exposes run/resume control through RPC', async () => {
    const dataDir = await createTempDir();
    let blocked = true;
    const provider = new FakeRecoverableBlockedLlmProvider(() => blocked);
    const ctx = createRpcContext(dataDir, createRunner(dataDir, provider));
    services.push(await getAgentKernelService(ctx));

    const started = await dispatchRpc(
      {
        id: 1,
        method: 'agent.run',
        params: {
          agentId: 'agent-main',
          message: 'resume via rpc',
          thread: 'rpc-resume-thread',
        },
      },
      ctx,
    );
    const runId = (started.result as { runId: string }).runId;

    const suspended = await waitForRpcRunPhase(ctx, runId, 'suspended');
    expect(suspended.processStatus).toBe('suspended');
    expect(suspended.error?.code).toBe('AGENT_LLM_RESOURCE_BLOCKED');

    blocked = false;
    const resumed = await dispatchRpc(
      {
        id: 2,
        method: 'agent.resume',
        params: { runId },
      },
      ctx,
    );
    const resumeResult = resumed.result as {
      resumed: boolean;
      run?: { processStatus: string; phase: string };
    };
    expect(resumeResult.resumed).toBe(true);
    expect(resumeResult.run?.processStatus).toBe('ready');

    const afterResume = await dispatchRpc(
      {
        id: 3,
        method: 'agent.runStatus',
        params: { runId },
      },
      ctx,
    );
    expect((afterResume.result as { processStatus?: string } | null)?.processStatus).toBe('ready');
  });

  it('runs agent.chat concurrently — second chat completes before first is released', async () => {
    const dataDir = await createTempDir();
    let releaseFirstRun!: () => void;
    const firstRunReleased = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    const provider = new BlockingProvider(firstRunReleased);
    const runner = createRunner(dataDir, provider);
    const ctx = createRpcContext(dataDir, runner, {
      agentQueues: new AgentQueueRegistry(),
    });
    const service = await getAgentKernelService(ctx);
    services.push(service);

    // Start the first turn directly (outside queue) — this blocks on BlockingProvider.
    const started = await service.startTurn({
      agentId: 'agent-main',
      userMessage: 'block the runner first',
      threadKey: 'rpc-chat-concurrent-blocking-thread',
    });
    const firstDone = service.waitForRun(started.runId);

    // Dispatch a second chat via RPC — with the new concurrent design the queue
    // only holds startTurn (fast), then waitForRun runs outside the queue.
    // The BlockingProvider's second call (runCount=2) returns immediately, so the
    // second chat should complete WITHOUT needing to release the first run.
    const secondChat = dispatchRpc(
      {
        id: 2,
        method: 'agent.chat',
        params: {
          agentId: 'agent-main',
          message: 'concurrent rpc message',
          thread: 'rpc-chat-concurrent-thread',
        },
      },
      ctx,
    );

    // The second chat must complete on its own — no releaseFirstRun() called yet.
    // Race with a timeout: the second chat must win (old design would have hung here).
    const TIMEOUT_MS = 3000;
    let timedOut = false;
    const winner = await Promise.race([
      secondChat.then((r) => ({ tag: 'second' as const, response: r })),
      new Promise<{ tag: 'timeout' }>((resolve) =>
        setTimeout(() => {
          timedOut = true;
          resolve({ tag: 'timeout' });
        }, TIMEOUT_MS),
      ),
    ]);

    expect(timedOut).toBe(false);
    expect(winner.tag).toBe('second');
    if (winner.tag === 'second') {
      expect((winner.response.result as { reply: string }).reply).toContain('queued rpc reply');
    }

    // Now release the first run and let it finish.
    releaseFirstRun();
    await firstDone;
  });

  it('reports active run and concurrent execution state through agent.status and agent.list', async () => {
    const dataDir = await createTempDir();
    let releaseFirstRun!: () => void;
    const firstRunReleased = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    const provider = new BlockingProvider(firstRunReleased);
    const runner = createRunner(dataDir, provider);
    const ctx = createRpcContext(dataDir, runner, {
      agentQueues: new AgentQueueRegistry(),
    });
    const service = await getAgentKernelService(ctx);
    services.push(service);

    const firstChat = dispatchRpc(
      {
        id: 1,
        method: 'agent.chat',
        params: {
          agentId: 'agent-main',
          message: 'status block the runner first',
          thread: 'status-blocking-thread',
        },
      },
      ctx,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const queuedChat = dispatchRpc(
      {
        id: 2,
        method: 'agent.chat',
        params: {
          agentId: 'agent-main',
          message: 'concurrent status message',
          thread: 'status-concurrent-thread',
        },
      },
      ctx,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const statusResponse = await dispatchRpc(
      {
        id: 3,
        method: 'agent.status',
        params: { agentId: 'agent-main' },
      },
      ctx,
    );
    // Both chats start immediately (concurrent), so state=running.
    // pendingCount may be 0 (both startTurns resolved before status check)
    // or 1 (first startTurn still in flight when second enqueue fires) —
    // either is valid; the important invariants are state=running and activeRun.
    expect(statusResponse.result).toMatchObject({
      agentId: 'agent-main',
      activity: {
        state: 'running',
        activeRun: expect.objectContaining({ runId: expect.any(String) }),
      },
    });

    const listResponse = await dispatchRpc(
      {
        id: 4,
        method: 'agent.list',
      },
      ctx,
    );
    expect(
      (
        listResponse.result as {
          agents: Array<{ agentId: string; activity: { state: string } }>;
        }
      ).agents,
    ).toContainEqual(
      expect.objectContaining({
        agentId: 'agent-main',
        activity: expect.objectContaining({
          state: 'running',
        }),
      }),
    );

    releaseFirstRun();
    await firstChat;
    await queuedChat;
  });

  it('returns a queued run handle immediately and exposes pending runStatus before kernel start', async () => {
    const dataDir = await createTempDir();
    let releaseFirstRun!: () => void;
    const firstRunReleased = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    const provider = new BlockingProvider(firstRunReleased);
    const runner = createRunner(dataDir, provider);
    const ctx = createRpcContext(dataDir, runner, {
      agentQueues: new AgentQueueRegistry(),
    });
    services.push(await getAgentKernelService(ctx));

    const firstStarted = await dispatchRpc(
      {
        id: 1,
        method: 'agent.run',
        params: {
          agentId: 'agent-main',
          message: 'first queued run',
          thread: 'queued-run-first-thread',
        },
      },
      ctx,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondStarted = await dispatchRpc(
      {
        id: 2,
        method: 'agent.run',
        params: {
          agentId: 'agent-main',
          message: 'second queued run',
          thread: 'queued-run-second-thread',
        },
      },
      ctx,
    );

    const secondRunId = (secondStarted.result as { runId: string; queued?: boolean }).runId;
    expect((secondStarted.result as { queued?: boolean }).queued).toBe(true);

    const pending = await waitForRpcRunPhase(ctx, secondRunId, 'pending');
    expect(pending.processStatus).toBe('waiting');

    const statusResponse = await dispatchRpc(
      {
        id: 3,
        method: 'agent.status',
        params: { agentId: 'agent-main' },
      },
      ctx,
    );
    expect(statusResponse.result).toMatchObject({
      agentId: 'agent-main',
      activity: {
        state: 'running',
        pendingCount: 1,
        queuedRuns: [
          {
            runId: secondRunId,
            threadKey: 'queued-run-second-thread',
            processStatus: 'waiting',
            phase: 'pending',
          },
        ],
      },
    });

    releaseFirstRun();

    const firstRunId = (firstStarted.result as { runId: string }).runId;
    await waitForRpcRunPhase(ctx, firstRunId, 'done');
    const completed = await waitForRpcRunPhase(ctx, secondRunId, 'done');
    expect(completed.result?.text).toContain('queued rpc reply');
  });

  it('cancels a queued run before kernel start and keeps it from starting later', async () => {
    const dataDir = await createTempDir();
    let releaseFirstRun!: () => void;
    const firstRunReleased = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    const provider = new BlockingProvider(firstRunReleased);
    const runner = createRunner(dataDir, provider);
    const ctx = createRpcContext(dataDir, runner, {
      agentQueues: new AgentQueueRegistry(),
    });
    services.push(await getAgentKernelService(ctx));

    const firstStarted = await dispatchRpc(
      {
        id: 1,
        method: 'agent.run',
        params: {
          agentId: 'agent-main',
          message: 'first blocking run',
          thread: 'queued-cancel-first-thread',
        },
      },
      ctx,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondStarted = await dispatchRpc(
      {
        id: 2,
        method: 'agent.run',
        params: {
          agentId: 'agent-main',
          message: 'second queued run to cancel',
          thread: 'queued-cancel-second-thread',
        },
      },
      ctx,
    );

    const secondRunId = (secondStarted.result as { runId: string; queued?: boolean }).runId;
    const cancelled = await dispatchRpc(
      {
        id: 3,
        method: 'agent.cancel',
        params: { runId: secondRunId },
      },
      ctx,
    );

    expect((cancelled.result as { cancelled: boolean }).cancelled).toBe(true);

    const cancelledStatus = await dispatchRpc(
      {
        id: 4,
        method: 'agent.runStatus',
        params: { runId: secondRunId },
      },
      ctx,
    );
    expect(cancelledStatus.result).toMatchObject({
      runId: secondRunId,
      processStatus: 'error',
      phase: 'error',
      error: {
        code: 'AGENT_TURN_CANCELLED',
      },
    });

    const statusResponse = await dispatchRpc(
      {
        id: 5,
        method: 'agent.status',
        params: { agentId: 'agent-main' },
      },
      ctx,
    );
    expect(statusResponse.result).toMatchObject({
      agentId: 'agent-main',
      activity: {
        state: 'running',
        pendingCount: 0,
        queuedRuns: [],
      },
    });

    releaseFirstRun();

    const firstRunId = (firstStarted.result as { runId: string }).runId;
    await waitForRpcRunPhase(ctx, firstRunId, 'done');

    const finalCancelledStatus = await dispatchRpc(
      {
        id: 6,
        method: 'agent.runStatus',
        params: { runId: secondRunId },
      },
      ctx,
    );
    expect(finalCancelledStatus.result).toMatchObject({
      runId: secondRunId,
      processStatus: 'error',
      phase: 'error',
      error: {
        code: 'AGENT_TURN_CANCELLED',
      },
    });
  });
});
