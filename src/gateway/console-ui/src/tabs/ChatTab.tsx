import { useEffect, useRef, useState } from 'react';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { CopyButton } from '../components/CopyButton.js';
import { useLocale } from '../context/i18n.js';
import { MarkdownView } from '../components/MarkdownView.js';
import { rpc, useQuery } from '../hooks/useRpc.js';
import { createConsoleThreadKey } from '../thread-keys.js';
import type { ChatRecoveryContext } from '../types.js';
import type {
  AgentInfo,
  AgentListResult,
  ChatChunk,
  SessionListResult,
  SessionMessagesResult,
  SessionMetaInfo,
} from '../types.js';

interface ToolCall {
  id: string;
  name: string;
  input: string;
}

interface ToolResult {
  content: string;
  isError?: boolean;
}

interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface Message {
  role: 'user' | 'assistant' | 'thinking';
  content: string;
  streaming?: boolean;
  tools?: ToolCall[];
  toolResults?: ToolResult[];
  usage?: TokenUsage;
}

// ── Per-agent panel ──────────────────────────────────────────────────────────

interface AgentPanelProps {
  agent: AgentInfo;
  initialThreadKey?: string;
  recoveryContext?: ChatRecoveryContext | null;
}

interface RecoveryEvidenceContext {
  userContext: string;
  assistantContext: string;
  toolContext: string;
  toolInputContext: string;
  toolResultContext: string;
  errorFragment: string;
}

interface RecoveryEvidenceEntry {
  key: string;
  label: string;
  value: string;
  fullValue?: string;
  tone?: 'default' | 'success' | 'error';
}

interface StructuredRecoveryVariant {
  key: string;
  label: string;
  template: string;
}

type ToolResultPattern =
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'missing_input'
  | 'parse'
  | 'conflict'
  | 'timeout'
  | 'rate_limit'
  | 'network';

const TOOL_RESULT_PATTERN_PRIORITY: ToolResultPattern[] = [
  'auth',
  'permission',
  'rate_limit',
  'network',
  'timeout',
  'conflict',
  'not_found',
  'missing_input',
  'parse',
];

const RECOVERY_EVIDENCE_PREVIEW_LENGTH = 180;
const COLLAPSIBLE_TEXT_LINE_LIMIT = 5;

function compactText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateText(text: string, maxLength = 140): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function findLastMessage(messages: Message[], role: Message['role']): Message | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== role) {
      continue;
    }
    const content = compactText(message.content);
    if (content) {
      return { ...message, content };
    }
  }
  return null;
}

function findLastRawMessage(messages: Message[], role: Message['role']): Message | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== role) {
      continue;
    }
    if (compactText(message.content)) {
      return message;
    }
  }
  return null;
}

function findLastToolWithInput(messages: Message[]): ToolCall | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message?.tools?.length) {
      continue;
    }
    const tool = message.tools.find((item) => compactText(item.input));
    if (tool) {
      return tool;
    }
  }
  return null;
}

function findLastToolResult(messages: Message[]): ToolResult | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message?.toolResults?.length) {
      continue;
    }
    const result = message.toolResults.find((item) => compactText(item.content));
    if (result) {
      return result;
    }
  }
  return null;
}

function buildRecoveryEvidenceEntries(
  messages: Message[],
  t: (key: string) => string,
): RecoveryEvidenceEntry[] {
  const entries: RecoveryEvidenceEntry[] = [];
  const latestUserMessage = findLastRawMessage(messages, 'user');
  const latestAssistantMessage = findLastRawMessage(messages, 'assistant');
  const latestToolWithInput = findLastToolWithInput(messages);
  const latestToolResult = findLastToolResult(messages);

  if (latestUserMessage) {
    const fullValue = latestUserMessage.content.trim();
    if (fullValue) {
      entries.push({
        key: 'task',
        label: t('chat.recovery.evidence.task'),
        value: truncateText(compactText(fullValue), RECOVERY_EVIDENCE_PREVIEW_LENGTH),
        fullValue,
      });
    }
  }

  if (latestAssistantMessage && !latestAssistantMessage.content.startsWith('Error:')) {
    const fullValue = latestAssistantMessage.content.trim();
    if (fullValue) {
      entries.push({
        key: 'progress',
        label: t('chat.recovery.evidence.progress'),
        value: truncateText(compactText(fullValue), RECOVERY_EVIDENCE_PREVIEW_LENGTH),
        fullValue,
      });
    }
  }

  if (latestAssistantMessage?.content.startsWith('Error:')) {
    const fullValue = latestAssistantMessage.content.slice('Error:'.length).trim();
    if (fullValue) {
      entries.push({
        key: 'error',
        label: t('chat.recovery.evidence.error'),
        value: truncateText(compactText(fullValue), 120),
        fullValue,
        tone: 'error',
      });
    }
  }

  const toolContext = summarizeToolContext(messages);
  if (toolContext) {
    entries.push({
      key: 'tools',
      label: t('chat.recovery.evidence.tools'),
      value: toolContext,
      fullValue: toolContext,
    });
  }

  if (latestToolWithInput) {
    const fullValue = `${compactText(latestToolWithInput.name)}: ${latestToolWithInput.input.trim()}`;
    if (compactText(fullValue)) {
      entries.push({
        key: 'toolInput',
        label: t('chat.recovery.evidence.toolInput'),
        value: truncateText(compactText(fullValue), 120),
        fullValue,
      });
    }
  }

  if (latestToolResult) {
    const fullValue = latestToolResult.content.trim();
    if (fullValue) {
      entries.push({
        key: 'toolResult',
        label: t('chat.recovery.evidence.toolResult'),
        value: truncateText(compactText(fullValue), 120),
        fullValue,
        tone: latestToolResult.isError ? 'error' : 'success',
      });
    }
  }

  return entries;
}

function summarizeToolContext(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message?.tools?.length) {
      continue;
    }
    const toolNames = Array.from(new Set(message.tools.map((tool) => compactText(tool.name)).filter(Boolean)));
    if (toolNames.length === 0) {
      continue;
    }
    if (toolNames.length === 1) {
      return toolNames[0] ?? '';
    }
    return `${toolNames[0]}, ${toolNames[1]}${toolNames.length > 2 ? '…' : ''}`;
  }
  return '';
}

function summarizeToolInputContext(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message?.tools?.length) {
      continue;
    }
    const firstToolWithInput = message.tools.find((tool) => compactText(tool.input));
    if (!firstToolWithInput) {
      continue;
    }
    const inputPreview = truncateText(compactText(firstToolWithInput.input), 90);
    if (!inputPreview) {
      continue;
    }
    return `${compactText(firstToolWithInput.name)}: ${inputPreview}`;
  }
  return '';
}

