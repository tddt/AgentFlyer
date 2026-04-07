import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { AgentConfig } from '../core/config/schema.js';
import type { ProcessErrorEvent, SyscallRequest, SyscallResolution } from '../core/kernel/types.js';
import { createLogger } from '../core/logger.js';
import type { SessionMetaStore } from '../core/session/meta.js';
import type { SessionErrorCode } from '../core/session/meta.js';
import type { SessionStore, StoredMessage } from '../core/session/store.js';
import type {
  AgentId,
  Message,
  SessionKey,
  StreamChunk,
  ThreadKey,
  ToolCallResult,
  ToolDefinition,
  ToolResultContent,
  ToolUseContent,
} from '../core/types.js';
import { asAgentId, asThreadKey, makeSessionKey } from '../core/types.js';
import type { MemoryOrganizer } from '../memory/organizer.js';
import type { MemoryStore } from '../memory/store.js';
import { checkCompactionNeeded, runCompaction } from './compactor/index.js';
import { classifyAgentFailure } from './llm/error-classification.js';
import type { LLMProvider, RunParams } from './llm/provider.js';
import { isRecoverableStreamError } from './llm/stream-error.js';
import { buildSystemPrompt } from './prompt/builder.js';
import { layer0Identity, layer1Workspace, layer2Skills, layer3Memory } from './prompt/layers.js';
import { buildPersonaContent } from './prompt/soul.js';
import { readWorkspaceDocCached } from './prompt/workspace.js';
import { recordTokenBill } from './stats.js';
import { type SerializedToolLoopDetectorState, ToolLoopDetector } from './tools/loop-detection.js';
import {
  type ApprovalHandler,
  type PolicyEnforcedResult,
  type ToolPolicy,
  checkPolicy,
  filterAllowedTools,
  policyBlockedResult,
} from './tools/policy.js';
import type { ToolRegistry } from './tools/registry.js';

const logger = createLogger('agent:runner');

/** Read-only tools whose results can safely be cached within a thread. */
const READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_dir',
  'search_files',
  'memory_search',
  'grep_search',
]);

/** Mutation tools that invalidate the read-only tool result cache. */
const MUTATION_TOOLS = new Set(['write_file', 'create_file', 'edit_file', 'bash', 'run_terminal']);
const MAX_RECOVERABLE_STREAM_RETRIES = 1;
const RECOVERABLE_STREAM_RETRY_DELAY_MS = 1200;

function normalizeFailureSummary(message: string): string {
  const trimmed = message.replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
  if (!trimmed) return '发生未知错误';
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
}

