import { ulid } from 'ulid';
import { createLogger } from '../core/logger.js';
import { createHash } from 'node:crypto';
import type {
  AgentId,
  ThreadKey,
  SessionKey,
  Message,
  ToolCallResult,
  ToolUseContent,
  ToolResultContent,
  StreamChunk,
} from '../core/types.js';
import { makeSessionKey } from '../core/types.js';
import type { AgentConfig } from '../core/config/schema.js';
import type { LLMProvider } from './llm/provider.js';
import type { ToolRegistry } from './tools/registry.js';
import { checkPolicy, filterAllowedTools, policyBlockedResult, type ApprovalHandler, type ToolPolicy } from './tools/policy.js';
import { SessionStore, type StoredMessage } from '../core/session/store.js';
import { SessionMetaStore } from '../core/session/meta.js';
import { checkCompactionNeeded, runCompaction } from './compactor/index.js';
import { buildSystemPrompt } from './prompt/builder.js';
import {
  layer0Identity,
  layer1Workspace,
  layer2Skills,
  layer3Memory,
} from './prompt/layers.js';
import { readWorkspaceDocCached } from './prompt/workspace.js';
import { buildPersonaContent } from './prompt/soul.js';

const logger = createLogger('agent:runner');

/** Read-only tools whose results can safely be cached within a thread. */
const READ_ONLY_TOOLS = new Set([
  'read_file', 'list_dir', 'search_files', 'memory_search', 'grep_search',
]);