function summarizeErrorFragment(messages: Message[]): string {
  const latestAssistantMessage = findLastMessage(messages, 'assistant');
  if (!latestAssistantMessage?.content.startsWith('Error:')) {
    return '';
  }
  return truncateText(latestAssistantMessage.content.slice('Error:'.length).trim(), 120);
}

function summarizeToolResultContext(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message?.toolResults?.length) {
      continue;
    }
    const firstResult = message.toolResults.find((item) => compactText(item.content));
    if (!firstResult) {
      continue;
    }
    return truncateText(compactText(firstResult.content), 120);
  }
  return '';
}

function detectToolResultPatterns(messages: Message[]): ToolResultPattern[] {
  const latestToolResult = findLastToolResult(messages);
  if (!latestToolResult) {
    return [];
  }
  const normalized = compactText(latestToolResult.content);
  if (!normalized) {
    return [];
  }
  const text = normalized.toLowerCase();
  const patterns = new Set<ToolResultPattern>();

  if (
    /(rate limit|too many requests|429|throttl|quota exceeded|overloaded|retry after|try again later)/.test(
      text,
    )
  ) {
    patterns.add('rate_limit');
  }
  if (
    /(timed out|timeout|deadline exceeded|request timeout|operation timeout|etimedout|context deadline exceeded)/.test(
      text,
    )
  ) {
    patterns.add('timeout');
  }
  if (
    /(network error|network is unreachable|connection refused|connection reset|econnrefused|econnreset|enotfound|dns|socket hang up|failed to fetch|temporary failure in name resolution)/.test(
      text,
    )
  ) {
    patterns.add('network');
  }
  if (
    /(unauthorized|authentication failed|invalid api key|invalid token|token expired|login required|credential.*invalid|auth failed)/.test(
      text,
    )
  ) {
    patterns.add('auth');
  }
  if (
    /(permission denied|access denied|operation not permitted|insufficient privileges|eacces|forbidden|not allowed)/.test(
      text,
    )
  ) {
    patterns.add('permission');
  }
  if (/(not found|no such file|does not exist|cannot find|enoent|unknown id|unknown file)/.test(text)) {
    patterns.add('not_found');
  }
  if (/(already exists|duplicate|conflict|409|precondition failed|version mismatch|stale update)/.test(text)) {
    patterns.add('conflict');
  }
  if (
    /(missing required|required field|required parameter|missing argument|must provide|is required|expected .* but got)/.test(
      text,
    )
  ) {
    patterns.add('missing_input');
  }
  if (
    /(parse error|failed to parse|invalid json|unexpected token|json parse|yaml parse|malformed|schema validation)/.test(
      text,
    )
  ) {
    patterns.add('parse');
  }

  return TOOL_RESULT_PATTERN_PRIORITY.filter((pattern) => patterns.has(pattern));
}

function getPrimaryToolResultPattern(patterns: ToolResultPattern[]): ToolResultPattern | null {
  return patterns[0] ?? null;
}

function getPatternGuidedRecoveryMessage(
  patterns: ToolResultPattern[],
  task: string,
  toolResult: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const primary = getPrimaryToolResultPattern(patterns);
  if (!primary) {
    return '';
  }
  if (patterns.includes('auth') && patterns.includes('permission')) {
    return t('chat.recovery.suggestedMessage.resolveAuthPermission', { task, toolResult });
  }
  if (patterns.includes('network') && patterns.includes('timeout')) {
    return t('chat.recovery.suggestedMessage.resolveNetworkTimeout', { task, toolResult });
  }
  if (patterns.includes('rate_limit') && patterns.includes('timeout')) {
    return t('chat.recovery.suggestedMessage.resolveRateLimitTimeout', { task, toolResult });
  }

  switch (primary) {
    case 'rate_limit':
      return t('chat.recovery.suggestedMessage.resolveRateLimit', { task, toolResult });
    case 'timeout':
      return t('chat.recovery.suggestedMessage.resolveTimeout', { task, toolResult });
    case 'network':
      return t('chat.recovery.suggestedMessage.resolveNetwork', { task, toolResult });
    case 'auth':
      return t('chat.recovery.suggestedMessage.resolveAuth', { task, toolResult });
    case 'permission':
      return t('chat.recovery.suggestedMessage.resolvePermission', { task, toolResult });
    case 'not_found':
      return t('chat.recovery.suggestedMessage.resolveNotFound', { task, toolResult });
    case 'conflict':
      return t('chat.recovery.suggestedMessage.resolveConflict', { task, toolResult });
    case 'missing_input':
      return t('chat.recovery.suggestedMessage.resolveMissingInput', { task, toolResult });
    case 'parse':
      return t('chat.recovery.suggestedMessage.resolveParse', { task, toolResult });
  }
}

function formatPatternLabel(pattern: ToolResultPattern, t: (key: string) => string): string {
  switch (pattern) {
    case 'not_found':
      return t('chat.recovery.pattern.notFound');
    case 'missing_input':
      return t('chat.recovery.pattern.missingInput');
    default:
      return t(`chat.recovery.pattern.${pattern}`);
  }
}

function sanitizeStructuredLine(text: string, maxLength: number): string {
  const compact = compactText(text);
  if (!compact) {
    return '';
  }
  return truncateText(compact, maxLength);
}

function getStructuredChecklistItems(
  patterns: ToolResultPattern[],
  t: (key: string, vars?: Record<string, string | number>) => string,
): string[] {
  const items: string[] = [];
  for (const pattern of patterns) {
    switch (pattern) {
      case 'auth':
        items.push(t('chat.recovery.structured.check.auth'));
        break;
      case 'permission':
        items.push(t('chat.recovery.structured.check.permission'));
        break;
      case 'rate_limit':
        items.push(t('chat.recovery.structured.check.rateLimit'));
        break;
      case 'network':
        items.push(t('chat.recovery.structured.check.network'));
        break;
      case 'timeout':
        items.push(t('chat.recovery.structured.check.timeout'));
        break;
      case 'conflict':
        items.push(t('chat.recovery.structured.check.conflict'));
        break;
      case 'not_found':
        items.push(t('chat.recovery.structured.check.notFound'));
        break;
      case 'missing_input':
        items.push(t('chat.recovery.structured.check.missingInput'));
        break;
      case 'parse':
        items.push(t('chat.recovery.structured.check.parse'));
        break;
    }
  }
  return Array.from(new Set(items)).slice(0, 3);
}