function formatFailureReply(message: string): string {
  return `⚠️ 任务执行失败：${normalizeFailureSummary(message)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Remove messages that violate OpenAI's tool_call sequencing rules.
 * Two classes of violation are handled:
 *
 * A) Orphaned assistant tool_calls — an assistant message has tool_call entries but
 *    the immediately following message does not supply matching tool_results for all
 *    of them (e.g. after a crash mid-turn).  The assistant message AND the partial
 *    tool_result reply (if any) are both dropped.
 *
 * B) Orphaned tool_results — a user message carries tool_result entries but the
 *    previous accepted message is not an assistant message with matching tool_calls
 *    (e.g. the assistant message was dropped by case A in an earlier pass).
 *
 * The function iterates until no further changes occur so that cascading orphans
 * created by earlier removals are also eliminated.
 */
function sanitizeMessages(messages: Message[]): Message[] {
  type MC = import('../core/types.js').MessageContent;
  type TUC = import('../core/types.js').ToolUseContent;
  type TRC = import('../core/types.js').ToolResultContent;

  const isToolResultMsg = (m: Message): boolean =>
    m.role === 'user' &&
    Array.isArray(m.content) &&
    (m.content as MC[]).some((c) => c.type === 'tool_result');

  let current = messages;

  // Iterate until stable (cascading orphans)
  for (let pass = 0; pass < 10; pass++) {
    const out: Message[] = [];
    let changed = false;
    let i = 0;

    while (i < current.length) {
      const msg = current[i];
      if (!msg) {
        i++;
        continue;
      }

      // ── Case A: assistant with tool_calls missing matching tool_results ──
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const toolCalls = (msg.content as MC[]).filter((c) => c.type === 'tool_use') as TUC[];
        if (toolCalls.length > 0) {
          const next = current[i + 1];
          const resultIds = new Set(
            next?.role === 'user' && Array.isArray(next.content)
              ? (next.content as MC[])
                  .filter((c) => c.type === 'tool_result')
                  .map((c) => (c as TRC).tool_use_id)
              : [],
          );
          const allPresent = toolCalls.every((tc) => resultIds.has(tc.id));
          if (!allPresent) {
            logger.warn('Dropping orphaned assistant tool_calls', {
              toolCallIds: toolCalls.map((t) => t.id),
            });
            changed = true;
            // Skip the following tool_result message too if present
            if (next && isToolResultMsg(next)) i++;
            i++;
            continue;
          }
        }
      }

      // ── Case B: tool_results without matching preceding tool_calls ────────
      if (isToolResultMsg(msg)) {
        const prev = out[out.length - 1];
        const prevToolCalls =
          prev?.role === 'assistant' && Array.isArray(prev.content)
            ? ((prev.content as MC[]).filter((c) => c.type === 'tool_use') as TUC[])
            : [];
        const callIds = new Set(prevToolCalls.map((tc) => tc.id));
        const resultIds = (
          (msg.content as MC[]).filter((c) => c.type === 'tool_result') as TRC[]
        ).map((c) => c.tool_use_id);
        const allHaveMatch = resultIds.length > 0 && resultIds.every((id) => callIds.has(id));
        if (!allHaveMatch) {
          logger.warn('Dropping orphaned tool_results', { resultIds });
          changed = true;
          i++;
          continue;
        }
      }

      out.push(msg);
      i++;
    }

    current = out;
    if (!changed) break;
  }

  if (current.length < messages.length) {
    logger.info('Session history sanitized', {
      before: messages.length,
      after: current.length,
      dropped: messages.length - current.length,
    });
  }
  return current;
}

export interface RunnerDeps {
  provider: LLMProvider;
  toolRegistry: ToolRegistry;
  sessionStore: SessionStore;
  metaStore: SessionMetaStore;
  approvalHandler?: ApprovalHandler;
  /** Resolved model info from config.models registry at agent startup. */
  resolvedModel?: { id: string; maxTokens: number; temperature?: number };
  /** Pre-built skills directory text for Layer 2 (injected at runner construction). */
  skillsText?: string;
  /** Max tokens for the system prompt (from config.context.systemPrompt.maxTokens). */
  systemPromptMaxTokens?: number;
  /** Path to the ~/.agentflyer data directory for TokenBill stats (optional). */
  dataDir?: string;
  /** Optional memory organizer — called once per turn to trigger periodic consolidation (E3.2). */
  memoryOrganizer?: MemoryOrganizer;
  /**
   * Memory store — used to auto-fetch relevant context before each turn.
   * RATIONALE: runners hold a direct store reference so they can BM25-search
   * without going through the tool layer (which requires an LLM call).
   */
  memoryStore?: MemoryStore;
}

export interface RunnerOptions {
  /** Override the model from config. */
  model?: string;
  /** Max tokens per LLM completion. */
  maxTokens?: number;
  /** Inject extra task context into layer 4. */
  taskContext?: string;
  /** Pre-built skills text for layer 2. */
  skillsText?: string;
  /** Pre-retrieved memory text for layer 3. */
  memoryText?: string;
}

export interface TurnResult {
  sessionKey: SessionKey;
  /** Final text output accumulated from the stream. */
  text: string;
  /** Total tokens used in this turn. */
  inputTokens: number;
  outputTokens: number;
}

export interface SerializedToolResultCacheEntry {
  key: string;
  value: ToolCallResult;
}

export interface SerializedAgentRunnerState {
  threadKey: string;
  promptLayerHashes: Array<[number, string]>;
  cachedSystemPrompt: string | null;
  toolResultCache: SerializedToolResultCacheEntry[];
  activeKernelRunId: string | null;
}

export interface SerializedPendingToolCall {
  id: string;
  name: string;
  inputJson: string;
}

export interface SerializedToolSyscallResult {
  toolUseId: string;
  content: string;
  isError: boolean;
}

export interface SerializedToolSyscallPayload {
  results: SerializedToolSyscallResult[];
  runnerState: SerializedAgentRunnerState;
}

export interface SerializedLlmSyscallPayload {
  chunks: StreamChunk[];
  recoverableStreamRetries: number;
}

export interface SerializedApprovalSyscallDecision {
  toolUseId: string;
  approved: boolean;
}

export interface SerializedApprovalSyscallPayload {
  decisions: SerializedApprovalSyscallDecision[];
}

export interface SerializedAgentTurnExecutionState {
  runId: string;
  userMessage: string;
  options?: RunnerOptions;
  model: string;
  maxTokens: number;
  systemPrompt: string;
  messages: Message[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalText: string;
  toolRounds: number;
  toolFailureMessages: string[];
  finalFailureMessage: string | null;
  finalFailureCode?: SessionErrorCode;
  recoverableStreamRetries: number;
  toolLoopDetector: SerializedToolLoopDetectorState;
  pendingToolCalls?: SerializedPendingToolCall[];
}

export interface KernelTurnStepResult {
  state: SerializedAgentTurnExecutionState;
  chunks: StreamChunk[];
  done: boolean;
  result?: TurnResult;
  syscall?: SyscallRequest;
  suspended?: ProcessErrorEvent;
  nextRunAt?: number;
}

function parseToolCallInput(inputJson: string): unknown {
  try {
    return JSON.parse(inputJson || '{}');
  } catch {
    return {};
  }
}

function buildToolCallSyscall(
  runId: string,
  pendingToolCalls: SerializedPendingToolCall[],
): SyscallRequest {
  return {
    id: `tool-call:${runId}:${ulid()}`,
    kind: 'tool.call',
    operation: 'agent.turn.tool-call-batch',
    payload: {
      runId,
      toolCalls: pendingToolCalls,
    },
    createdAt: Date.now(),
  };
}

function buildLlmGenerateSyscall(
  state: SerializedAgentTurnExecutionState,
  toolCount: number,
): SyscallRequest {
  return {
    id: `llm-generate:${state.runId}:${ulid()}`,
    kind: 'llm.generate',
    operation: 'agent.turn.generate',
    payload: {
      runId: state.runId,
      model: state.model,
      maxTokens: state.maxTokens,
      messageCount: state.messages.length,
      toolCount,
    },
    createdAt: Date.now(),
  };
}

function buildApprovalRequestSyscall(
  state: SerializedAgentTurnExecutionState,
  pendingToolCalls: SerializedPendingToolCall[],
): SyscallRequest {
  return {
    id: `approval-request:${state.runId}:${ulid()}`,
    kind: 'custom',
    operation: 'agent.turn.approval-request',
    payload: {
      runId: state.runId,
      toolCalls: pendingToolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        input: parseToolCallInput(toolCall.inputJson),
      })),
    },
    createdAt: Date.now(),
  };
}

function buildSuspendedError(code: string, message: string): ProcessErrorEvent {
  return {
    code,
    message,
    retryable: false,
  };
}

function toSuspendedSessionError(error: ProcessErrorEvent): {
  error: string;
  errorCode: SessionErrorCode;
} {
  if (error.code === 'AGENT_TOOL_APPROVAL_DENIED') {
    return {
      error: error.message,
      errorCode: 'approval_required',
    };
  }

  const failure = classifyAgentFailure(error.message);
  return {
    error: error.message,
    errorCode: failure.code,
  };
}

function shouldSuspendLlmFailureBeforeOutput(params: {
  failure: AgentFailureClassification;
  accumulatedText: string;
  toolUseCount: number;
}): boolean {
  return (
    params.failure.suspendableBeforeOutput &&
    params.accumulatedText.trim().length === 0 &&
    params.toolUseCount === 0
  );
}
import type { AgentFailureClassification } from './llm/error-classification.js';

/**
 * AgentRunner manages one conversation thread for a single agent.
 * All public methods are safe to call concurrently from different turns.
 */
export class AgentRunner {
  private agentId: AgentId;
  private threadKey: ThreadKey;
  private sessionKey: SessionKey;
  // RATIONALE: hash each base layer per turn to skip full buildSystemPrompt
  // when prompts layers are unchanged — avoids string trimming work.
  private promptLayerHashes = new Map<number, string>();
  private cachedSystemPrompt: string | null = null;
  // RATIONALE: cache read-only tool results within a thread to avoid
  // redundant I/O calls on repeated reads of the same file/query.
  private toolResultCache = new Map<string, unknown>();
  // RATIONALE: prevent concurrent turns from corrupting shared instance state
  // (threadKey, sessionKey, promptLayerHashes, toolResultCache). A single runner
  // processes one turn at a time; callers should check isRunning before calling.
  private _running = false;
  private activeKernelRunId: string | null = null;

  constructor(
    private readonly config: AgentConfig,
    private readonly deps: RunnerDeps,
  ) {
    this.agentId = asAgentId(config.id);
    this.threadKey = asThreadKey('default');
    this.sessionKey = makeSessionKey(this.agentId, this.threadKey);
  }

  /** Change the active thread (creates a new session file). */
  setThread(threadKey: string): void {
    this.threadKey = asThreadKey(threadKey);
    this.sessionKey = makeSessionKey(this.agentId, this.threadKey);
    this.promptLayerHashes.clear();
    this.cachedSystemPrompt = null;
    this.toolResultCache.clear();
  }

  serializeState(): SerializedAgentRunnerState {
    return {
      threadKey: this.threadKey,
      promptLayerHashes: Array.from(this.promptLayerHashes.entries()),
      cachedSystemPrompt: this.cachedSystemPrompt,
      toolResultCache: Array.from(this.toolResultCache.entries()).map(([key, value]) => ({
        key,
        value: value as ToolCallResult,
      })),
      activeKernelRunId: this.activeKernelRunId,
    };
  }

  restoreState(state: SerializedAgentRunnerState): void {
    this.threadKey = asThreadKey(state.threadKey);
    this.sessionKey = makeSessionKey(this.agentId, this.threadKey);
    this.promptLayerHashes = new Map(state.promptLayerHashes);
    this.cachedSystemPrompt = state.cachedSystemPrompt;
    this.toolResultCache = new Map(
      state.toolResultCache.map(
        (entry) => [entry.key, entry.value] satisfies [string, ToolCallResult],
      ),
    );
    this.activeKernelRunId = state.activeKernelRunId;
    this._running = false;
  }

  get currentSessionKey(): SessionKey {
    return this.sessionKey;
  }

  /** True while a `turn()` is actively running. Check this before dispatching a new task. */
  get isRunning(): boolean {
    return this._running || this.activeKernelRunId !== null;
  }

  /** Return the current tool catalog registered for this runner. */
  listTools(): Array<ToolDefinition & { category: string }> {
    return this.deps.toolRegistry.list().map((tool) => ({
      ...tool.definition,
      category: tool.category,
    }));
  }

  /**
   * Force-clear the busy flag after an orphaned turn (e.g. LLM provider unreachable).
   * Only call when you are certain the previous turn will never complete.
   */
  forceReset(): void {
    if (this._running || this.activeKernelRunId !== null) {
      logger.warn('AgentRunner.forceReset(): clearing orphaned running flag', {
        agentId: this.agentId,
      });
      this._running = false;
      this.activeKernelRunId = null;
    }
  }

  private buildPermittedToolDefinitions(): ToolDefinition[] {
    const allToolsWithCategory = this.deps.toolRegistry.list();
    const agentPolicy: ToolPolicy = {
      allowlist: this.config.tools.allow,
      denylist: this.config.tools.deny,
      requireApproval: this.config.tools.approval,
    };
    const permittedNames = new Set(
      allToolsWithCategory
        .filter((tool) => {
          if (tool.category === 'skill') {
            return !agentPolicy.denylist.includes(tool.definition.name);
          }
          return filterAllowedTools([tool.definition.name], agentPolicy).length > 0;
        })
        .map((tool) => tool.definition.name),
    );
    return allToolsWithCategory
      .map((tool) => tool.definition)
      .filter((definition) => permittedNames.has(definition.name));
  }

  private getToolPolicyResult(toolName: string): PolicyEnforcedResult {
    const tools = this.config.tools;
    const isSkillTool = this.deps.toolRegistry.get(toolName)?.category === 'skill';
    const effectiveAllowlist = isSkillTool ? undefined : tools.allow;
    return checkPolicy(toolName, {
      allowlist: effectiveAllowlist,
      denylist: tools.deny,
      requireApproval: tools.approval,
    });
  }

  private hasApprovalPending(pendingToolCalls: SerializedPendingToolCall[]): boolean {
    return pendingToolCalls.some(
      (toolCall) => this.getToolPolicyResult(toolCall.name).requiresApproval,
    );
  }

  private async runLlmGeneration(
    params: RunParams,
    initialRetries: number,
  ): Promise<{ chunks: StreamChunk[]; recoverableStreamRetries: number }> {
    return await this.runLlmGenerationAttempt(params, initialRetries);
  }

  private async runLlmGenerationAttempt(
    params: RunParams,
    recoverableStreamRetries: number,
  ): Promise<{ chunks: StreamChunk[]; recoverableStreamRetries: number }> {
    const { provider } = this.deps;
    const chunks: StreamChunk[] = [];
    let sawTextDelta = false;
    let sawToolUseDelta = false;
    let sawToolCall = false;
    let streamErrorMessage: string | null = null;

    try {
      for await (const chunk of provider.run(params)) {
        chunks.push(chunk);
        if (chunk.type === 'text_delta') {
          sawTextDelta = true;
        } else if (chunk.type === 'tool_use_delta') {
          sawToolUseDelta = true;
          sawToolCall = true;
        } else if (chunk.type === 'error') {
          logger.error('LLM error', { message: chunk.message });
          streamErrorMessage = chunk.message;
          break;
        }
      }
    } catch (error) {
      streamErrorMessage = error instanceof Error ? error.message : String(error);
      logger.error('LLM stream threw unexpectedly', {
        agentId: this.agentId,
        message: streamErrorMessage,
      });
    }

    const canRetryRecoverableStream =
      streamErrorMessage !== null &&
      !sawTextDelta &&
      !sawToolUseDelta &&
      !sawToolCall &&
      recoverableStreamRetries < MAX_RECOVERABLE_STREAM_RETRIES &&
      isRecoverableStreamError(streamErrorMessage);

    if (!canRetryRecoverableStream) {
      return { chunks, recoverableStreamRetries };
    }

    const nextRetryCount = recoverableStreamRetries + 1;
    logger.warn('Retrying recoverable LLM stream failure', {
      agentId: this.agentId,
      retry: nextRetryCount,
      delayMs: RECOVERABLE_STREAM_RETRY_DELAY_MS,
      message: streamErrorMessage,
    });
    await sleep(RECOVERABLE_STREAM_RETRY_DELAY_MS);
    return await this.runLlmGenerationAttempt(params, nextRetryCount);
  }

  async beginKernelTurn(
    runId: string,
    userMessage: string,
    opts: RunnerOptions = {},
  ): Promise<SerializedAgentTurnExecutionState> {
    if (this.isRunning) {
      throw new Error(`Agent '${this.agentId}' is already processing a turn`);
    }

    this.activeKernelRunId = runId;
    try {
      const { provider, sessionStore, metaStore } = this.deps;
      const configModel =
        typeof this.config.model === 'object' ? this.config.model.primary : this.config.model;
      const model = opts.model ?? this.deps.resolvedModel?.id ?? configModel ?? 'claude-haiku-3-5';
      const maxTokens = opts.maxTokens ?? this.deps.resolvedModel?.maxTokens ?? 8192;

      const agentName = this.config.name ?? this.agentId;
      const workspace = this.config.workspace;

      let workspaceDoc: string | null = null;
      if (workspace) {
        workspaceDoc = await readWorkspaceDocCached(workspace).catch(() => null);
      }

      const baseLayers = [
        layer0Identity(
          agentName,
          this.agentId,
          this.config.mesh?.role,
          buildPersonaContent(this.config),
        ),
        layer1Workspace(workspaceDoc ?? ''),
        layer2Skills(opts.skillsText ?? this.deps.skillsText ?? ''),
        layer3Memory(opts.memoryText ?? ''),
      ];
      const newLayerHashes = baseLayers.map((layer) =>
        createHash('sha256').update(layer.content).digest('hex').slice(0, 16),
      );
      const allBaseUnchanged =
        !opts.taskContext &&
        this.cachedSystemPrompt !== null &&
        newLayerHashes.every((hash, index) => this.promptLayerHashes.get(index) === hash);

      let systemPrompt: string;
      if (allBaseUnchanged) {
        if (this.cachedSystemPrompt === null) {
          throw new Error('cachedSystemPrompt missing while cache reuse is enabled');
        }
        systemPrompt = this.cachedSystemPrompt;
      } else {
        ({ systemPrompt } = buildSystemPrompt(
          [
            ...baseLayers,
            ...(opts.taskContext
              ? [
                  {
                    id: 4 as const,
                    name: 'task',
                    content: opts.taskContext,
                    estimatedTokens: 0,
                    trimable: true,
                  },
                ]
              : []),
          ],
          this.deps.systemPromptMaxTokens,
        ));
        newLayerHashes.forEach((hash, index) => this.promptLayerHashes.set(index, hash));
        this.cachedSystemPrompt = systemPrompt;
      }

      const history = await sessionStore.readAll(this.sessionKey);
      let messages: Message[] = sanitizeMessages(
        history
          .filter((entry) => entry.content != null)
          .map((entry) => ({
            role: entry.role,
            content: entry.content,
          })),
      );

      const userMsg: StoredMessage = {
        id: ulid(),
        sessionKey: this.sessionKey,
        role: 'user',
        content: userMessage,
        timestamp: Date.now(),
      };
      await sessionStore.append(this.sessionKey, userMsg);
      messages = [...messages, { role: 'user', content: userMessage }];

      const compactionCheck = checkCompactionNeeded(messages, { model });
      if (compactionCheck.shouldCompact) {
        logger.info('Compacting conversation', { sessionKey: this.sessionKey });
        const compacted = await runCompaction(messages, async (prompt) => {
          let text = '';
          for await (const chunk of provider.run({
            model,
            systemPrompt: '',
            messages: [{ role: 'user', content: prompt }],
            tools: [],
            maxTokens: 2048,
          })) {
            if (chunk.type === 'text_delta') {
              text += chunk.text;
            }
          }
          return text;
        });
        messages = [compacted.summaryMessage, ...compacted.keptMessages];
        await metaStore.update(this.sessionKey, {
          compactionCount: ((await metaStore.get(this.sessionKey))?.compactionCount ?? 0) + 1,
          lastCompactionAt: Date.now(),
        });
      }

      return {
        runId,
        userMessage,
        options: opts,
        model,
        maxTokens,
        systemPrompt,
        messages,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalText: '',
        toolRounds: 0,
        toolFailureMessages: [],
        finalFailureMessage: null,
        finalFailureCode: undefined,
        recoverableStreamRetries: 0,
        toolLoopDetector: { lastEntry: null, consecutiveRepeats: 0 },
        pendingToolCalls: undefined,
      };
    } catch (error) {
      this.activeKernelRunId = null;
      throw error;
    }
  }

  async continueKernelTurn(
    state: SerializedAgentTurnExecutionState,
  ): Promise<KernelTurnStepResult> {
    if (this.activeKernelRunId !== state.runId) {
      throw new Error(`Agent '${this.agentId}' kernel lease mismatch for run '${state.runId}'`);
    }
    if ((state.pendingToolCalls?.length ?? 0) > 0) {
      throw new Error(
        `Agent '${this.agentId}' is waiting for tool syscall resolution for run '${state.runId}'`,
      );
    }

    return {
      state,
      chunks: [],
      done: false,
      syscall: buildLlmGenerateSyscall(state, this.buildPermittedToolDefinitions().length),
    };
  }

  async resumeKernelTurn(state: SerializedAgentTurnExecutionState): Promise<KernelTurnStepResult> {
    if (this.activeKernelRunId !== state.runId) {
      throw new Error(`Agent '${this.agentId}' kernel lease mismatch for run '${state.runId}'`);
    }

    if ((state.pendingToolCalls?.length ?? 0) > 0) {
      if (this.hasApprovalPending(state.pendingToolCalls ?? [])) {
        return {
          state,
          chunks: [],
          done: false,
          syscall: buildApprovalRequestSyscall(state, state.pendingToolCalls ?? []),
        };
      }

      return {
        state,
        chunks: [],
        done: false,
        syscall: buildToolCallSyscall(state.runId, state.pendingToolCalls ?? []),
      };
    }

    return {
      state,
      chunks: [],
      done: false,
      syscall: buildLlmGenerateSyscall(state, this.buildPermittedToolDefinitions().length),
    };
  }

  async executeKernelLlmGenerateSyscall(
    state: SerializedAgentTurnExecutionState,
    request: SyscallRequest,
    resolvedAt: number,
  ): Promise<SyscallResolution> {
    if (request.kind !== 'llm.generate') {
      return {
        requestId: request.id,
        ok: false,
        error: {
          code: 'AGENT_LLM_SYSCALL_KIND_MISMATCH',
          message: `Unsupported syscall kind '${request.kind}' for agent llm execution`,
          retryable: false,
        },
        resolvedAt,
      };
    }

    const { chunks, recoverableStreamRetries } = await this.runLlmGeneration(
      {
        model: state.model,
        systemPrompt: state.systemPrompt,
        messages: state.messages,
        tools: this.buildPermittedToolDefinitions(),
        maxTokens: state.maxTokens,
        temperature: this.deps.resolvedModel?.temperature,
      },
      state.recoverableStreamRetries,
    );

    return {
      requestId: request.id,
      ok: true,
      payload: {
        chunks,
        recoverableStreamRetries,
      } satisfies SerializedLlmSyscallPayload,
      resolvedAt,
    };
  }

  async applyKernelLlmGenerateSyscall(
    state: SerializedAgentTurnExecutionState,
    resolution: SyscallResolution,
  ): Promise<KernelTurnStepResult> {
    const { sessionStore } = this.deps;
    const payload = resolution.payload as SerializedLlmSyscallPayload | undefined;
    const chunks = payload?.chunks ?? [];

    if (!resolution.ok) {
      state.finalFailureMessage = resolution.error?.message ?? 'LLM 调用执行失败';
      state.finalFailureCode = 'generic';
      return await this.finalizeKernelTurn(state, chunks);
    }

    const toolCallMap = new Map<string, { name: string; inputJson: string }>();
    let accText = '';
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' = 'end_turn';
    let streamErrorMessage: string | null = null;
    const indexToId = new Map<string, string>();

    for (const chunk of chunks) {
      if (chunk.type === 'text_delta') {
        accText += chunk.text;
      } else if (chunk.type === 'tool_use_delta') {
        const id = chunk.id || indexToId.get(chunk.name) || chunk.name;
        if (chunk.id) {
          indexToId.set(chunk.name, chunk.id);
        }
        const existing = toolCallMap.get(id) ?? { name: chunk.name, inputJson: '' };
        if (chunk.name && !existing.name) {
          existing.name = chunk.name;
        }
        existing.inputJson += chunk.inputJson;
        toolCallMap.set(id, existing);
      } else if (chunk.type === 'done') {
        state.totalInputTokens += chunk.inputTokens;
        state.totalOutputTokens += chunk.outputTokens;
        state.totalCacheReadTokens += chunk.cacheReadTokens ?? 0;
        stopReason = chunk.stopReason;
      } else if (chunk.type === 'error') {
        logger.error('LLM error', { message: chunk.message });
        streamErrorMessage = chunk.message;
      }
    }

    state.recoverableStreamRetries =
      payload?.recoverableStreamRetries ?? state.recoverableStreamRetries;
    state.totalText += accText;

    const assistantToolUse: ToolUseContent[] = [];
    for (const [id, toolCall] of toolCallMap) {
      assistantToolUse.push({
        type: 'tool_use',
        id,
        name: toolCall.name,
        input: parseToolCallInput(toolCall.inputJson),
      });
    }

    const assistantContent =
      assistantToolUse.length > 0
        ? [...(accText ? [{ type: 'text' as const, text: accText }] : []), ...assistantToolUse]
        : accText;

    if (assistantToolUse.length > 0 || accText.trim().length > 0) {
      const assistantMsg: StoredMessage = {
        id: ulid(),
        sessionKey: this.sessionKey,
        role: 'assistant',
        content: assistantContent,
        timestamp: Date.now(),
      };
      await sessionStore.append(this.sessionKey, assistantMsg);
      state.messages = [...state.messages, { role: 'assistant', content: assistantContent }];
    }

    if (streamErrorMessage) {
      const failure = classifyAgentFailure(streamErrorMessage);
      if (
        shouldSuspendLlmFailureBeforeOutput({
          failure,
          accumulatedText: accText,
          toolUseCount: assistantToolUse.length,
        })
      ) {
        const suspended = buildSuspendedError(
          'AGENT_LLM_RESOURCE_BLOCKED',
          `${failure.summary} 当前运行已挂起，可在外部条件恢复后继续。`,
        );
        await this.persistSuspendedSession(suspended);
        return {
          state,
          chunks,
          done: false,
          suspended,
        };
      }
      state.finalFailureMessage = failure.summary;
      state.finalFailureCode = failure.code;
      return await this.finalizeKernelTurn(state, chunks);
    }

    if (stopReason !== 'tool_use' || toolCallMap.size === 0) {
      return await this.finalizeKernelTurn(state, chunks);
    }

    state.toolRounds += 1;
    state.pendingToolCalls = Array.from(toolCallMap.entries()).map(([id, toolCall]) => ({
      id,
      name: toolCall.name,
      inputJson: toolCall.inputJson,
    }));

    if (this.hasApprovalPending(state.pendingToolCalls)) {
      return {
        state,
        chunks,
        done: false,
        syscall: buildApprovalRequestSyscall(state, state.pendingToolCalls),
      };
    }

    return {
      state,
      chunks,
      done: false,
      syscall: buildToolCallSyscall(state.runId, state.pendingToolCalls),
    };
  }

  async executeKernelToolCallSyscall(
    state: SerializedAgentTurnExecutionState,
    request: SyscallRequest,
    resolvedAt: number,
  ): Promise<SyscallResolution> {
    const pendingToolCalls = state.pendingToolCalls ?? [];
    if (request.kind !== 'tool.call') {
      return {
        requestId: request.id,
        ok: false,
        error: {
          code: 'AGENT_TOOL_SYSCALL_KIND_MISMATCH',
          message: `Unsupported syscall kind '${request.kind}' for agent tool execution`,
          retryable: false,
        },
        resolvedAt,
      };
    }
    if (pendingToolCalls.length === 0) {
      return {
        requestId: request.id,
        ok: false,
        error: {
          code: 'AGENT_TOOL_SYSCALL_MISSING_STATE',
          message: `No pending tool calls for run '${state.runId}'`,
          retryable: false,
        },
        resolvedAt,
      };
    }

    const { toolRegistry } = this.deps;
    const toolResults: SerializedToolSyscallResult[] = [];

    for (const toolCall of pendingToolCalls) {
      const parsedInput = parseToolCallInput(toolCall.inputJson);
      const policyResult = this.getToolPolicyResult(toolCall.name);

      let callResult: ToolCallResult;
      if (!policyResult.allowed) {
        callResult = policyBlockedResult(policyResult.reason ?? 'blocked');
      } else {
        const cacheKey = `${toolCall.name}|${toolCall.inputJson}`;
        const cachedResult = READ_ONLY_TOOLS.has(toolCall.name)
          ? (this.toolResultCache.get(cacheKey) as ToolCallResult | undefined)
          : undefined;
        if (cachedResult !== undefined) {
          callResult = cachedResult;
        } else {
          callResult = await toolRegistry.execute(toolCall.name, parsedInput);
          if (READ_ONLY_TOOLS.has(toolCall.name) && !callResult.isError) {
            this.toolResultCache.set(cacheKey, callResult);
          }
          if (MUTATION_TOOLS.has(toolCall.name)) {
            this.toolResultCache.clear();
          }
        }
      }

      toolResults.push({
        toolUseId: toolCall.id,
        content: callResult.content,
        isError: callResult.isError,
      });
    }

    return {
      requestId: request.id,
      ok: true,
      payload: {
        results: toolResults,
        runnerState: this.serializeState(),
      } satisfies SerializedToolSyscallPayload,
      resolvedAt,
    };
  }

  async executeKernelApprovalSyscall(
    state: SerializedAgentTurnExecutionState,
    request: SyscallRequest,
    resolvedAt: number,
  ): Promise<SyscallResolution> {
    const pendingToolCalls = state.pendingToolCalls ?? [];
    if (request.kind !== 'custom' || request.operation !== 'agent.turn.approval-request') {
      return {
        requestId: request.id,
        ok: false,
        error: {
          code: 'AGENT_APPROVAL_SYSCALL_KIND_MISMATCH',
          message: `Unsupported syscall '${request.kind}:${request.operation}' for agent approval`,
          retryable: false,
        },
        resolvedAt,
      };
    }

    const decisions: SerializedApprovalSyscallDecision[] = [];
    for (const toolCall of pendingToolCalls) {
      const policyResult = this.getToolPolicyResult(toolCall.name);
      if (!policyResult.requiresApproval) {
        decisions.push({ toolUseId: toolCall.id, approved: true });
        continue;
      }

      const approved = this.deps.approvalHandler
        ? await this.deps.approvalHandler(toolCall.name, parseToolCallInput(toolCall.inputJson))
        : true;
      decisions.push({ toolUseId: toolCall.id, approved });
    }

    return {
      requestId: request.id,
      ok: true,
      payload: {
        decisions,
      } satisfies SerializedApprovalSyscallPayload,
      resolvedAt,
    };
  }

  async applyKernelApprovalSyscall(
    state: SerializedAgentTurnExecutionState,
    resolution: SyscallResolution,
  ): Promise<KernelTurnStepResult> {
    const chunks: StreamChunk[] = [];
    const pendingToolCalls = state.pendingToolCalls ?? [];
    if (pendingToolCalls.length === 0) {
      throw new Error(`Agent approval state is missing pending tool calls for '${state.runId}'`);
    }
    if (!resolution.ok) {
      state.finalFailureMessage = resolution.error?.message ?? '审批请求执行失败';
      state.finalFailureCode = 'generic';
      return await this.finalizeKernelTurn(state, chunks);
    }

    const payload = resolution.payload as SerializedApprovalSyscallPayload | undefined;
    const decisionMap = new Map(
      payload?.decisions?.map((decision) => [decision.toolUseId, decision.approved]) ?? [],
    );

    for (const toolCall of pendingToolCalls) {
      const approved = decisionMap.get(toolCall.id);
      if (approved === false) {
        const suspended = buildSuspendedError(
          'AGENT_TOOL_APPROVAL_DENIED',
          `工具调用需要审批，当前处于挂起状态：${toolCall.name}`,
        );
        await this.persistSuspendedSession(suspended);
        return {
          state,
          chunks,
          done: false,
          suspended,
        };
      }
    }

    return {
      state,
      chunks,
      done: false,
      syscall: buildToolCallSyscall(state.runId, pendingToolCalls),
    };
  }

  async applyKernelToolCallSyscall(
    state: SerializedAgentTurnExecutionState,
    resolution: SyscallResolution,
  ): Promise<KernelTurnStepResult> {
    const { sessionStore } = this.deps;
    const chunks: StreamChunk[] = [];
    const maxToolRounds = this.config.tools.maxRounds ?? 60;
    const pendingToolCalls = state.pendingToolCalls ?? [];
    if (pendingToolCalls.length === 0) {
      throw new Error(
        `Agent turn execution state is missing pending tool calls for '${state.runId}'`,
      );
    }

    state.pendingToolCalls = undefined;
    if (!resolution.ok) {
      state.finalFailureMessage = resolution.error?.message ?? '工具调用执行失败';
      state.finalFailureCode = 'generic';
      return await this.finalizeKernelTurn(state, chunks);
    }

    const payload = resolution.payload as SerializedToolSyscallPayload | undefined;
    if (payload?.runnerState) {
      this.restoreState(payload.runnerState);
    }

    const resultMap = new Map(payload?.results?.map((result) => [result.toolUseId, result]) ?? []);
    const toolResults: ToolResultContent[] = [];
    const toolLoopDetector = new ToolLoopDetector();
    toolLoopDetector.restoreState(state.toolLoopDetector);

    for (const toolCall of pendingToolCalls) {
      const resolvedResult = resultMap.get(toolCall.id);
      if (!resolvedResult) {
        state.finalFailureMessage = `工具调用结果缺失：${toolCall.name}`;
        state.finalFailureCode = 'generic';
        return await this.finalizeKernelTurn(state, chunks);
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: resolvedResult.content,
        is_error: resolvedResult.isError,
      });

      if (resolvedResult.isError) {
        state.toolFailureMessages.push(resolvedResult.content);
      }

      const loopSignal = toolLoopDetector.record(
        toolCall.name,
        parseToolCallInput(toolCall.inputJson),
        resolvedResult.content,
        resolvedResult.isError,
      );
      if (loopSignal.level === 'warn') {
        logger.warn('Potential no-progress tool loop detected', {
          agentId: this.agentId,
          toolName: toolCall.name,
          repeatCount: loopSignal.repeatCount,
        });
      } else if (loopSignal.level === 'block') {
        logger.error('Blocked repeated no-progress tool loop', {
          agentId: this.agentId,
          toolName: toolCall.name,
          repeatCount: loopSignal.repeatCount,
        });
        state.finalFailureMessage = loopSignal.message ?? '检测到无进展工具循环';
        state.finalFailureCode = 'tool_loop';
      }
    }

    state.toolLoopDetector = toolLoopDetector.serializeState();

    const toolResultMsg: StoredMessage = {
      id: ulid(),
      sessionKey: this.sessionKey,
      role: 'user',
      content: toolResults,
      timestamp: Date.now(),
    };
    await sessionStore.append(this.sessionKey, toolResultMsg);
    state.messages = [...state.messages, { role: 'user', content: toolResults }];

    if (state.finalFailureMessage) {
      return await this.finalizeKernelTurn(state, chunks);
    }
    if (state.toolRounds >= maxToolRounds) {
      state.finalFailureMessage = `工具调用轮次已达到上限（${maxToolRounds}），已停止本轮以避免失控执行。`;
      state.finalFailureCode = 'tool_round_limit';
      return await this.finalizeKernelTurn(state, chunks);
    }

    return {
      state,
      chunks,
      done: false,
      syscall: buildLlmGenerateSyscall(state, this.buildPermittedToolDefinitions().length),
    };
  }

  private async finalizeKernelTurn(
    state: SerializedAgentTurnExecutionState,
    chunks: StreamChunk[],
  ): Promise<KernelTurnStepResult> {
    const { metaStore } = this.deps;
    let totalText = state.totalText;

    if (state.finalFailureMessage) {
      const failureText = totalText
        ? `\n\n${formatFailureReply(state.finalFailureMessage)}`
        : formatFailureReply(state.finalFailureMessage);
      chunks.push({ type: 'text_delta', text: failureText });
      totalText += failureText;
      const failureMsg: StoredMessage = {
        id: ulid(),
        sessionKey: this.sessionKey,
        role: 'assistant',
        content: failureText,
        timestamp: Date.now(),
      };
      await this.deps.sessionStore.append(this.sessionKey, failureMsg);
    } else if (!totalText) {
      const closingText =
        state.toolFailureMessages.length > 0
          ? formatFailureReply(
              state.toolFailureMessages[state.toolFailureMessages.length - 1] ?? '',
            )
          : state.toolRounds > 0
            ? '✅ 任务执行完毕。'
            : '';
      if (closingText) {
        chunks.push({ type: 'text_delta', text: closingText });
        totalText = closingText;
        const closingMsg: StoredMessage = {
          id: ulid(),
          sessionKey: this.sessionKey,
          role: 'assistant',
          content: closingText,
          timestamp: Date.now(),
        };
        await this.deps.sessionStore.append(this.sessionKey, closingMsg);
      }
    }

    await metaStore.update(this.sessionKey, {
      agentId: this.agentId,
      threadKey: this.threadKey,
      status: state.finalFailureMessage ? 'error' : 'idle',
      lastActivity: Date.now(),
      contextTokensEstimate: state.totalInputTokens,
      error: state.finalFailureMessage ? formatFailureReply(state.finalFailureMessage) : undefined,
      errorCode: state.finalFailureMessage ? (state.finalFailureCode ?? 'generic') : undefined,
    });

    if (this.deps.dataDir) {
      void recordTokenBill(this.deps.dataDir, {
        ts: new Date().toISOString(),
        agentId: this.agentId,
        model: state.model,
        inputTokens: state.totalInputTokens,
        outputTokens: state.totalOutputTokens,
        cacheReadTokens: state.totalCacheReadTokens,
        totalTokens: state.totalInputTokens + state.totalOutputTokens,
      });
    }

    void this.deps.memoryOrganizer?.maybeOrganize();
    this.activeKernelRunId = null;

    return {
      state: {
        ...state,
        totalText,
      },
      chunks,
      done: true,
      result: {
        sessionKey: this.sessionKey,
        text: totalText,
        inputTokens: state.totalInputTokens,
        outputTokens: state.totalOutputTokens,
      },
    };
  }

  /**
   * BM25-search the agent's memory store for context relevant to the query.
   * Returns a newline-joined text block ready for injection as `memoryText`.
   * Returns an empty string if no store is configured or no results found.
   *
   * RATIONALE: called before each turn so the runner can inject relevant
   * memories into the system prompt's Layer 3 without requiring an LLM round-trip.
   */
  async searchMemory(query: string, limit = 5): Promise<string> {
    const store = this.deps.memoryStore;
    if (!store) return '';
    try {
      const results = store.searchFts(query, undefined, limit);
      if (results.length === 0) return '';
      return results.map((e, i) => `[${i + 1}] ${e.content}`).join('\n\n');
    } catch (err) {
      logger.debug('Memory search failed (non-fatal)', { error: String(err) });
      return '';
    }
  }

  private async *driveDirectKernelStep(
    step: KernelTurnStepResult,
  ): AsyncGenerator<StreamChunk, TurnResult> {
    for (const chunk of step.chunks) {
      yield chunk;
    }

    if (step.suspended) {
      const suspendedText = formatFailureReply(step.suspended.message);
      yield { type: 'error', message: step.suspended.message };
      yield { type: 'text_delta', text: suspendedText };
      return {
        sessionKey: this.sessionKey,
        text: suspendedText,
        inputTokens: step.state.totalInputTokens,
        outputTokens: step.state.totalOutputTokens,
      };
    }

    if (step.done && step.result) {
      return step.result;
    }

    if (!step.syscall) {
      const continuedStep = await this.continueKernelTurn(step.state);
      return yield* this.driveDirectKernelStep(continuedStep);
    }

    const request = step.syscall;
    const resolvedAt = Date.now();
    const resolution =
      request.kind === 'llm.generate'
        ? await this.executeKernelLlmGenerateSyscall(step.state, request, resolvedAt)
        : request.kind === 'tool.call'
          ? await this.executeKernelToolCallSyscall(step.state, request, resolvedAt)
          : await this.executeKernelApprovalSyscall(step.state, request, resolvedAt);

    const nextStep =
      request.kind === 'llm.generate'
        ? await this.applyKernelLlmGenerateSyscall(step.state, resolution)
        : request.kind === 'tool.call'
          ? await this.applyKernelToolCallSyscall(step.state, resolution)
          : await this.applyKernelApprovalSyscall(step.state, resolution);

    return yield* this.driveDirectKernelStep(nextStep);
  }

  /**
   * Run one conversational turn.
   * Yields StreamChunk objects and resolves to a TurnResult when done.
   */
  async *turn(
    userMessage: string,
    opts: RunnerOptions = {},
  ): AsyncGenerator<StreamChunk, TurnResult> {
    if (this.isRunning) {
      throw new Error(`Agent '${this.agentId}' is already processing a turn`);
    }
    let executionState: SerializedAgentTurnExecutionState | null = null;
    try {
      executionState = await this.beginKernelTurn(`direct:${ulid()}`, userMessage, opts);
      this._running = true;
      const initialStep = await this.continueKernelTurn(executionState);
      return yield* this.driveDirectKernelStep(initialStep);
    } catch (err) {
      const failure = classifyAgentFailure(err instanceof Error ? err.message : String(err));
      const failureText = formatFailureReply(failure.summary);
      logger.error('Agent turn failed unexpectedly', {
        agentId: this.agentId,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      await this.deps.metaStore.update(this.sessionKey, {
        agentId: this.agentId,
        threadKey: this.threadKey,
        status: 'error',
        lastActivity: Date.now(),
        error: failureText,
        errorCode: failure.code,
      });
      const failureMsg: StoredMessage = {
        id: ulid(),
        sessionKey: this.sessionKey,
        role: 'assistant',
        content: failureText,
        timestamp: Date.now(),
      };
      await this.deps.sessionStore.append(this.sessionKey, failureMsg).catch(() => undefined);
      yield { type: 'text_delta', text: failureText };
      return {
        sessionKey: this.sessionKey,
        text: failureText,
        inputTokens: executionState?.totalInputTokens ?? 0,
        outputTokens: executionState?.totalOutputTokens ?? 0,
      };
    } finally {
      this._running = false;
      if (this.activeKernelRunId?.startsWith('direct:')) {
        this.activeKernelRunId = null;
      }
    }
  }

  /** Convenience: run a turn and collect all output into a string (non-streaming). */
  async runTurn(userMessage: string, opts?: RunnerOptions): Promise<TurnResult> {
    const gen = this.turn(userMessage, opts);
    let value = await gen.next();
    while (!value.done) {
      value = await gen.next();
    }
    return value.value;
  }

  /** Clear the current thread's conversation history. */
  async clearHistory(): Promise<void> {
    await this.deps.sessionStore.overwrite(this.sessionKey, []);
    await this.deps.metaStore.update(this.sessionKey, {
      messageCount: 0,
      contextTokensEstimate: 0,
      compactionCount: 0,
    });
  }

  private async persistSuspendedSession(error: ProcessErrorEvent): Promise<void> {
    const suspended = toSuspendedSessionError(error);
    await this.deps.metaStore.update(this.sessionKey, {
      agentId: this.agentId,
      threadKey: this.threadKey,
      status: 'suspended',
      lastActivity: Date.now(),
      error: suspended.error,
      errorCode: suspended.errorCode,
    });
  }
}
