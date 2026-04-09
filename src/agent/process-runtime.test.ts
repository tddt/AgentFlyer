import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentKernel } from '../core/kernel/agent-kernel.js';
import { JsonFileCheckpointStore } from '../core/kernel/checkpoint-store.js';
import { SessionMetaStore } from '../core/session/meta.js';
import { SessionStore } from '../core/session/store.js';
import type { StreamChunk } from '../core/types.js';
import { drainWaitingAgentSyscalls } from './kernel-syscall-broker.js';
import type { LLMProvider, RunParams } from './llm/provider.js';
import { AgentTurnProcessRuntime } from './process-runtime.js';
import { AgentRunner } from './runner.js';
import type { ApprovalHandler } from './tools/policy.js';
import type { RegisteredTool } from './tools/registry.js';
import { ToolRegistry } from './tools/registry.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentflyer-runner-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

class FakeProvider implements LLMProvider {
  readonly id = 'fake';

  async *run(_params: RunParams): AsyncIterable<StreamChunk> {
    yield { type: 'text_delta', text: 'hello from runtime' };
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

class FakeToolLoopProvider implements LLMProvider {
  readonly id = 'fake-tool-loop';

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
        inputJson: '{"message":"from tool"}',
      };
      yield {
        type: 'done',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'tool_use',
      };
      return;
    }

    yield { type: 'text_delta', text: 'tool loop completed' };
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

function createRunner(dataDir: string): AgentRunner {
  return createRunnerWithProvider(dataDir, new FakeProvider());
}

function createRunnerWithProvider(
  dataDir: string,
  provider: LLMProvider,
  options: {
    approval?: string[];
    approvalHandler?: ApprovalHandler;
    toolApprovalMode?: RegisteredTool['approvalMode'];
  } = {},
): AgentRunner {
  const toolRegistry = new ToolRegistry();
  const echoTool: RegisteredTool = {
    category: 'test',
    definition: {
      name: 'echo_tool',
      description: 'Echo test tool',
      inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
    },
    approvalMode: options.toolApprovalMode,
    async handler(input) {
      const message = (input as { message?: string }).message ?? '';
      return { isError: false, content: `echo:${message}` };
    },
  };
  toolRegistry.register(echoTool);

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

class FakeBlockedLlmProvider implements LLMProvider {
  readonly id = 'fake-blocked-llm';

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
describe('AgentRunner state serialization', () => {
  it('restores thread and cache state', async () => {
    const dataDir = await createTempDir();
    const runner = createRunner(dataDir);

    runner.setThread('custom-thread');
    const before = runner.serializeState();

    const other = createRunner(dataDir);
    other.restoreState(before);

    expect(other.currentSessionKey).toBe(runner.currentSessionKey);
    expect(other.serializeState()).toEqual(before);
  });

  it('drives local syscalls when using runner.runTurn directly', async () => {
    const dataDir = await createTempDir();
    const runner = createRunnerWithProvider(dataDir, new FakeToolLoopProvider());

    const result = await Promise.race([
      runner.runTurn('use tool directly'),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('runner.runTurn timed out')), 1000);
      }),
    ]);

    expect(result.text).toContain('tool loop completed');
  });
});