function getStructuredExecutionStrategy(
  patterns: ToolResultPattern[],
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (patterns.includes('auth') && patterns.includes('permission')) {
    return t('chat.recovery.structured.strategy.authPermission');
  }
  if (patterns.includes('network') && patterns.includes('timeout')) {
    return t('chat.recovery.structured.strategy.networkTimeout');
  }
  if (patterns.includes('rate_limit') && patterns.includes('timeout')) {
    return t('chat.recovery.structured.strategy.rateLimitTimeout');
  }

  const primary = getPrimaryToolResultPattern(patterns);
  switch (primary) {
    case 'auth':
      return t('chat.recovery.structured.strategy.auth');
    case 'permission':
      return t('chat.recovery.structured.strategy.permission');
    case 'rate_limit':
      return t('chat.recovery.structured.strategy.rateLimit');
    case 'network':
      return t('chat.recovery.structured.strategy.network');
    case 'timeout':
      return t('chat.recovery.structured.strategy.timeout');
    case 'conflict':
      return t('chat.recovery.structured.strategy.conflict');
    case 'not_found':
      return t('chat.recovery.structured.strategy.notFound');
    case 'missing_input':
      return t('chat.recovery.structured.strategy.missingInput');
    case 'parse':
      return t('chat.recovery.structured.strategy.parse');
    default:
      return t('chat.recovery.structured.strategy.default');
  }
}

function getStructuredRecoverySuggestion(
  task: string,
  suggestedMessage: string,
  toolResult: string,
  patterns: ToolResultPattern[],
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const patternLabel =
    patterns.length > 0
      ? patterns.slice(0, 3).map((pattern) => formatPatternLabel(pattern, t)).join(' + ')
      : t('chat.recovery.pattern.none');
  const evidenceLine = sanitizeStructuredLine(toolResult, 120) || t('chat.recovery.structured.none');
  const actionLine =
    sanitizeStructuredLine(suggestedMessage, 160) ||
    sanitizeStructuredLine(t('chat.recovery.suggestedMessage.continue'), 160);
  const goalLine = sanitizeStructuredLine(task, 100) || t('chat.recovery.structured.unknownGoal');
  const checklist = getStructuredChecklistItems(patterns, t);
  const strategy = getStructuredExecutionStrategy(patterns, t);
  return [
    t('chat.recovery.structured.goal', { task: goalLine }),
    t('chat.recovery.structured.pattern', { pattern: patternLabel }),
    t('chat.recovery.structured.checks', {
      checks: checklist.length > 0 ? checklist.join('；') : t('chat.recovery.structured.none'),
    }),
    t('chat.recovery.structured.strategy', { strategy }),
    t('chat.recovery.structured.evidence', { evidence: evidenceLine }),
    t('chat.recovery.structured.nextAction', { action: actionLine }),
    t('chat.recovery.structured.constraints'),
  ].join('\n');
}

function buildStructuredVariantTemplate(
  task: string,
  patternLabel: string,
  focus: string,
  action: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const goalLine = sanitizeStructuredLine(task, 100) || t('chat.recovery.structured.unknownGoal');
  return [
    t('chat.recovery.structured.goal', { task: goalLine }),
    t('chat.recovery.structured.pattern', { pattern: patternLabel }),
    t('chat.recovery.structured.focus', { focus }),
    t('chat.recovery.structured.nextAction', { action }),
    t('chat.recovery.structured.constraints'),
  ].join('\n');
}

function getStructuredRecoveryVariants(
  task: string,
  patterns: ToolResultPattern[],
  t: (key: string, vars?: Record<string, string | number>) => string,
): StructuredRecoveryVariant[] {
  const primary = getPrimaryToolResultPattern(patterns);
  if (!primary) {
    return [];
  }
  const patternLabel = formatPatternLabel(primary, t);

  switch (primary) {
    case 'conflict':
      return [
        {
          key: 'reuse',
          label: t('chat.recovery.variant.conflictReuse.label'),
          template: buildStructuredVariantTemplate(
            task,
            patternLabel,
            t('chat.recovery.variant.conflictReuse.focus'),
            t('chat.recovery.variant.conflictReuse.action'),
            t,
          ),
        },
        {
          key: 'rename',
          label: t('chat.recovery.variant.conflictRename.label'),
          template: buildStructuredVariantTemplate(
            task,
            patternLabel,
            t('chat.recovery.variant.conflictRename.focus'),
            t('chat.recovery.variant.conflictRename.action'),
            t,
          ),
        },
        {
          key: 'update',
          label: t('chat.recovery.variant.conflictUpdate.label'),
          template: buildStructuredVariantTemplate(
            task,
            patternLabel,
            t('chat.recovery.variant.conflictUpdate.focus'),
            t('chat.recovery.variant.conflictUpdate.action'),
            t,
          ),
        },
      ];
    case 'auth':
      return [
        {
          key: 'refresh-credentials',
          label: t('chat.recovery.variant.authRefresh.label'),
          template: buildStructuredVariantTemplate(
            task,
            patternLabel,
            t('chat.recovery.variant.authRefresh.focus'),
            t('chat.recovery.variant.authRefresh.action'),
            t,
          ),
        },
        {
          key: 'verify-endpoint',
          label: t('chat.recovery.variant.authEndpoint.label'),
          template: buildStructuredVariantTemplate(
            task,
            patternLabel,
            t('chat.recovery.variant.authEndpoint.focus'),
            t('chat.recovery.variant.authEndpoint.action'),
            t,
          ),
        },
      ];
    case 'permission':
      return [
        {
          key: 'verify-role',
          label: t('chat.recovery.variant.permissionRole.label'),
          template: buildStructuredVariantTemplate(
            task,
            patternLabel,
            t('chat.recovery.variant.permissionRole.focus'),
            t('chat.recovery.variant.permissionRole.action'),
            t,
          ),
        },
        {
          key: 'narrow-scope',
          label: t('chat.recovery.variant.permissionScope.label'),
          template: buildStructuredVariantTemplate(
            task,
            patternLabel,
            t('chat.recovery.variant.permissionScope.focus'),
            t('chat.recovery.variant.permissionScope.action'),
            t,
          ),
        },
      ];
    case 'rate_limit':
      return [
        {
          key: 'backoff',
          label: t('chat.recovery.variant.rateLimitBackoff.label'),
          template: buildStructuredVariantTemplate(
            task,
            patternLabel,
            t('chat.recovery.variant.rateLimitBackoff.focus'),
            t('chat.recovery.variant.rateLimitBackoff.action'),
            t,
          ),
        },
        {
          key: 'reduce-scope',
          label: t('chat.recovery.variant.rateLimitReduce.label'),
          template: buildStructuredVariantTemplate(
            task,
            patternLabel,
            t('chat.recovery.variant.rateLimitReduce.focus'),
            t('chat.recovery.variant.rateLimitReduce.action'),
            t,
          ),
        },
      ];
    case 'network':
      return [
        {
          key: 'connectivity-check',
          label: t('chat.recovery.variant.networkCheck.label'),
          template: buildStructuredVariantTemplate(
            task,
            patternLabel,
            t('chat.recovery.variant.networkCheck.focus'),
            t('chat.recovery.variant.networkCheck.action'),
            t,
          ),
        },
        {
          key: 'short-retry',
          label: t('chat.recovery.variant.networkRetry.label'),
          template: buildStructuredVariantTemplate(
            task,
            patternLabel,
            t('chat.recovery.variant.networkRetry.focus'),
            t('chat.recovery.variant.networkRetry.action'),
            t,
          ),
        },
      ];
    case 'timeout':
      return [
        {
          key: 'split-step',
          label: t('chat.recovery.variant.timeoutSplit.label'),
          template: buildStructuredVariantTemplate(
            task,
            patternLabel,
            t('chat.recovery.variant.timeoutSplit.focus'),
            t('chat.recovery.variant.timeoutSplit.action'),
            t,
          ),
        },
        {
          key: 'short-path',
          label: t('chat.recovery.variant.timeoutPath.label'),
          template: buildStructuredVariantTemplate(
            task,
            patternLabel,
            t('chat.recovery.variant.timeoutPath.focus'),
            t('chat.recovery.variant.timeoutPath.action'),
            t,
          ),
        },
      ];
    default:
      return [];
  }
}

