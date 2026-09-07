import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionMetaStore } from '../core/session/meta.js';
import { SessionStore } from '../core/session/store.js';
import type { StreamChunk } from '../core/types.js';
import {
  cancelAgentTurnViaKernel,
  executeAgentTurnViaKernel,
  getAgentTurnRunViaKernel,
  resumeAgentTurnViaKernel,
  startAgentTurnViaKernel,
} from './kernel-turn-executor.js';
import type { LLMProvider, RunParams } from './llm/provider.js';
import { AgentRunner } from './runner.js';
import { ToolRegistry } from './tools/registry.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentflyer-kernel-turn-executor-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeProvider implements LLMProvider {
  constructor(private readonly responseText: string) {}

  readonly id = 'fake';

  async *run(_params: RunParams): AsyncIterable<StreamChunk> {
    yield { type: 'text_delta', text: this.responseText };
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

class HangingProvider implements LLMProvider {
  readonly id = 'hanging';

  async *run(_params: RunParams): AsyncIterable<StreamChunk> {
    await new Promise<never>(() => undefined);
  }

  async countTokens(): Promise<number> {
    return 0;
  }

  supports(): boolean {
    return true;
  }
}

class DelayedProvider implements LLMProvider {
  readonly id = 'delayed';
  readonly started: Promise<void>;
  private markStarted!: () => void;

  constructor(private readonly delayMs: number) {
    this.started = new Promise<void>((resolve) => {
      this.markStarted = resolve;
    });
  }

  async *run(_params: RunParams): AsyncIterable<StreamChunk> {
    this.markStarted();
    await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    yield { type: 'text_delta', text: 'delayed response' };
    yield { type: 'done', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' };
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

function createRunner(
  dataDir: string,
  agentId = 'agent-main',
  provider?: LLMProvider,
): AgentRunner {
  return new AgentRunner(
    {
      id: agentId,
      name: agentId === 'agent-main' ? 'Agent Main' : 'Agent Alt',
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
      tools: { allow: [], deny: [], approval: [], maxRounds: 4 },
      persona: { language: 'zh-CN', outputDir: 'output' },
    },
    {
      provider: provider ?? new FakeProvider(`hello from ${agentId}`),
      toolRegistry: new ToolRegistry(),
      sessionStore: new SessionStore(join(dataDir, 'sessions')),
      metaStore: new SessionMetaStore(join(dataDir, 'sessions')),
      skillsText: '',
    },
  );
}

async function waitForRunPhase(
  dataDir: string,
  runners: Map<string, AgentRunner>,
  runId: string,
  phase: 'suspended' | 'done',
): Promise<{
  phase: 'suspended' | 'done';
  controlState?: string;
  error?: { code?: string };
  result?: { text?: string };
}> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const run = await getAgentTurnRunViaKernel({ dataDir, runners, runId });
    if (run?.phase === phase) {
      return run as {
        phase: 'suspended' | 'done';
        controlState?: string;
        error?: { code?: string };
        result?: { text?: string };
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for run ${runId} to reach phase ${phase}`);
}

describe('executeAgentTurnViaKernel', () => {
  it('returns null when cancelling an unknown run', async () => {
    const dataDir = await createTempDir();

    await expect(
      cancelAgentTurnViaKernel({
        runners: new Map(),
        dataDir,
        runId: 'missing-run',
      }),
    ).resolves.toBeNull();
  });

  it('returns a noop result when cancelling a completed run', async () => {
    const dataDir = await createTempDir();
    const runner = createRunner(dataDir);
    const runners = new Map([['agent-main', runner]]);
    const started = await startAgentTurnViaKernel({
      runners,
      dataDir,
      input: {
        agentId: 'agent-main',
        userMessage: 'complete before cancellation',
        threadKey: 'executor-cancel-terminal',
      },
    });
    await waitForRunPhase(dataDir, runners, started.runId, 'done');

    const cancelled = await cancelAgentTurnViaKernel({
      runners,
      dataDir,
      runId: started.runId,
      message: 'cancel after completion',
    });

    expect(cancelled).toMatchObject({
      cancelled: false,
      runId: started.runId,
      mode: 'noop',
      reason: 'Run is already terminal.',
    });
  });

  it('runs a single agent turn through the kernel helper', async () => {
    const dataDir = await createTempDir();
    const runner = createRunner(dataDir);

    const result = await executeAgentTurnViaKernel({
      runners: new Map([['agent-main', runner]]),
      dataDir,
      input: {
        agentId: 'agent-main',
        userMessage: 'hello',
        threadKey: 'executor-thread',
      },
    });

    expect(result.text).toContain('hello from agent-main');
    expect(result.sessionKey).toContain('executor-thread');
  });

  it('does not overwrite the runner default thread after an explicit kernel turn', async () => {
    const dataDir = await createTempDir();
    const runner = createRunner(dataDir);
    runner.setDefaultThread('operator-default-thread');

    const result = await executeAgentTurnViaKernel({
      runners: new Map([['agent-main', runner]]),
      dataDir,
      input: {
        agentId: 'agent-main',
        userMessage: 'hello isolated thread',
        threadKey: 'executor-isolated-thread',
      },
    });

    expect(result.sessionKey).toContain('executor-isolated-thread');
    expect(runner.defaultSessionKey).toContain('operator-default-thread');
    expect(runner.serializeState().defaultThreadKey).toBe('operator-default-thread');
  });

  it('reuses one shared executor per dataDir across multiple agents', async () => {
    const dataDir = await createTempDir();
    const mainRunner = createRunner(dataDir, 'agent-main');
    const altRunner = createRunner(dataDir, 'agent-alt');
    const runners = new Map([
      ['agent-main', mainRunner],
      ['agent-alt', altRunner],
    ]);

    const [mainResult, altResult] = await Promise.all([
      executeAgentTurnViaKernel({
        runners,
        dataDir,
        input: {
          agentId: 'agent-main',
          userMessage: 'hello main',
          threadKey: 'executor-main',
        },
      }),
      executeAgentTurnViaKernel({
        runners,
        dataDir,
        input: {
          agentId: 'agent-alt',
          userMessage: 'hello alt',
          threadKey: 'executor-alt',
        },
      }),
    ]);

    expect(mainResult.text).toContain('hello from agent-main');
    expect(mainResult.sessionKey).toContain('executor-main');
    expect(altResult.text).toContain('hello from agent-alt');
    expect(altResult.sessionKey).toContain('executor-alt');
  });

  it('keeps concurrent narrow runner maps isolated per agent', async () => {
    const dataDir = await createTempDir();
    const mainRunner = createRunner(dataDir, 'agent-main');
    const altRunner = createRunner(dataDir, 'agent-alt');

    const [mainResult, altResult] = await Promise.all([
      executeAgentTurnViaKernel({
        runners: new Map([['agent-main', mainRunner]]),
        dataDir,
        input: {
          agentId: 'agent-main',
          userMessage: 'hello main narrow',
          threadKey: 'executor-main-narrow',
        },
      }),
      executeAgentTurnViaKernel({
        runners: new Map([['agent-alt', altRunner]]),
        dataDir,
        input: {
          agentId: 'agent-alt',
          userMessage: 'hello alt narrow',
          threadKey: 'executor-alt-narrow',
        },
      }),
    ]);

    expect(mainResult.text).toContain('hello from agent-main');
    expect(mainResult.sessionKey).toContain('executor-main-narrow');
    expect(altResult.text).toContain('hello from agent-alt');
    expect(altResult.sessionKey).toContain('executor-alt-narrow');
  });

  it('does not let a slow syscall block another agent turn', async () => {
    const dataDir = await createTempDir();
    const delayedProvider = new DelayedProvider(200);
    const runners = new Map([
      ['agent-main', createRunner(dataDir, 'agent-main', delayedProvider)],
      ['agent-alt', createRunner(dataDir, 'agent-alt')],
    ]);
    const slowTurn = executeAgentTurnViaKernel({
      runners,
      dataDir,
      input: {
        agentId: 'agent-main',
        userMessage: 'slow turn',
        threadKey: 'executor-slow',
      },
    });
    await delayedProvider.started;

    const fastTurn = executeAgentTurnViaKernel({
      runners,
      dataDir,
      input: {
        agentId: 'agent-alt',
        userMessage: 'fast turn',
        threadKey: 'executor-fast',
      },
    });
    const fastResult = await Promise.race([
      fastTurn,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('fast turn was blocked by slow syscall')), 120),
      ),
    ]);

    expect(fastResult.text).toContain('hello from agent-alt');
    await slowTurn;
  });

  it('aborts timed out kernel turns and releases the runner lease', async () => {
    const dataDir = await createTempDir();
    const runner = createRunner(dataDir, 'agent-main', new HangingProvider());

    await expect(
      executeAgentTurnViaKernel({
        runners: new Map([['agent-main', runner]]),
        timeoutMs: 20,
        input: {
          agentId: 'agent-main',
          userMessage: 'hang forever',
          threadKey: 'executor-timeout',
        },
      }),
    ).rejects.toThrow("Agent 'agent-main' turn timed out after 20ms");

    expect(runner.isRunning).toBe(false);
  });

  it('exposes suspended runs and resumes them through runId control', async () => {
    const dataDir = await createTempDir();
    let blocked = true;
    const provider = new FakeRecoverableBlockedLlmProvider(() => blocked);
    const runners = new Map([['agent-main', createRunner(dataDir, 'agent-main', provider)]]);

    const started = await startAgentTurnViaKernel({
      runners,
      dataDir,
      input: {
        agentId: 'agent-main',
        userMessage: 'resume after quota recovery',
        threadKey: 'executor-resume-thread',
      },
    });

    const suspended = await waitForRunPhase(dataDir, runners, started.runId, 'suspended');
    expect(suspended.error?.code).toBe('AGENT_LLM_RESOURCE_BLOCKED');
    expect(suspended.controlState).toBe('suspended');

    const suspendedMeta = (await new SessionMetaStore(join(dataDir, 'sessions')).listAll())[0];
    expect(suspendedMeta?.status).toBe('suspended');
    expect(suspendedMeta?.errorCode).toBe('billing');

    blocked = false;
    const resumed = await resumeAgentTurnViaKernel({
      runners,
      dataDir,
      runId: started.runId,
    });
    expect(resumed?.processStatus).toBe('ready');
    expect(resumed?.controlState).toBe('ready');

    const completed = await waitForRunPhase(dataDir, runners, started.runId, 'done');
    expect(completed.result?.text).toContain('quota recovered');

    const resumedMeta = (await new SessionMetaStore(join(dataDir, 'sessions')).listAll())[0];
    expect(resumedMeta?.status).toBe('idle');
    expect(resumedMeta?.errorCode).toBeUndefined();
  });
});