describe('AgentTurnProcessRuntime', () => {
  it('wraps AgentRunner turn execution into a kernel-compatible runtime', async () => {
    const dataDir = await createTempDir();
    const runner = createRunner(dataDir);
    const seenChunks: StreamChunk[] = [];
    const runtime = new AgentTurnProcessRuntime(new Map([['agent-main', runner]]), {
      onChunk(_runId, chunk) {
        seenChunks.push(chunk);
      },
    });

    const initialState = runtime.createInitialState({
      agentId: 'agent-main',
      runId: 'run-1',
      userMessage: 'say hello',
      threadKey: 'kernel-thread',
    });

    const prepared = await runtime.step(initialState, {
      pid: 'pid-1' as never,
      now: Date.now(),
      runCount: 0,
      retryCount: 0,
      metadata: {},
    });

    expect(prepared.signal).toBe('YIELD');
    expect(prepared.state.phase).toBe('running');
    expect(prepared.state.executionState).toBeTruthy();

    const result = await runtime.step(prepared.state, {
      pid: 'pid-1' as never,
      now: Date.now(),
      runCount: 1,
      retryCount: 0,
      metadata: {},
    });

    expect(result.signal).toBe('WAITING_SYSCALL');
    expect(result.state.phase).toBe('waiting_llm');
    const llmSyscall = result.syscall;
    if (!llmSyscall) {
      throw new Error('expected llm syscall');
    }

    const llmResolution = await runtime.executePendingSyscall(result.state, llmSyscall, Date.now());

    const completed = await runtime.step(result.state, {
      pid: 'pid-1' as never,
      now: Date.now(),
      runCount: 2,
      retryCount: 0,
      lastSyscallResult: llmResolution,
      metadata: {},
    });

    expect(completed.signal).toBe('DONE');
    expect(completed.state.phase).toBe('done');
    expect(completed.state.result?.text).toContain('hello from runtime');
    expect(completed.state.result?.sessionKey).toContain('kernel-thread');
    expect(completed.state.stream).toHaveLength(2);
    expect(seenChunks).toHaveLength(2);
  });

  it('advances one LLM/tool round per kernel step', async () => {
    const dataDir = await createTempDir();
    const runner = createRunnerWithProvider(dataDir, new FakeToolLoopProvider());
    const runtime = new AgentTurnProcessRuntime(new Map([['agent-main', runner]]));

    const initialState = runtime.createInitialState({
      agentId: 'agent-main',
      runId: 'run-2',
      userMessage: 'use a tool',
      threadKey: 'round-thread',
    });

    const prepared = await runtime.step(initialState, {
      pid: 'pid-2' as never,
      now: Date.now(),
      runCount: 0,
      retryCount: 0,
      metadata: {},
    });
    expect(prepared.signal).toBe('YIELD');

    const roundOne = await runtime.step(prepared.state, {
      pid: 'pid-2' as never,
      now: Date.now(),
      runCount: 1,
      retryCount: 0,
      metadata: {},
    });
    expect(roundOne.signal).toBe('WAITING_SYSCALL');
    expect(roundOne.state.phase).toBe('waiting_llm');
    const llmSyscall = roundOne.syscall;
    if (!llmSyscall) {
      throw new Error('expected llm syscall');
    }

    const llmResolution = await runtime.executePendingSyscall(
      roundOne.state,
      llmSyscall,
      Date.now(),
    );

    const roundTwo = await runtime.step(roundOne.state, {
      pid: 'pid-2' as never,
      now: Date.now(),
      runCount: 2,
      retryCount: 0,
      lastSyscallResult: llmResolution,
      metadata: {},
    });
    expect(roundTwo.signal).toBe('WAITING_SYSCALL');
    expect(roundTwo.state.phase).toBe('waiting_tool');
    const toolSyscall = roundTwo.syscall;
    if (!toolSyscall) {
      throw new Error('expected tool syscall');
    }
    expect(toolSyscall.kind).toBe('tool.call');
    expect(roundTwo.state.stream.some((chunk) => chunk.type === 'tool_use_delta')).toBe(true);

    const toolResolution = await runtime.executePendingSyscall(
      roundTwo.state,
      toolSyscall,
      Date.now(),
    );

    const roundThree = await runtime.step(roundTwo.state, {
      pid: 'pid-2' as never,
      now: Date.now(),
      runCount: 3,
      retryCount: 0,
      lastSyscallResult: toolResolution,
      metadata: {},
    });
    expect(roundThree.signal).toBe('WAITING_SYSCALL');
    expect(roundThree.state.phase).toBe('waiting_llm');
    const finalLlmSyscall = roundThree.syscall;
    if (!finalLlmSyscall) {
      throw new Error('expected final llm syscall');
    }

    const finalLlmResolution = await runtime.executePendingSyscall(
      roundThree.state,
      finalLlmSyscall,
      Date.now(),
    );

    const roundFour = await runtime.step(roundThree.state, {
      pid: 'pid-2' as never,
      now: Date.now(),
      runCount: 4,
      retryCount: 0,
      lastSyscallResult: finalLlmResolution,
      metadata: {},
    });
    expect(roundFour.signal).toBe('DONE');
    expect(roundFour.state.result?.text).toContain('tool loop completed');
  });

  it('suspends on approval before executing a gated tool call', async () => {
    const dataDir = await createTempDir();
    const runner = createRunnerWithProvider(dataDir, new FakeToolLoopProvider(), {
      approval: ['echo_tool'],
      approvalHandler: async () => true,
    });
    const runtime = new AgentTurnProcessRuntime(new Map([['agent-main', runner]]));

    const initialState = runtime.createInitialState({
      agentId: 'agent-main',
      runId: 'run-approval',
      userMessage: 'needs approval',
      threadKey: 'approval-thread',
    });

    const prepared = await runtime.step(initialState, {
      pid: 'pid-approval' as never,
      now: Date.now(),
      runCount: 0,
      retryCount: 0,
      metadata: {},
    });
    expect(prepared.signal).toBe('YIELD');

    const waitLlm = await runtime.step(prepared.state, {
      pid: 'pid-approval' as never,
      now: Date.now(),
      runCount: 1,
      retryCount: 0,
      metadata: {},
    });
    expect(waitLlm.signal).toBe('WAITING_SYSCALL');
    expect(waitLlm.state.phase).toBe('waiting_llm');
    if (!waitLlm.syscall) {
      throw new Error('expected llm syscall');
    }

    const llmResolution = await runtime.executePendingSyscall(
      waitLlm.state,
      waitLlm.syscall,
      Date.now(),
    );
    const waitApproval = await runtime.step(waitLlm.state, {
      pid: 'pid-approval' as never,
      now: Date.now(),
      runCount: 2,
      retryCount: 0,
      lastSyscallResult: llmResolution,
      metadata: {},
    });
    expect(waitApproval.signal).toBe('WAITING_SYSCALL');
    expect(waitApproval.state.phase).toBe('waiting_approval');
    expect(waitApproval.syscall?.operation).toBe('agent.turn.approval-request');

    if (!waitApproval.syscall) {
      throw new Error('expected approval syscall');
    }
    const approvalResolution = await runtime.executePendingSyscall(
      waitApproval.state,
      waitApproval.syscall,
      Date.now(),
    );
    const waitTool = await runtime.step(waitApproval.state, {
      pid: 'pid-approval' as never,
      now: Date.now(),
      runCount: 3,
      retryCount: 0,
      lastSyscallResult: approvalResolution,
      metadata: {},
    });
    expect(waitTool.signal).toBe('WAITING_SYSCALL');
    expect(waitTool.state.phase).toBe('waiting_tool');
  });

  it('suspends when approval is denied and resumes from checkpoint after approval changes', async () => {
    const dataDir = await createTempDir();
    let approved = false;
    const runner = createRunnerWithProvider(dataDir, new FakeToolLoopProvider(), {
      approval: ['echo_tool'],
      approvalHandler: async () => approved,
    });
    const runtime = new AgentTurnProcessRuntime(new Map([['agent-main', runner]]));
    const kernel = new AgentKernel({
      checkpointStore: new JsonFileCheckpointStore(dataDir),
    });
    kernel.registerProcessRuntime(runtime);

    await kernel.createProcess({
      processType: runtime.type,
      processId: 'run-suspend' as never,
      metadata: { agentId: 'agent-main' },
      input: {
        agentId: 'agent-main',
        runId: 'run-suspend',
        userMessage: 'needs resumable approval',
        threadKey: 'suspend-thread',
      },
    });

    expect((await kernel.tick()).signal).toBe('YIELD');
    expect((await kernel.tick()).signal).toBe('WAITING_SYSCALL');
    expect(await drainWaitingAgentSyscalls(kernel, runtime)).toBe(true);
    expect((await kernel.tick()).signal).toBe('WAITING_SYSCALL');
    expect(await drainWaitingAgentSyscalls(kernel, runtime)).toBe(true);

    const suspendedTick = await kernel.tick();
    expect(suspendedTick.signal).toBe('SUSPENDED');

    const suspendedSnapshot = kernel.getSnapshot('run-suspend' as never);
    expect(suspendedSnapshot?.status).toBe('suspended');
    expect((suspendedSnapshot?.state as { phase?: string }).phase).toBe('suspended');
    expect((suspendedSnapshot?.state as { error?: { code?: string } }).error?.code).toBe(
      'AGENT_TOOL_APPROVAL_DENIED',
    );

    approved = true;
    await kernel.resumeProcess('run-suspend' as never);

    expect((await kernel.tick()).signal).toBe('WAITING_SYSCALL');
    expect(await drainWaitingAgentSyscalls(kernel, runtime)).toBe(true);
    expect((await kernel.tick()).signal).toBe('WAITING_SYSCALL');
    expect(await drainWaitingAgentSyscalls(kernel, runtime)).toBe(true);

    expect((await kernel.tick()).signal).toBe('WAITING_SYSCALL');
    expect(await drainWaitingAgentSyscalls(kernel, runtime)).toBe(true);

    const completedTick = await kernel.tick();
    expect(completedTick.signal).toBe('DONE');

    const completedSnapshot = kernel.getSnapshot('run-suspend' as never);
    expect(completedSnapshot?.status).toBe('done');
    expect((completedSnapshot?.state as { result?: { text?: string } }).result?.text).toContain(
      'tool loop completed',
    );
  });

  it('requires approval when the tool enforces approval locally', async () => {
    const dataDir = await createTempDir();
    const runner = createRunnerWithProvider(dataDir, new FakeToolLoopProvider(), {
      approvalHandler: async () => true,
      toolApprovalMode: 'always',
    });
    const runtime = new AgentTurnProcessRuntime(new Map([['agent-main', runner]]));

    const initialState = runtime.createInitialState({
      agentId: 'agent-main',
      runId: 'run-tool-approval-always',
      userMessage: 'tool-local approval',
      threadKey: 'tool-local-approval-thread',
    });

    const prepared = await runtime.step(initialState, {
      pid: 'pid-tool-approval-always' as never,
      now: Date.now(),
      runCount: 0,
      retryCount: 0,
      metadata: {},
    });
    expect(prepared.signal).toBe('YIELD');

    const waitLlm = await runtime.step(prepared.state, {
      pid: 'pid-tool-approval-always' as never,
      now: Date.now(),
      runCount: 1,
      retryCount: 0,
      metadata: {},
    });
    expect(waitLlm.signal).toBe('WAITING_SYSCALL');
    if (!waitLlm.syscall) {
      throw new Error('expected llm syscall');
    }

    const llmResolution = await runtime.executePendingSyscall(
      waitLlm.state,
      waitLlm.syscall,
      Date.now(),
    );
    const waitApproval = await runtime.step(waitLlm.state, {
      pid: 'pid-tool-approval-always' as never,
      now: Date.now(),
      runCount: 2,
      retryCount: 0,
      lastSyscallResult: llmResolution,
      metadata: {},
    });

    expect(waitApproval.signal).toBe('WAITING_SYSCALL');
    expect(waitApproval.state.phase).toBe('waiting_approval');
    expect(waitApproval.syscall?.operation).toBe('agent.turn.approval-request');
  });

  it('skips agent approval when the tool disables approval locally', async () => {
    const dataDir = await createTempDir();
    const runner = createRunnerWithProvider(dataDir, new FakeToolLoopProvider(), {
      approval: ['echo_tool'],
      approvalHandler: async () => false,
      toolApprovalMode: 'never',
    });
    const runtime = new AgentTurnProcessRuntime(new Map([['agent-main', runner]]));

    const initialState = runtime.createInitialState({
      agentId: 'agent-main',
      runId: 'run-tool-approval-never',
      userMessage: 'tool-local no approval',
      threadKey: 'tool-local-no-approval-thread',
    });

    const prepared = await runtime.step(initialState, {
      pid: 'pid-tool-approval-never' as never,
      now: Date.now(),
      runCount: 0,
      retryCount: 0,
      metadata: {},
    });
    expect(prepared.signal).toBe('YIELD');

    const waitLlm = await runtime.step(prepared.state, {
      pid: 'pid-tool-approval-never' as never,
      now: Date.now(),
      runCount: 1,
      retryCount: 0,
      metadata: {},
    });
    expect(waitLlm.signal).toBe('WAITING_SYSCALL');
    if (!waitLlm.syscall) {
      throw new Error('expected llm syscall');
    }

    const llmResolution = await runtime.executePendingSyscall(
      waitLlm.state,
      waitLlm.syscall,
      Date.now(),
    );
    const waitTool = await runtime.step(waitLlm.state, {
      pid: 'pid-tool-approval-never' as never,
      now: Date.now(),
      runCount: 2,
      retryCount: 0,
      lastSyscallResult: llmResolution,
      metadata: {},
    });

    expect(waitTool.signal).toBe('WAITING_SYSCALL');
    expect(waitTool.state.phase).toBe('waiting_tool');
    expect(waitTool.syscall?.operation).toBe('agent.turn.tool-call-batch');
  });

  it('restores a partially completed turn from checkpoints and finishes on a new kernel instance', async () => {
    const dataDir = await createTempDir();
    const createRuntime = (): AgentTurnProcessRuntime =>
      new AgentTurnProcessRuntime(
        new Map([['agent-main', createRunnerWithProvider(dataDir, new FakeToolLoopProvider())]]),
      );

    const checkpointStore = new JsonFileCheckpointStore(dataDir);
    const kernel = new AgentKernel({ checkpointStore, now: () => 1000 });
    const runtime = createRuntime();
    kernel.registerProcessRuntime(runtime);

    const created = await kernel.createProcess({
      processType: 'agent.turn',
      input: {
        agentId: 'agent-main',
        runId: 'restore-run',
        userMessage: 'recover me',
        threadKey: 'restore-thread',
      },
    });

    const begin = await kernel.tick();
    expect(begin.signal).toBe('YIELD');

    const partial = await kernel.tick();
    expect(partial.signal).toBe('WAITING_SYSCALL');

    const beforeRestart = kernel.getSnapshot(created.pid);
    expect(beforeRestart?.status).toBe('waiting');

    const restoredKernel = new AgentKernel({ checkpointStore, now: () => 1000 });
    const restoredRuntime = createRuntime();
    restoredKernel.registerProcessRuntime(restoredRuntime);
    const restoredCount = await restoredKernel.restoreFromCheckpoints();
    expect(restoredCount).toBe(1);

    const restoredSnapshot = restoredKernel.getSnapshot(created.pid);
    expect(restoredSnapshot?.pendingSyscall?.kind).toBe('llm.generate');
    if (!restoredSnapshot) {
      throw new Error('expected restored snapshot');
    }
    const restoredPendingSyscall = restoredSnapshot.pendingSyscall;
    if (!restoredPendingSyscall) {
      throw new Error('expected restored pending syscall');
    }
    const resolution = await restoredRuntime.executePendingSyscall(
      restoredRuntime.deserialize(restoredSnapshot.state),
      restoredPendingSyscall,
      1000,
    );
    await restoredKernel.resolveSyscall(created.pid, resolution);

    const resumed = await restoredKernel.tick();
    expect(resumed.signal).toBe('WAITING_SYSCALL');

    const toolSnapshot = restoredKernel.getSnapshot(created.pid);
    expect(toolSnapshot?.pendingSyscall?.kind).toBe('tool.call');
    if (!toolSnapshot) {
      throw new Error('expected tool snapshot');
    }
    const toolPendingSyscall = toolSnapshot.pendingSyscall;
    if (!toolPendingSyscall) {
      throw new Error('expected tool pending syscall');
    }
    const toolResolution = await restoredRuntime.executePendingSyscall(
      restoredRuntime.deserialize(toolSnapshot.state),
      toolPendingSyscall,
      1000,
    );
    await restoredKernel.resolveSyscall(created.pid, toolResolution);

    const done = await restoredKernel.tick();
    expect(done.signal).toBe('WAITING_SYSCALL');

    const finalLlmSnapshot = restoredKernel.getSnapshot(created.pid);
    expect(finalLlmSnapshot?.pendingSyscall?.kind).toBe('llm.generate');
    if (!finalLlmSnapshot) {
      throw new Error('expected final llm snapshot');
    }
    const finalLlmPending = finalLlmSnapshot.pendingSyscall;
    if (!finalLlmPending) {
      throw new Error('expected final llm pending syscall');
    }
    const finalLlmResolution = await restoredRuntime.executePendingSyscall(
      restoredRuntime.deserialize(finalLlmSnapshot.state),
      finalLlmPending,
      1000,
    );
    await restoredKernel.resolveSyscall(created.pid, finalLlmResolution);

    const finished = await restoredKernel.tick();
    expect(finished.signal).toBe('DONE');

    const finalSnapshot = restoredKernel.getSnapshot(created.pid);
    expect(finalSnapshot?.status).toBe('done');

    const finalState = createRuntime().deserialize(finalSnapshot?.state) as {
      phase: string;
      result?: { text: string; sessionKey: string };
    };
    expect(finalState.phase).toBe('done');
    expect(finalState.result?.text).toContain('tool loop completed');
    expect(finalState.result?.sessionKey).toContain('restore-thread');
  });

  it('suspends on LLM quota failure and resumes after the provider recovers', async () => {
    const dataDir = await createTempDir();
    let blocked = true;
    const runtime = new AgentTurnProcessRuntime(
      new Map([
        [
          'agent-main',
          createRunnerWithProvider(dataDir, new FakeBlockedLlmProvider(() => blocked)),
        ],
      ]),
    );
    const kernel = new AgentKernel({
      checkpointStore: new JsonFileCheckpointStore(dataDir),
    });
    kernel.registerProcessRuntime(runtime);

    await kernel.createProcess({
      processType: runtime.type,
      processId: 'run-llm-suspend' as never,
      metadata: { agentId: 'agent-main' },
      input: {
        agentId: 'agent-main',
        runId: 'run-llm-suspend',
        userMessage: 'trigger quota block',
        threadKey: 'llm-suspend-thread',
      },
    });

    expect((await kernel.tick()).signal).toBe('YIELD');
    expect((await kernel.tick()).signal).toBe('WAITING_SYSCALL');
    expect(await drainWaitingAgentSyscalls(kernel, runtime)).toBe(true);

    const suspendedTick = await kernel.tick();
    expect(suspendedTick.signal).toBe('SUSPENDED');

    const suspendedSnapshot = kernel.getSnapshot('run-llm-suspend' as never);
    expect(suspendedSnapshot?.status).toBe('suspended');
    expect((suspendedSnapshot?.state as { phase?: string }).phase).toBe('suspended');
    expect((suspendedSnapshot?.state as { error?: { code?: string } }).error?.code).toBe(
      'AGENT_LLM_RESOURCE_BLOCKED',
    );

    blocked = false;
    await kernel.resumeProcess('run-llm-suspend' as never);

    expect((await kernel.tick()).signal).toBe('WAITING_SYSCALL');
    expect(await drainWaitingAgentSyscalls(kernel, runtime)).toBe(true);

    const completedTick = await kernel.tick();
    expect(completedTick.signal).toBe('DONE');

    const completedSnapshot = kernel.getSnapshot('run-llm-suspend' as never);
    expect(completedSnapshot?.status).toBe('done');
    expect((completedSnapshot?.state as { result?: { text?: string } }).result?.text).toContain(
      'quota recovered',
    );
  });
});