function getToolResultPatternMeta(
  pattern: ToolResultPattern | null,
  t: (key: string, vars?: Record<string, string | number>) => string,
): { label: string; variant: 'green' | 'blue' | 'yellow' | 'red' | 'purple' | 'gray' } | null {
  switch (pattern) {
    case 'auth':
      return { label: t('chat.recovery.pattern.auth'), variant: 'red' };
    case 'permission':
      return { label: t('chat.recovery.pattern.permission'), variant: 'red' };
    case 'not_found':
      return { label: t('chat.recovery.pattern.notFound'), variant: 'blue' };
    case 'missing_input':
      return { label: t('chat.recovery.pattern.missingInput'), variant: 'gray' };
    case 'parse':
      return { label: t('chat.recovery.pattern.parse'), variant: 'yellow' };
    case 'conflict':
      return { label: t('chat.recovery.pattern.conflict'), variant: 'purple' };
    case 'timeout':
      return { label: t('chat.recovery.pattern.timeout'), variant: 'yellow' };
    case 'rate_limit':
      return { label: t('chat.recovery.pattern.rateLimit'), variant: 'yellow' };
    case 'network':
      return { label: t('chat.recovery.pattern.network'), variant: 'blue' };
    default:
      return null;
  }
}

function getRecoveryEvidenceContext(messages: Message[]): RecoveryEvidenceContext {
  const latestUserMessage = findLastMessage(messages, 'user');
  const latestAssistantMessage = findLastMessage(messages, 'assistant');
  return {
    userContext: latestUserMessage ? truncateText(latestUserMessage.content) : '',
    assistantContext:
      latestAssistantMessage && !latestAssistantMessage.content.startsWith('Error:')
        ? truncateText(latestAssistantMessage.content)
        : '',
    toolContext: summarizeToolContext(messages),
    toolInputContext: summarizeToolInputContext(messages),
    toolResultContext: summarizeToolResultContext(messages),
    errorFragment: summarizeErrorFragment(messages),
  };
}