/** Mutation tools that invalidate the read-only tool result cache. */
const MUTATION_TOOLS = new Set([
  'write_file', 'create_file', 'edit_file', 'bash', 'run_terminal',
]);

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
      if (!msg) { i++; continue; }

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
            ? (prev.content as MC[]).filter((c) => c.type === 'tool_use') as TUC[]
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

  constructor(
    private readonly config: AgentConfig,
    private readonly deps: RunnerDeps,
  ) {
    this.agentId = config.id as AgentId;
    this.threadKey = 'default' as ThreadKey;
    this.sessionKey = makeSessionKey(this.agentId, this.threadKey);
  }

  /** Change the active thread (creates a new session file). */
  setThread(threadKey: string): void {
    this.threadKey = threadKey as ThreadKey;
    this.sessionKey = makeSessionKey(this.agentId, this.threadKey);
    this.promptLayerHashes.clear();
    this.cachedSystemPrompt = null;
    this.toolResultCache.clear();
  }

  get currentSessionKey(): SessionKey {
    return this.sessionKey;
  }

  /**
   * Run one conversational turn.
   * Yields StreamChunk objects and resolves to a TurnResult when done.
   */
  async *turn(
    userMessage: string,
    opts: RunnerOptions = {},
  ): AsyncGenerator<StreamChunk, TurnResult> {
    const { provider, toolRegistry, sessionStore, metaStore, approvalHandler } = this.deps;
    const model = opts.model ?? this.deps.resolvedModel?.id ?? this.config.model ?? 'claude-haiku-3-5';
    const maxTokens = opts.maxTokens ?? this.deps.resolvedModel?.maxTokens ?? 8192;

    // ── 1. Build system prompt ──────────────────────────────────────────────
    const agentName = this.config.name ?? this.agentId;
    const workspace = this.config.workspace;

    let workspaceDoc: string | null = null;
    if (workspace) {
      workspaceDoc = await readWorkspaceDocCached(workspace).catch(() => null);
    }

    // Build base layers once; hash their content to detect changes between
    // turns. If all hashes match and there is no per-turn taskContext, reuse
    // the cached systemPrompt to skip the trimming pass in buildSystemPrompt.
    const baseLayers = [
      layer0Identity(agentName, this.agentId, this.config.mesh?.role, buildPersonaContent(this.config)),
      layer1Workspace(workspaceDoc ?? ''),
      layer2Skills(opts.skillsText ?? this.deps.skillsText ?? ''),
      layer3Memory(opts.memoryText ?? ''),
    ];
    const newLayerHashes = baseLayers.map(l =>
      createHash('sha256').update(l.content).digest('hex').slice(0, 16),
    );
    const allBaseUnchanged =
      !opts.taskContext &&
      this.cachedSystemPrompt !== null &&
      newLayerHashes.every((h, i) => this.promptLayerHashes.get(i) === h);

    let systemPrompt: string;
    if (allBaseUnchanged) {
      systemPrompt = this.cachedSystemPrompt!;
    } else {
      ({ systemPrompt } = buildSystemPrompt(
        [
          ...baseLayers,
          ...(opts.taskContext
            ? [{ id: 4 as const, name: 'task', content: opts.taskContext, estimatedTokens: 0, trimable: true }]
            : []),
        ],
        this.deps.systemPromptMaxTokens,
      ));
      newLayerHashes.forEach((h, i) => this.promptLayerHashes.set(i, h));
      this.cachedSystemPrompt = systemPrompt;
    }

    // ── 2. Load conversation history ────────────────────────────────────────
    const history = await sessionStore.readAll(this.sessionKey);
    let messages: Message[] = sanitizeMessages(
      history.map((s) => ({ role: s.role, content: s.content })),
    );

    // Append the new user message
    const userMsg: StoredMessage = {
      id: ulid(),
      sessionKey: this.sessionKey,
      role: 'user',
      content: userMessage,
      timestamp: Date.now(),
    };
    await sessionStore.append(this.sessionKey, userMsg);
    messages = [...messages, { role: 'user', content: userMessage }];

    // Check compaction
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
          if (chunk.type === 'text_delta') text += chunk.text;
        }
        return text;
      });
      messages = [compacted.summaryMessage, ...compacted.keptMessages];
      await metaStore.update(this.sessionKey, {
        compactionCount: ((await metaStore.get(this.sessionKey))?.compactionCount ?? 0) + 1,
        lastCompactionAt: Date.now(),
      });
    }

    // ── 3. Main agentic loop ────────────────────────────────────────────────
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalText = '';

    const MAX_TOOL_ROUNDS = 20; // safety cap
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const allToolsWithCategory = toolRegistry.list();
      // Pre-filter by policy so the LLM only sees tools it is allowed to call.
      // Without this, blocked tools appear in the schema and the model tries to
      // invoke them, which just returns a policy-error tool_result.
      // RATIONALE: skill-category tools (skill_list, skill_read) are exempt from
      // the allowlist — they're already scoped to this agent's assigned skills and
      // must always be visible when skills are configured. They remain subject to
      // the denylist.
      const agentPolicy: ToolPolicy = {
        allowlist: this.config.tools.allow,
        denylist: this.config.tools.deny,
        requireApproval: this.config.tools.approval,
      };
      const permittedNames = new Set(
        allToolsWithCategory
          .filter((t) => {
            if (t.category === 'skill') {
              // Skill tools: only subject to denylist, not allowlist
              return !agentPolicy.denylist.includes(t.definition.name);
            }
            return filterAllowedTools([t.definition.name], agentPolicy).length > 0;
          })
          .map((t) => t.definition.name),
      );
      const toolDefs = allToolsWithCategory
        .map((t) => t.definition)
        .filter((d) => permittedNames.has(d.name));

      // Accumulate tool calls from streaming
      const toolCallMap = new Map<string, { name: string; inputJson: string }>();
      let accText = '';
      let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' = 'end_turn';
      let doneEmitted = false;

      // Track ids by index (OpenAI sends partial ids per index)
      const indexToId = new Map<string, string>();

      for await (const chunk of provider.run({
        model,
        systemPrompt,
        messages,
        tools: toolDefs,
        maxTokens,
        temperature: this.deps.resolvedModel?.temperature,
      })) {
        yield chunk;

        if (chunk.type === 'text_delta') {
          accText += chunk.text;
        } else if (chunk.type === 'tool_use_delta') {
          const id = chunk.id || indexToId.get(chunk.name) || chunk.name;
          if (chunk.id) indexToId.set(chunk.name, chunk.id);
          const existing = toolCallMap.get(id) ?? { name: chunk.name, inputJson: '' };
          if (chunk.name && !existing.name) existing.name = chunk.name;
          existing.inputJson += chunk.inputJson;
          toolCallMap.set(id, existing);
        } else if (chunk.type === 'done') {
          totalInputTokens += chunk.inputTokens;
          totalOutputTokens += chunk.outputTokens;
          stopReason = chunk.stopReason;
          doneEmitted = true;
        } else if (chunk.type === 'error') {
          logger.error('LLM error', { message: chunk.message });
          // Clear accumulated tool calls so we never persist an orphaned
          // assistant message (tool_calls without tool_results).
          toolCallMap.clear();
          accText = '';
          break;
        }
      }

      totalText += accText;

      // Persist assistant message
      const assistantToolUse: ToolUseContent[] = [];
      for (const [id, tc] of toolCallMap) {
        let parsedInput: unknown = {};
        try {
          parsedInput = JSON.parse(tc.inputJson || '{}');
        } catch {
          /* use empty object on bad JSON */
        }
        assistantToolUse.push({ type: 'tool_use', id, name: tc.name, input: parsedInput });
      }

      const assistantContent =
        assistantToolUse.length > 0
          ? [
              ...(accText ? [{ type: 'text' as const, text: accText }] : []),
              ...assistantToolUse,
            ]
          : accText;

      const assistantMsg: StoredMessage = {
        id: ulid(),
        sessionKey: this.sessionKey,
        role: 'assistant',
        content: assistantContent,
        timestamp: Date.now(),
      };
      await sessionStore.append(this.sessionKey, assistantMsg);
      messages = [...messages, { role: 'assistant', content: assistantContent }];

      // ── No more tool calls — done ────────────────────────────────────────
      if (stopReason !== 'tool_use' || toolCallMap.size === 0) break;

      // ── Execute tool calls ───────────────────────────────────────────────
      const toolResults: ToolResultContent[] = [];

      for (const [id, tc] of toolCallMap) {
        let parsedInput: unknown = {};
        try {
          parsedInput = JSON.parse(tc.inputJson || '{}');
        } catch { /* ignore */ }

        const tools = this.config.tools;
        // Skill-category tools are exempt from the allowlist (they're scoped to
        // the agent's own skills already); build an effective policy accordingly.
        const isSkillTool = toolRegistry.get(tc.name)?.category === 'skill';
        const effectiveAllowlist = isSkillTool ? undefined : tools.allow;
        const policyResult = checkPolicy(tc.name, {
          allowlist: effectiveAllowlist,
          denylist: tools.deny,
          requireApproval: tools.approval,
        });

        let callResult: ToolCallResult;
        if (!policyResult.allowed) {
          callResult = policyBlockedResult(policyResult.reason ?? 'blocked');
        } else if (policyResult.requiresApproval && approvalHandler) {
          const approved = await approvalHandler(tc.name, parsedInput);
          callResult = approved
            ? await toolRegistry.execute(tc.name, parsedInput)
            : policyBlockedResult('User declined approval');
        } else {
          // Check read-only cache; populate cache after success.
          const cacheKey = `${tc.name}|${tc.inputJson}`;
          const cachedResult = READ_ONLY_TOOLS.has(tc.name)
            ? (this.toolResultCache.get(cacheKey) as ToolCallResult | undefined)
            : undefined;
          if (cachedResult !== undefined) {
            callResult = cachedResult;
          } else {
            callResult = await toolRegistry.execute(tc.name, parsedInput);
            if (READ_ONLY_TOOLS.has(tc.name) && !callResult.isError) {
              this.toolResultCache.set(cacheKey, callResult);
            }
            if (MUTATION_TOOLS.has(tc.name)) {
              this.toolResultCache.clear();
            }
          }
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: id,
          content: callResult.content,
          is_error: callResult.isError,
        });
      }

      // Persist tool results as user message
      const toolResultMsg: StoredMessage = {
        id: ulid(),
        sessionKey: this.sessionKey,
        role: 'user',
        content: toolResults,
        timestamp: Date.now(),
      };
      await sessionStore.append(this.sessionKey, toolResultMsg);
      messages = [...messages, { role: 'user', content: toolResults }];
    }

    // ── 4. Update session meta ──────────────────────────────────────────────
    await metaStore.update(this.sessionKey, {
      agentId: this.agentId,
      threadKey: this.threadKey,
      status: 'idle',
      lastActivity: Date.now(),
      contextTokensEstimate: totalInputTokens,
    });

    return {
      sessionKey: this.sessionKey,
      text: totalText,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    };
  }

  /** Convenience: run a turn and collect all output into a string (non-streaming). */
  async runTurn(userMessage: string, opts?: RunnerOptions): Promise<TurnResult> {
    const gen = this.turn(userMessage, opts);
    let result: TurnResult | undefined;
    let value = await gen.next();
    while (!value.done) {
      value = await gen.next();
    }
    result = value.value;
    return result;
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
}