function formatErrorCode(errorCode: string): string {
  return errorCode.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function getRecoveryInputPlaceholder(
  recoveryContext: ChatRecoveryContext | null,
  t: (key: string) => string,
): string {
  if (!recoveryContext) {
    return t('chat.inputPlaceholder');
  }
  if (recoveryContext.mode === 'new_thread') {
    return t('chat.recovery.inputPlaceholder.newThread');
  }
  switch (recoveryContext.errorCode) {
    case 'rate_limit':
    case 'overloaded':
    case 'transient_http':
      return t('chat.recovery.inputPlaceholder.retry');
    case 'tool_round_limit':
      return t('chat.recovery.inputPlaceholder.splitTask');
    case 'billing':
      return t('chat.recovery.inputPlaceholder.billing');
    case 'tool_loop':
      return t('chat.recovery.inputPlaceholder.inspect');
    default:
      return t('chat.recovery.inputPlaceholder.continue');
  }
}

function getRecoverySuggestedMessage(
  recoveryContext: ChatRecoveryContext,
  messages: Message[],
  t: (key: string) => string,
): string {
  const { userContext, assistantContext, toolContext, toolInputContext, toolResultContext, errorFragment } =
    getRecoveryEvidenceContext(messages);
  const toolResultPatterns = detectToolResultPatterns(messages);

  if (recoveryContext.mode !== 'new_thread' && userContext) {
    if (toolResultPatterns.length > 0 && toolResultContext) {
      return getPatternGuidedRecoveryMessage(toolResultPatterns, userContext, toolResultContext, t);
    }
    switch (recoveryContext.errorCode) {
      case 'rate_limit':
      case 'overloaded':
      case 'transient_http':
        return toolResultContext
          ? t('chat.recovery.suggestedMessage.retryWithToolResult', {
              task: userContext,
              toolResult: toolResultContext,
            })
          : errorFragment
          ? t('chat.recovery.suggestedMessage.retryWithError', {
              task: userContext,
              error: errorFragment,
            })
          : t('chat.recovery.suggestedMessage.retryWithContext', { task: userContext });
      case 'tool_round_limit':
        return toolResultContext
          ? t('chat.recovery.suggestedMessage.splitTaskWithToolResult', {
              task: userContext,
              toolResult: toolResultContext,
            })
          : toolInputContext
          ? t('chat.recovery.suggestedMessage.splitTaskWithToolInput', {
              task: userContext,
              toolInput: toolInputContext,
            })
          : toolContext
          ? t('chat.recovery.suggestedMessage.splitTaskWithTools', {
              task: userContext,
              tools: toolContext,
            })
          : t('chat.recovery.suggestedMessage.splitTaskWithContext', { task: userContext });
      case 'billing':
        return toolResultContext
          ? t('chat.recovery.suggestedMessage.billingWithToolResult', {
              task: userContext,
              toolResult: toolResultContext,
            })
          : t('chat.recovery.suggestedMessage.billingWithContext', { task: userContext });
      case 'tool_loop':
        return toolResultContext
          ? t('chat.recovery.suggestedMessage.inspectWithToolResult', {
              task: userContext,
              toolResult: toolResultContext,
            })
          : toolInputContext
          ? t('chat.recovery.suggestedMessage.inspectWithToolInput', {
              task: userContext,
              toolInput: toolInputContext,
            })
          : toolContext
          ? t('chat.recovery.suggestedMessage.inspectWithTools', {
              task: userContext,
              tools: toolContext,
            })
          : t('chat.recovery.suggestedMessage.inspectWithContext', { task: userContext });
      default:
        return toolResultContext
          ? t('chat.recovery.suggestedMessage.continueWithToolResult', {
              task: userContext,
              toolResult: toolResultContext,
            })
          : assistantContext
          ? t('chat.recovery.suggestedMessage.continueWithProgress', {
              task: userContext,
              progress: assistantContext,
            })
          : t('chat.recovery.suggestedMessage.continueWithContext', { task: userContext });
    }
  }

  if (recoveryContext.mode === 'new_thread') {
    return t('chat.recovery.suggestedMessage.newThread');
  }
  switch (recoveryContext.errorCode) {
    case 'rate_limit':
    case 'overloaded':
    case 'transient_http':
      return t('chat.recovery.suggestedMessage.retry');
    case 'tool_round_limit':
      return t('chat.recovery.suggestedMessage.splitTask');
    case 'billing':
      return t('chat.recovery.suggestedMessage.billing');
    case 'tool_loop':
      return t('chat.recovery.suggestedMessage.inspect');
    default:
      return t('chat.recovery.suggestedMessage.continue');
  }
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function AgentPanel({ agent, initialThreadKey, recoveryContext }: AgentPanelProps) {
  const { t } = useLocale();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmRecoverySend, setConfirmRecoverySend] = useState(false);
  const [currentThread, setCurrentThread] = useState(`console:${agent.agentId}`);
  const [visibleRecoveryContext, setVisibleRecoveryContext] = useState<ChatRecoveryContext | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const focusedRecoveryEventIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (initialThreadKey) {
      setCurrentThread(initialThreadKey);
    }
  }, [initialThreadKey]);

  useEffect(() => {
    if (recoveryContext?.eventId) {
      setVisibleRecoveryContext(recoveryContext);
    }
  }, [recoveryContext?.eventId, recoveryContext]);

  const [showSessions, setShowSessions] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Sessions for this agent (for thread selection)
  const { data: sessionsData, refetch: refetchSessions } = useQuery<SessionListResult>(
    () => rpc<SessionListResult>('session.list'),
    [],
  );
  const agentSessions: SessionMetaInfo[] = (sessionsData?.sessions ?? [])
    .filter((s) => s.agentId === agent.agentId)
    .sort((a, b) => b.lastActivity - a.lastActivity);

  // Reload history whenever thread changes
  useEffect(() => {
    const sessionKey = `agent:${agent.agentId}:${currentThread}`;
    rpc<SessionMessagesResult>('session.messages', { sessionKey, includeToolResults: true })
      .then((res) => {
        setMessages(
          res.messages.map((m) => ({
            role: m.isToolResult ? 'assistant' : m.role,
            content: m.text,
            tools: m.tools?.map((t) => ({ id: '', name: t.name, input: t.input })),
            toolResults: m.toolResults,
          })),
        );
      })
      .catch(() => setMessages([]));
  }, [currentThread]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadSession = (session: SessionMetaInfo) => {
    setCurrentThread(session.threadKey);
    setShowSessions(false);
  };

  const startNewThread = () => {
    const newThread = createConsoleThreadKey(agent.agentId);
    setCurrentThread(newThread);
    setMessages([]);
    setShowSessions(false);
  };

  useEffect(() => {
    if (visibleRecoveryContext && currentThread !== visibleRecoveryContext.threadKey) {
      setVisibleRecoveryContext(null);
    }
  }, [currentThread, visibleRecoveryContext]);

  useEffect(() => {
    setConfirmRecoverySend(false);
  }, [visibleRecoveryContext?.eventId, currentThread]);

  useEffect(() => {
    if (!confirmRecoverySend) {
      return;
    }
    const timer = window.setTimeout(() => setConfirmRecoverySend(false), 2500);
    return () => window.clearTimeout(timer);
  }, [confirmRecoverySend]);

  useEffect(() => {
    if (!visibleRecoveryContext?.eventId) {
      return;
    }
    if (focusedRecoveryEventIdRef.current === visibleRecoveryContext.eventId) {
      return;
    }
    focusedRecoveryEventIdRef.current = visibleRecoveryContext.eventId;
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      const caret = inputRef.current?.value.length ?? 0;
      inputRef.current?.setSelectionRange(caret, caret);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [visibleRecoveryContext]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const recoveryEvidence = getRecoveryEvidenceContext(messages);
  const recoveryPatterns = detectToolResultPatterns(messages);
  const recoveryPatternMetas = recoveryPatterns
    .map((pattern) => getToolResultPatternMeta(pattern, t))
    .filter(
      (
        meta,
      ): meta is { label: string; variant: 'green' | 'blue' | 'yellow' | 'red' | 'purple' | 'gray' } => Boolean(meta),
    );
  const inputPlaceholder = getRecoveryInputPlaceholder(visibleRecoveryContext, t);
  const suggestedRecoveryMessage = visibleRecoveryContext
    ? getRecoverySuggestedMessage(visibleRecoveryContext, messages, t)
    : '';
  const structuredRecoveryMessage = visibleRecoveryContext
    ? getStructuredRecoverySuggestion(
        recoveryEvidence.userContext,
        suggestedRecoveryMessage,
        recoveryEvidence.toolResultContext,
        recoveryPatterns,
        t,
      )
    : '';
  const structuredRecoveryVariants = visibleRecoveryContext
    ? getStructuredRecoveryVariants(recoveryEvidence.userContext, recoveryPatterns, t)
    : [];
  const recoveryEvidenceEntries = buildRecoveryEvidenceEntries(messages, t);

  const buildRecoverySuggestionInput = (baseInput: string): string => {
    if (!suggestedRecoveryMessage) {
      return baseInput;
    }
    const trimmed = baseInput.trim();
    if (!trimmed) {
      return suggestedRecoveryMessage;
    }
    if (baseInput.includes(suggestedRecoveryMessage)) {
      return baseInput;
    }
    return `${baseInput.trimEnd()}\n\n${suggestedRecoveryMessage}`;
  };

  const buildStructuredRecoveryInput = (baseInput: string): string => {
    if (!structuredRecoveryMessage) {
      return baseInput;
    }
    const trimmed = baseInput.trim();
    if (!trimmed) {
      return structuredRecoveryMessage;
    }
    if (baseInput.includes(structuredRecoveryMessage)) {
      return baseInput;
    }
    return `${baseInput.trimEnd()}\n\n${structuredRecoveryMessage}`;
  };

  const buildCustomStructuredInput = (baseInput: string, template: string): string => {
    if (!template) {
      return baseInput;
    }
    const trimmed = baseInput.trim();
    if (!trimmed) {
      return template;
    }
    if (baseInput.includes(template)) {
      return baseInput;
    }
    return `${baseInput.trimEnd()}\n\n${template}`;
  };

  const applyRecoverySuggestion = () => {
    if (!suggestedRecoveryMessage) {
      return;
    }
    setInput((prev) => buildRecoverySuggestionInput(prev));
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      const caret = inputRef.current?.value.length ?? 0;
      inputRef.current?.setSelectionRange(caret, caret);
    });
  };

  const applyStructuredRecoverySuggestion = () => {
    if (!structuredRecoveryMessage) {
      return;
    }
    setInput((prev) => buildStructuredRecoveryInput(prev));
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      const caret = inputRef.current?.value.length ?? 0;
      inputRef.current?.setSelectionRange(caret, caret);
    });
  };

  const applyStructuredRecoveryVariant = (template: string) => {
    if (!template) {
      return;
    }
    setInput((prev) => buildCustomStructuredInput(prev, template));
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      const caret = inputRef.current?.value.length ?? 0;
      inputRef.current?.setSelectionRange(caret, caret);
    });
  };

  const sendMessage = async (messageText = input) => {
    const text = messageText.trim();
    if (!text || busy) return;
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    setBusy(true);

    const TOKEN = window.__AF_TOKEN__;
    const PORT = window.__AF_PORT__;

    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ agentId: agent.agentId, message: text, thread: currentThread }),
      });

      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let replyContent = '';
      let thinkingContent = '';
      const pendingTools = new Map<string, ToolCall>();

      setMessages((prev) => [...prev, { role: 'assistant', content: '', streaming: true }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });

        const parts = buf.split('\n');
        buf = parts.pop() ?? '';

        for (const line of parts) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') break;
          let chunk: ChatChunk;
          try {
            chunk = JSON.parse(payload) as ChatChunk;
          } catch {
            continue;
          }

          if (chunk.type === 'text_delta') {
            replyContent += chunk.text;
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') {
                next[next.length - 1] = { ...last, content: replyContent, streaming: true };
              }
              return next;
            });
          } else if (chunk.type === 'thinking' || chunk.type === 'thinking_delta') {
            thinkingContent += chunk.text;
            setMessages((prev) => {
              const next = [...prev];
              const lastIdx = next.length - 1;
              const last = next[lastIdx];
              if (last?.role === 'assistant' && last.streaming && !last.content) {
                const thinkIdx = lastIdx - 1;
                if (thinkIdx >= 0 && next[thinkIdx]?.role === 'thinking') {
                  next[thinkIdx] = {
                    ...next[thinkIdx]!,
                    content: thinkingContent,
                    streaming: true,
                  };
                } else {
                  next.splice(lastIdx, 0, {
                    role: 'thinking',
                    content: thinkingContent,
                    streaming: true,
                  });
                }
              } else {
                let thinkIdx = -1;
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i]?.role === 'thinking' && next[i]?.streaming) {
                    thinkIdx = i;
                    break;
                  }
                }
                if (thinkIdx >= 0) {
                  next[thinkIdx] = { ...next[thinkIdx]!, content: thinkingContent };
                }
              }
              return next;
            });
          } else if (chunk.type === 'tool_use_start') {
            pendingTools.set(chunk.id, { id: chunk.id, name: chunk.name, input: '' });
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.role === 'assistant') {
                const tools = [...(last.tools ?? [])];
                const existingIdx = tools.findIndex((t) => t.id === chunk.id);
                if (existingIdx >= 0) {
                  tools[existingIdx] = { id: chunk.id, name: chunk.name, input: '' };
                } else {
                  tools.push({ id: chunk.id, name: chunk.name, input: '' });
                }
                next[next.length - 1] = { ...last, tools };
              }
              return next;
            });
          } else if (chunk.type === 'tool_use_delta') {
            const tool = pendingTools.get(chunk.id);
            if (tool) {
              tool.input += chunk.inputJson;
              pendingTools.set(chunk.id, tool);
            }
          } else if (chunk.type === 'tool_result') {
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.role === 'assistant') {
                const toolResults = [...(last.toolResults ?? [])];
                toolResults.push({ content: chunk.content, isError: chunk.isError });
                next[next.length - 1] = { ...last, toolResults };
              }
              return next;
            });
          } else if (chunk.type === 'done') {
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.role === 'assistant') {
                next[next.length - 1] = {
                  ...last,
                  streaming: false,
                  usage: {
                    input: chunk.inputTokens,
                    output: chunk.outputTokens,
                    cacheRead: chunk.cacheReadTokens,
                    cacheWrite: chunk.cacheWriteTokens,
                  },
                };
              }
              let thinkIdx = -1;
              for (let i = next.length - 1; i >= 0; i--) {
                if (next[i]?.role === 'thinking' && next[i]?.streaming) {
                  thinkIdx = i;
                  break;
                }
              }
              if (thinkIdx >= 0) next[thinkIdx] = { ...next[thinkIdx]!, streaming: false };
              return next;
            });
          } else if (chunk.type === 'error') {
            throw new Error(chunk.message);
          }
        }
      }

      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') {
          next[next.length - 1] = { ...last, streaming: false };
        }
        return next;
      });
    } catch (e) {
      setMessages((prev) => {
        const next = [...prev];
        if (next[next.length - 1]?.streaming) next.pop();
        return [
          ...next,
          { role: 'assistant', content: `Error: ${e instanceof Error ? e.message : String(e)}` },
        ];
      });
    } finally {
      setBusy(false);
    }
  };

  const sendRecoverySuggestion = async () => {
    if (!confirmRecoverySend) {
      setConfirmRecoverySend(true);
      return;
    }
    setConfirmRecoverySend(false);
    const nextInput = buildRecoverySuggestionInput(input);
    await sendMessage(nextInput);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col">
      {/* Panel header */}
      <div className="flex items-center justify-between pb-3 shrink-0 border-b border-slate-700/50 gap-2 flex-wrap">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-semibold text-slate-100">
            {agent.name ?? agent.agentId}
          </span>
          <span
            className="font-mono text-[10px] text-slate-500 truncate max-w-[240px]"
            title={currentThread}
          >
            🧵 {currentThread}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="relative">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setShowSessions((v) => !v);
                void refetchSessions();
              }}
            >
              {t('chat.sessions', { n: agentSessions.length })}
            </Button>
            {showSessions && (
              <div className="absolute right-0 top-full mt-1 w-80 bg-slate-900 ring-1 ring-slate-700 rounded-xl shadow-2xl z-50 overflow-hidden">
                <div className="px-3 py-2 border-b border-slate-700/60 flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-300">{t('chat.selectThread')}</span>
                  <button
                    onClick={() => setShowSessions(false)}
                    className="text-slate-500 hover:text-slate-300 text-xs"
                  >
                    ✕
                  </button>
                </div>
                <div className="max-h-72 overflow-y-auto">
                  <button
                    onClick={startNewThread}
                    className="w-full px-3 py-2.5 text-left hover:bg-slate-700/50 border-b border-slate-700/40 flex items-center gap-2"
                  >
                    <span className="text-emerald-400 text-xs">＋</span>
                    <span className="text-xs text-slate-300">{t('chat.newThread')}</span>
                  </button>
                  {agentSessions.length === 0 && (
                    <p className="text-xs text-slate-500 px-3 py-3">{t('chat.noSessionsYet')}</p>
                  )}
                  {agentSessions.map((s) => (
                    <button
                      key={s.sessionKey}
                      onClick={() => loadSession(s)}
                      className={`w-full px-3 py-2.5 text-left hover:bg-slate-700/50 flex flex-col gap-0.5 ${
                        s.threadKey === currentThread ? 'bg-indigo-600/20' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-mono text-slate-300 truncate">
                          {s.threadKey}
                        </span>
                        {s.threadKey === currentThread && (
                          <span className="text-[10px] text-indigo-400 ml-1 shrink-0">{t('chat.active')}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-slate-500">
                        <span>{s.messageCount} msgs</span>
                        <span>·</span>
                        <span>{timeAgo(s.lastActivity)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setMessages([]);
              void rpc('session.clear', { sessionKey: `agent:${agent.agentId}:${currentThread}` });
            }}
          >
            {t('common.clear')}
          </Button>
        </div>
      </div>

      {visibleRecoveryContext ? (
        <div className="mt-3 rounded-xl bg-amber-950/20 ring-1 ring-amber-500/15 px-4 py-3 flex items-start justify-between gap-3 flex-wrap shrink-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="red">{formatErrorCode(visibleRecoveryContext.errorCode)}</Badge>
              <span className="text-sm font-medium text-amber-200">
                {visibleRecoveryContext.mode === 'new_thread'
                  ? t('chat.recovery.newThreadTitle')
                  : t('chat.recovery.continueTitle')}
              </span>
            </div>
            <div className="mt-1 text-xs text-amber-100/80 leading-5">
              {visibleRecoveryContext.mode === 'new_thread'
                ? t('chat.recovery.newThreadDesc')
                : t('chat.recovery.continueDesc')}
            </div>
            <div className="mt-3 rounded-lg bg-slate-950/30 ring-1 ring-white/5 px-3 py-2.5">
              <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-amber-300/80">
                {t('chat.recovery.suggestedMessageLabel')}
              </div>
              <div className="mt-1 text-xs text-slate-200/90 leading-5 whitespace-pre-wrap">
                {suggestedRecoveryMessage}
              </div>
            </div>
            <div className="mt-3 rounded-lg bg-slate-950/25 ring-1 ring-white/5 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-300/80">
                  {t('chat.recovery.structuredLabel')}
                </div>
                <Button size="sm" variant="ghost" onClick={applyStructuredRecoverySuggestion} disabled={!structuredRecoveryMessage}>
                  {t('chat.recovery.useStructuredSuggestion')}
                </Button>
              </div>
              <div className="mt-2 text-xs text-slate-200/90 leading-5 whitespace-pre-wrap break-words">
                {structuredRecoveryMessage}
              </div>
              {structuredRecoveryVariants.length > 0 ? (
                <div className="mt-3 flex flex-col gap-2">
                  <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-400/80">
                    {t('chat.recovery.variantLabel')}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {structuredRecoveryVariants.map((variant) => (
                      <Button
                        key={variant.key}
                        size="sm"
                        variant="default"
                        className="!px-2 !py-1"
                        onClick={() => applyStructuredRecoveryVariant(variant.template)}
                      >
                        {variant.label}
                      </Button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            {recoveryEvidenceEntries.length > 0 ? (
              <div className="mt-3 rounded-lg bg-slate-950/25 ring-1 ring-white/5 px-3 py-2.5">
                <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-slate-300/80">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span>{t('chat.recovery.evidenceLabel')}</span>
                    {recoveryPatternMetas.map((meta) => (
                      <Badge key={`${meta.variant}-${meta.label}`} variant={meta.variant}>
                        {t('chat.recovery.patternDetected')}: {meta.label}
                      </Badge>
                    ))}
                    </div>
                </div>
                <div className="mt-2 flex flex-col gap-2">
                  {recoveryEvidenceEntries.map((entry) => (
                    <RecoveryEvidenceCard key={entry.key} entry={entry} />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button size="sm" variant="default" onClick={applyRecoverySuggestion}>
              {t('chat.recovery.useSuggestion')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => void sendRecoverySuggestion()}
              disabled={busy || !suggestedRecoveryMessage}
            >
              {confirmRecoverySend
                ? t('chat.recovery.confirmSendSuggestion')
                : t('chat.recovery.sendSuggestion')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setVisibleRecoveryContext(null)}>
              {t('chat.recovery.dismiss')}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto flex flex-col gap-4 pr-1 min-h-0 pt-3">
        {messages.length === 0 && (
          <div className="text-center text-slate-500 text-sm mt-12">
            {t('chat.startConversation', { name: agent.name ?? agent.agentId })}
          </div>
        )}
        {messages.map((msg, i) => (
          <ChatBubble key={i} msg={msg} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="pt-3 shrink-0">
        <div className="relative flex items-end gap-2 bg-slate-800/60 ring-1 ring-slate-700/50 rounded-xl p-3">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={inputPlaceholder}
            rows={2}
            disabled={busy}
            className="flex-1 bg-transparent text-slate-200 text-sm placeholder:text-slate-500 resize-none focus:outline-none min-h-10"
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => void sendMessage()}
            disabled={busy || !input.trim()}
          >
            {busy ? '…' : t('chat.send')}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Main ChatTab: left sidebar agent list + right panel ──────────────────────

export function ChatTab({
  initialAgentId = '',
  initialThreadKey = '',
  initialRecoveryContext = null,
}: {
  initialAgentId?: string;
  initialThreadKey?: string;
  initialRecoveryContext?: ChatRecoveryContext | null;
}) {
  const { t } = useLocale();
  const [activeAgentId, setActiveAgentId] = useState<string>('');

  const { data: agentsResult, refetch } = useQuery<AgentListResult>(
    () => rpc<AgentListResult>('agent.list'),
    [],
  );
  const agents: AgentInfo[] = Array.isArray(agentsResult?.agents) ? agentsResult.agents : [];

  // Derive effective selected agent: fall back to first in list while state hasn't synced yet.
  // This prevents the brief flash where agents are loaded but none appears selected.
  const effectiveActiveId = activeAgentId || agents[0]?.agentId || '';

  useEffect(() => {
    if (initialAgentId) {
      setActiveAgentId(initialAgentId);
    }
  }, [initialAgentId]);

  // Persist the selection so explicit clicks are remembered after refetch
  useEffect(() => {
    if (!activeAgentId && agents.length > 0) {
      setActiveAgentId(agents[0]?.agentId);
    }
  }, [agents, activeAgentId]);

  return (
    <div className="flex h-[calc(100vh-4rem)] gap-0">
      {/* Left: agent list sidebar */}
      <div className="w-48 shrink-0 flex flex-col border-r border-slate-700/50 pr-2 mr-3">
        <div className="flex items-center justify-between pb-3 shrink-0">
          <h1 className="text-sm font-semibold text-slate-100">{t('chat.title')}</h1>
          <Button size="sm" variant="ghost" onClick={refetch}>
            ↺
          </Button>
        </div>
        <div className="flex flex-col gap-1 flex-1 overflow-y-auto">
          {agents.length === 0 && <p className="text-xs text-slate-500 pt-2">{t('chat.noAgents')}</p>}
          {agents.map((a) => {
            const active = a.agentId === effectiveActiveId;
            return (
              <button
                key={a.agentId}
                onClick={() => setActiveAgentId(a.agentId)}
                className={`flex flex-col items-start px-2.5 py-2 rounded-lg text-left w-full transition-all duration-100 ${
                  active
                    ? 'bg-indigo-600/30 text-indigo-200 ring-1 ring-indigo-500/40'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/40'
                }`}
              >
                <span className="text-xs font-medium truncate w-full">{a.name ?? a.agentId}</span>
                {a.name && (
                  <span className="text-[10px] font-mono text-slate-500 truncate w-full">
                    {a.agentId}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Right: only the active agent panel is mounted */}
      <div className="flex-1 min-w-0 relative overflow-hidden">
        {agents.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-sm">
            {t('chat.noAgentsAvailable')}
          </div>
        ) : (
          (() => {
            const activeAgent = agents.find((a) => a.agentId === effectiveActiveId) ?? agents[0];
            return activeAgent ? (
              <AgentPanel
                key={activeAgent.agentId}
                agent={activeAgent}
                initialThreadKey={activeAgent.agentId === effectiveActiveId ? initialThreadKey : ''}
                recoveryContext={
                  initialRecoveryContext?.agentId === activeAgent.agentId ? initialRecoveryContext : null
                }
              />
            ) : null;
          })()
        )}
      </div>
    </div>
  );
}

function ThinkingBubble({ msg }: { msg: Message }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs bg-slate-800/30 rounded-lg ring-1 ring-slate-700/30 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-slate-500 hover:text-slate-400 transition-colors"
      >
        <span className="text-[10px] leading-none">{open ? '▾' : '▸'}</span>
        <span className="italic">
          {msg.streaming ? (
            <span className="animate-pulse">{t('chat.thinking')}</span>
          ) : (
            t('chat.reasoning', { n: msg.content.length })
          )}
        </span>
      </button>
      {open && (
        <pre className="px-3 pb-3 whitespace-pre-wrap font-mono text-slate-500 text-[11px] border-t border-slate-700/30">
          {msg.content}
        </pre>
      )}
    </div>
  );
}

function ToolCallList({ tools }: { tools: ToolCall[] }) {
  return (
    <div className="flex flex-col gap-1.5 mt-1">
      {tools.map((tool) => (
        <div
          key={tool.id}
          className="flex items-center gap-2 text-[11px] bg-slate-900/60 ring-1 ring-slate-700/40 rounded-lg px-3 py-1.5"
        >
          <span className="text-amber-400 font-mono font-semibold">{tool.name}</span>
          {tool.input && (
            <span className="text-slate-500 truncate max-w-[260px] font-mono">{tool.input}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function CollapsibleTextBlock({
  text,
  tone = 'default',
}: {
  text: string;
  tone?: 'default' | 'success' | 'error';
}) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const normalizedText = text.trim();
  const previewText = truncateText(compactText(normalizedText), RECOVERY_EVIDENCE_PREVIEW_LENGTH);
  const lineCount = normalizedText.split(/\r?\n/).length;
  const canExpand =
    normalizedText.length > previewText.length || lineCount > COLLAPSIBLE_TEXT_LINE_LIMIT;
  const visibleText = expanded || !canExpand ? normalizedText : previewText;
  const toneClass =
    tone === 'error'
      ? 'bg-red-950/30 ring-red-500/30 text-red-200'
      : tone === 'success'
      ? 'bg-emerald-950/20 ring-emerald-500/20 text-emerald-100'
      : 'bg-white/[0.03] ring-white/[0.05] text-slate-200/90';

  return (
    <div className={`rounded-md px-2.5 py-2 ring-1 ${toneClass}`}>
      <div className="text-xs leading-5 whitespace-pre-wrap break-words">{visibleText}</div>
      {normalizedText ? (
        <div className="mt-2 flex items-center justify-end gap-2">
          {canExpand ? (
            <Button size="sm" variant="ghost" className="!px-2 !py-1 text-[10px]" onClick={() => setExpanded((value) => !value)}>
              {expanded ? t('common.showLess') : t('common.showMore')}
            </Button>
          ) : null}
          <CopyButton text={normalizedText} className="!text-[10px] !px-2 !py-1" />
        </div>
      ) : null}
    </div>
  );
}

function RecoveryEvidenceCard({ entry }: { entry: RecoveryEvidenceEntry }) {
  return (
    <div className="rounded-md bg-white/[0.03] px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-[0.08em] text-slate-400">{entry.label}</div>
      <div className="mt-1">
        <CollapsibleTextBlock text={entry.fullValue ?? entry.value} tone={entry.tone} />
      </div>
    </div>
  );
}

function ToolResultList({ toolResults }: { toolResults: ToolResult[] }) {
  return (
    <div className="flex flex-col gap-1.5 mt-1">
      {toolResults.map((result, index) => (
        <CollapsibleTextBlock
          key={`${result.isError ? 'error' : 'ok'}-${index}`}
          text={result.content}
          tone={result.isError ? 'error' : 'success'}
        />
      ))}
    </div>
  );
}

function TokenBadge({ usage }: { usage: TokenUsage }) {
  const total = usage.input + usage.output;
  const cacheNote = usage.cacheRead ? ` · ${usage.cacheRead.toLocaleString()} cached` : '';
  return (
    <div className="text-[10px] text-slate-600 mt-1 text-right font-mono">
      {usage.input.toLocaleString()}↑ {usage.output.toLocaleString()}↓ · {total.toLocaleString()}{' '}
      tokens{cacheNote}
    </div>
  );
}

function ChatBubble({ msg }: { msg: Message }) {
  if (msg.role === 'thinking') {
    return <ThinkingBubble msg={msg} />;
  }

  const isUser = msg.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 ${
          isUser
            ? 'bg-indigo-600/80 text-slate-100 rounded-br-sm'
            : 'bg-slate-800/80 ring-1 ring-slate-700/50 rounded-bl-sm'
        }`}
      >
        {isUser ? (
          <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <MarkdownView content={msg.content} />
            {msg.tools && msg.tools.length > 0 && <ToolCallList tools={msg.tools} />}
            {msg.toolResults && msg.toolResults.length > 0 && (
              <ToolResultList toolResults={msg.toolResults} />
            )}
            {msg.streaming && <span className="text-xs text-slate-500 animate-pulse">typing…</span>}
          </div>
        )}
        {!isUser && !msg.streaming && msg.content && (
          <div className="mt-1.5 flex justify-end">
            <CopyButton text={msg.content} />
          </div>
        )}
        {!isUser && !msg.streaming && msg.usage && <TokenBadge usage={msg.usage} />}
      </div>
    </div>
  );
}
