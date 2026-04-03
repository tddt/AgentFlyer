import { useEffect, useRef, useState } from 'react';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { CopyButton } from '../components/CopyButton.js';
import { DeliverableModal } from '../components/DeliverableModal.js';
import { useLocale } from '../context/i18n.js';
import { MarkdownView } from '../components/MarkdownView.js';
import { rpc, useQuery } from '../hooks/useRpc.js';
import { createConsoleThreadKey } from '../thread-keys.js';
import type { ChatRecoveryContext } from '../types.js';
import type {
  AgentInfo,
  AgentListResult,
  ChatChunk,
  InboxEvent,
  InboxEventKind,
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
  id?: string;
  role: 'user' | 'assistant' | 'thinking';
  content: string;
  timestamp?: number;
  streaming?: boolean;
  tools?: ToolCall[];
  toolResults?: ToolResult[];
  usage?: TokenUsage;
}

interface HubFocusTarget {
  eventId: number;
  agentId?: string;
  threadKey?: string;
  title: string;
  text: string;
  kind: InboxEventKind;
  channelId?: string;
  deliverableId?: string;
}

// ── Per-agent panel ──────────────────────────────────────────────────────────

interface AgentPanelProps {
  agent: AgentInfo;
  agents: AgentInfo[];
  initialThreadKey?: string;
  recoveryContext?: ChatRecoveryContext | null;
  hubFocusTarget?: HubFocusTarget | null;
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
const HUB_SEEN_EVENT_IDS_STORAGE_KEY = 'af.console.chat.hubSeenEventIds';
const HUB_PROCESSED_THREAD_KEYS_STORAGE_KEY = 'af.console.chat.hubProcessedThreads';

function readStoredStringArray(key: string): string[] {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function readStoredNumberArray(key: string): number[] {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is number => typeof item === 'number') : [];
  } catch {
    return [];
  }
}

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

function compactSearchText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function buildHubContextPrompt(target: HubFocusTarget, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const summary = target.text.trim() || target.title.trim();
  return t('chat.hub.contextPrompt', {
    title: target.title || t('chat.inbox.threadFallback'),
    summary: summary || t('chat.hub.contextEmpty'),
  });
}

function findHubMessageMatch(messages: Message[], target: HubFocusTarget | null): string | null {
  if (!target) {
    return null;
  }
  const needles = [target.text, target.title]
    .map((item) => compactSearchText(item))
    .filter((item) => item.length >= 8);
  if (needles.length === 0) {
    return null;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message?.id || message.role === 'thinking') {
      continue;
    }
    const haystack = compactSearchText(message.content);
    if (!haystack) {
      continue;
    }
    if (needles.some((needle) => haystack.includes(needle))) {
      return message.id;
    }
  }
  return null;
}

function normalizeMention(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function getInboxThreadKey(event: InboxEvent): string {
  if (event.threadKey) {
    return `thread:${event.threadKey}`;
  }
  if (event.deliverableId) {
    return `deliverable:${event.deliverableId}`;
  }
  return `${event.kind}:${event.agentId ?? 'unknown'}:${event.id}`;
}

function getAgentLabel(agentId: string | undefined, agents: AgentInfo[]): string {
  if (!agentId) {
    return 'system';
  }
  const matched = agents.find((agent) => agent.agentId === agentId);
  return matched?.name ?? matched?.agentId ?? agentId;
}

interface HubThread {
  key: string;
  threadKey?: string;
  title: string;
  preview: string;
  latestTs: number;
  latestEvent: InboxEvent;
  events: InboxEvent[];
  replyCount: number;
  deliverableCount: number;
  agentIds: string[];
}

interface HubThreadView extends HubThread {
  unreadCount: number;
  isProcessed: boolean;
}

function buildHubThreads(events: InboxEvent[]): HubThread[] {
  const grouped = new Map<string, HubThread>();
  for (const event of events) {
    const key = getInboxThreadKey(event);
    const existing = grouped.get(key);
    if (existing) {
      existing.events.push(event);
      existing.replyCount += event.kind === 'agent_reply' ? 1 : 0;
      existing.deliverableCount += event.kind === 'deliverable' ? 1 : 0;
      if (event.agentId && !existing.agentIds.includes(event.agentId)) {
        existing.agentIds.push(event.agentId);
      }
      if (event.ts >= existing.latestTs) {
        existing.latestTs = event.ts;
        existing.latestEvent = event;
        existing.title = event.title;
        existing.preview = event.text;
      }
      continue;
    }
    grouped.set(key, {
      key,
      threadKey: event.threadKey,
      title: event.title,
      preview: event.text,
      latestTs: event.ts,
      latestEvent: event,
      events: [event],
      replyCount: event.kind === 'agent_reply' ? 1 : 0,
      deliverableCount: event.kind === 'deliverable' ? 1 : 0,
      agentIds: event.agentId ? [event.agentId] : [],
    });
  }
  return Array.from(grouped.values())
    .map((thread) => ({
      ...thread,
      events: [...thread.events].sort((left, right) => left.ts - right.ts),
    }))
    .sort((left, right) => right.latestTs - left.latestTs);
}

function resolveMentionTarget(message: string, agents: AgentInfo[], fallbackAgentId: string): string {
  const trimmed = message.trim();
  const match = /^@([^\s]+)\s+/u.exec(trimmed);
  if (!match) {
    return fallbackAgentId;
  }
  const mention = match[1]?.trim();
  if (!mention) {
    return fallbackAgentId;
  }
  const normalizedMention = normalizeMention(mention);
  const exact = agents.find(
    (agent) =>
      normalizeMention(agent.agentId) === normalizedMention ||
      normalizeMention(agent.name ?? '') === normalizedMention ||
      (agent.mentionAliases ?? []).some((alias) => normalizeMention(alias) === normalizedMention),
  );
  return exact?.agentId ?? fallbackAgentId;
}

function AgentPanel({ agent, agents, initialThreadKey, recoveryContext, hubFocusTarget }: AgentPanelProps) {
  const { t } = useLocale();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmRecoverySend, setConfirmRecoverySend] = useState(false);
  const [currentThread, setCurrentThread] = useState(`console:${agent.agentId}`);
  const [visibleRecoveryContext, setVisibleRecoveryContext] = useState<ChatRecoveryContext | null>(null);
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null);
  const [expandedContextPanel, setExpandedContextPanel] = useState<'recovery' | 'hub' | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const focusedRecoveryEventIdRef = useRef<number | null>(null);
  const messageRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    if (initialThreadKey) {
      setCurrentThread(initialThreadKey);
    }
  }, [initialThreadKey]);

  useEffect(() => {
    if (recoveryContext?.eventId) {
      setVisibleRecoveryContext(recoveryContext);
      setExpandedContextPanel('recovery');
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
          res.messages.map((m, index) => ({
            id: `${sessionKey}:${m.timestamp}:${index}`,
            role: m.isToolResult ? 'assistant' : m.role,
            content: m.text,
            timestamp: m.timestamp,
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

  useEffect(() => {
    if (!hubFocusTarget?.eventId) {
      setFocusedMessageId(null);
      return;
    }
    if (hubFocusTarget.threadKey && hubFocusTarget.threadKey !== currentThread) {
      setFocusedMessageId(null);
      return;
    }
    const matchedId = findHubMessageMatch(messages, hubFocusTarget);
    setFocusedMessageId(matchedId);
    if (matchedId) {
      const element = messageRefs.current.get(matchedId);
      if (element) {
        window.requestAnimationFrame(() => {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      }
    }
  }, [messages, currentThread, hubFocusTarget]);

  const applyHubContextToInput = (startNew = false) => {
    if (!hubFocusTarget) {
      return;
    }
    const nextValue = buildHubContextPrompt(hubFocusTarget, t);
    if (startNew) {
      const newThread = createConsoleThreadKey(agent.agentId);
      setCurrentThread(newThread);
      setMessages([]);
      setFocusedMessageId(null);
      setInput(nextValue);
    } else {
      setInput((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n${nextValue}` : nextValue));
    }
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      const caret = inputRef.current?.value.length ?? 0;
      inputRef.current?.setSelectionRange(caret, caret);
    });
  };

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
  const participantAliases = agent.mentionAliases?.slice(0, 3) ?? [];
  const showRecoveryPanel = Boolean(visibleRecoveryContext);
  const showHubContextPanel = Boolean(hubFocusTarget);

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
      const targetAgentId = resolveMentionTarget(text, agents, agent.agentId);
      const res = await fetch(`http://127.0.0.1:${PORT}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({ agentId: targetAgentId, message: text, thread: currentThread }),
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
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 rounded-[1.4rem] border border-white/8 bg-[linear-gradient(135deg,rgba(56,189,248,0.08),rgba(15,23,42,0.92)_45%,rgba(30,41,59,0.78))] px-4 py-4 shadow-[0_18px_60px_rgba(8,47,73,0.18)]">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-slate-100">{agent.name ?? agent.agentId}</span>
              <Badge variant="blue">{t('chat.title')}</Badge>
              {participantAliases.map((alias) => (
                <span
                  key={`${agent.agentId}:${alias}`}
                  className="rounded-full bg-white/6 px-2 py-0.5 text-[10px] text-cyan-200/80"
                >
                  @{alias}
                </span>
              ))}
            </div>
            <div className="mt-2 text-[11px] uppercase tracking-[0.18em] text-cyan-300/65">
              Active Thread
            </div>
            <div className="mt-1 font-mono text-[11px] text-slate-300 truncate max-w-[460px]" title={currentThread}>
              {currentThread}
            </div>
            <div className="mt-2 text-xs text-slate-400/80">
              {t('chat.inbox.hint')}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
            <Button size="sm" variant="default" onClick={startNewThread}>
              {t('chat.newThread')}
            </Button>
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
                <div className="absolute right-0 top-full mt-2 w-80 bg-slate-900 ring-1 ring-slate-700 rounded-xl shadow-2xl z-50 overflow-hidden">
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
                          <span className="text-xs font-mono text-slate-300 truncate">{s.threadKey}</span>
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
        {(showRecoveryPanel || showHubContextPanel) && (
          <div className="mt-4 grid gap-3 xl:grid-cols-2">
            {showRecoveryPanel ? (
              <div className="rounded-2xl border border-amber-400/18 bg-amber-950/12 px-4 py-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="red">{formatErrorCode(visibleRecoveryContext?.errorCode)}</Badge>
                      <span className="text-sm font-medium text-amber-100">
                        {visibleRecoveryContext?.mode === 'new_thread'
                          ? t('chat.recovery.newThreadTitle')
                          : t('chat.recovery.continueTitle')}
                      </span>
                    </div>
                    <div className="mt-1 text-xs leading-5 text-amber-100/75">
                      {visibleRecoveryContext?.mode === 'new_thread'
                        ? t('chat.recovery.newThreadDesc')
                        : t('chat.recovery.continueDesc')}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button size="sm" variant="ghost" onClick={() => setExpandedContextPanel((current) => (current === 'recovery' ? null : 'recovery'))}>
                      {expandedContextPanel === 'recovery' ? t('common.showLess') : t('common.showMore')}
                    </Button>
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
                <div className="mt-3 rounded-xl border border-white/6 bg-slate-950/30 px-3 py-2.5 text-xs leading-5 text-slate-200/85 whitespace-pre-wrap">
                  {suggestedRecoveryMessage}
                </div>
                {expandedContextPanel === 'recovery' ? (
                  <div className="mt-3 space-y-3">
                    <div className="rounded-xl bg-slate-950/25 ring-1 ring-white/5 px-3 py-2.5">
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
                        <div className="mt-3 flex flex-wrap gap-2">
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
                      ) : null}
                    </div>
                    {recoveryEvidenceEntries.length > 0 ? (
                      <div className="rounded-xl bg-slate-950/25 ring-1 ring-white/5 px-3 py-2.5">
                        <div className="flex items-center gap-2 flex-wrap text-[11px] font-medium uppercase tracking-[0.08em] text-slate-300/80">
                          <span>{t('chat.recovery.evidenceLabel')}</span>
                          {recoveryPatternMetas.map((meta) => (
                            <Badge key={`${meta.variant}-${meta.label}`} variant={meta.variant}>
                              {t('chat.recovery.patternDetected')}: {meta.label}
                            </Badge>
                          ))}
                        </div>
                        <div className="mt-2 flex flex-col gap-2">
                          {recoveryEvidenceEntries.map((entry) => (
                            <RecoveryEvidenceCard key={entry.key} entry={entry} />
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            {showHubContextPanel ? (
              <div className="rounded-2xl border border-cyan-400/14 bg-cyan-950/8 px-4 py-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={hubFocusTarget?.kind === 'deliverable' ? 'purple' : 'blue'}>
                        {hubFocusTarget?.kind === 'deliverable'
                          ? t('chat.inbox.kind.deliverable')
                          : t('chat.inbox.kind.reply')}
                      </Badge>
                      <span className="text-sm font-medium text-cyan-100">{t('chat.hub.linkedTitle')}</span>
                      {hubFocusTarget?.channelId ? (
                        <span className="text-[11px] text-cyan-300/70">{hubFocusTarget.channelId}</span>
                      ) : null}
                    </div>
                    <div className="mt-1 text-xs text-cyan-100/80 leading-5">
                      {hubFocusTarget?.title || t('chat.inbox.threadFallback')}
                    </div>
                    <div className="mt-1 text-[11px] text-slate-400">
                      {focusedMessageId ? t('chat.hub.matchFound') : t('chat.hub.matchPending')}
                    </div>
                    <div className="mt-2 text-xs text-slate-300/75 line-clamp-2">
                      {truncateText(hubFocusTarget?.text || t('chat.hub.contextEmpty'), 110)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button size="sm" variant="ghost" onClick={() => setExpandedContextPanel((current) => (current === 'hub' ? null : 'hub'))}>
                      {expandedContextPanel === 'hub' ? t('common.showLess') : t('common.showMore')}
                    </Button>
                    <Button size="sm" variant="default" onClick={() => applyHubContextToInput(false)}>
                      {t('chat.hub.quoteIntoInput')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => applyHubContextToInput(true)}>
                      {t('chat.hub.newThreadFromEvent')}
                    </Button>
                  </div>
                </div>
                {expandedContextPanel === 'hub' ? (
                  <div className="mt-3 rounded-xl border border-white/6 bg-slate-950/30 px-3 py-2.5 text-xs leading-5 text-slate-200/85 whitespace-pre-wrap">
                    {hubFocusTarget?.text || t('chat.hub.contextEmpty')}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col gap-4 pr-1 min-h-0 pt-4">
        {messages.length === 0 && (
          <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/25 px-5 py-8 text-center text-slate-500 text-sm mt-2">
            {t('chat.startConversation', { name: agent.name ?? agent.agentId })}
          </div>
        )}
        {messages.map((msg, i) => (
          <ChatBubble
            key={msg.id ?? i}
            msg={msg}
            highlighted={msg.id === focusedMessageId}
            onMount={(element) => {
              if (!msg.id) {
                return;
              }
              if (element) {
                messageRefs.current.set(msg.id, element);
                return;
              }
              messageRefs.current.delete(msg.id);
            }}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="pt-3 shrink-0 border-t border-white/6 mt-3">
        <div className="relative flex items-end gap-2 bg-slate-800/60 ring-1 ring-slate-700/50 rounded-[1.25rem] p-3 shadow-[0_12px_30px_rgba(15,23,42,0.25)]">
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
  mode = 'chat',
  onOpenInbox,
  onOpenChatFromInbox,
}: {
  initialAgentId?: string;
  initialThreadKey?: string;
  initialRecoveryContext?: ChatRecoveryContext | null;
  mode?: 'chat' | 'inbox';
  onOpenInbox?: () => void;
  onOpenChatFromInbox?: (options: { agentId?: string; threadKey?: string }) => void;
}) {
  const { t } = useLocale();
  const [activeAgentId, setActiveAgentId] = useState<string>('');
  const [selectedThreadKey, setSelectedThreadKey] = useState<string>('');
  const [inboxEvents, setInboxEvents] = useState<InboxEvent[]>([]);
  const [selectedHubKey, setSelectedHubKey] = useState<string>('');
  const [hubFocusTarget, setHubFocusTarget] = useState<HubFocusTarget | null>(null);
  const [hubQuery, setHubQuery] = useState('');
  const [hubKindFilter, setHubKindFilter] = useState<'all' | 'reply' | 'deliverable'>('all');
  const [hubAgentFilter, setHubAgentFilter] = useState<string>('all');
  const [hubWindowFilter, setHubWindowFilter] = useState<'all' | '1h' | '24h' | '7d'>('all');
  const [hubChannelFilter, setHubChannelFilter] = useState<string>('all');
  const [deliverableId, setDeliverableId] = useState<string | null>(null);
  const [seenInboxEventIds, setSeenInboxEventIds] = useState<number[]>(() => readStoredNumberArray(HUB_SEEN_EVENT_IDS_STORAGE_KEY));
  const [processedHubThreadKeys, setProcessedHubThreadKeys] = useState<string[]>(() => readStoredStringArray(HUB_PROCESSED_THREAD_KEYS_STORAGE_KEY));
  const [showProcessedThreads, setShowProcessedThreads] = useState(false);

  const { data: agentsResult, refetch } = useQuery<AgentListResult>(
    () => rpc<AgentListResult>('agent.list'),
    [],
  );
  const agents: AgentInfo[] = Array.isArray(agentsResult?.agents) ? agentsResult.agents : [];
  const seenInboxEventIdSet = new Set(seenInboxEventIds);
  const processedHubThreadKeySet = new Set(processedHubThreadKeys);
  const hubThreads: HubThreadView[] = buildHubThreads(inboxEvents).map((thread) => ({
    ...thread,
    unreadCount: thread.events.reduce((count, event) => count + (seenInboxEventIdSet.has(event.id) ? 0 : 1), 0),
    isProcessed: processedHubThreadKeySet.has(thread.key),
  }));
  const hubChannels = Array.from(
    new Set(inboxEvents.map((event) => event.channelId).filter((value): value is string => Boolean(value))),
  ).sort();
  const normalizedHubQuery = hubQuery.trim().toLocaleLowerCase();
  const filteredHubThreads = hubThreads.filter((thread) => {
    if (!showProcessedThreads && thread.isProcessed) {
      return false;
    }
    if (hubKindFilter === 'reply' && thread.replyCount === 0) {
      return false;
    }
    if (hubKindFilter === 'deliverable' && thread.deliverableCount === 0) {
      return false;
    }
    if (
      hubAgentFilter !== 'all' &&
      !thread.agentIds.includes(hubAgentFilter) &&
      thread.latestEvent.agentId !== hubAgentFilter
    ) {
      return false;
    }
    if (hubChannelFilter !== 'all' && !thread.events.some((event) => event.channelId === hubChannelFilter)) {
      return false;
    }
    if (hubWindowFilter !== 'all') {
      const maxAgeMs =
        hubWindowFilter === '1h'
          ? 3_600_000
          : hubWindowFilter === '24h'
          ? 86_400_000
          : 604_800_000;
      if (Date.now() - thread.latestTs > maxAgeMs) {
        return false;
      }
    }
    if (!normalizedHubQuery) {
      return true;
    }
    const haystacks = [
      thread.title,
      thread.preview,
      thread.threadKey ?? '',
      ...thread.agentIds,
      ...thread.events.flatMap((event) => [event.title, event.text, event.channelId ?? '']),
    ];
    return haystacks.some((value) => value.toLocaleLowerCase().includes(normalizedHubQuery));
  });
  const selectedHubThread =
    filteredHubThreads.find((thread) => thread.key === selectedHubKey) ?? filteredHubThreads[0] ?? null;
  const unreadHubThreadCount = hubThreads.filter((thread) => thread.unreadCount > 0 && !thread.isProcessed).length;
  const processedHubThreadCount = hubThreads.filter((thread) => thread.isProcessed).length;

  const markThreadSeen = (thread: HubThreadView | null) => {
    if (!thread || thread.events.length === 0) {
      return;
    }
    setSeenInboxEventIds((current) => {
      const merged = Array.from(new Set([...current, ...thread.events.map((event) => event.id)]));
      return merged.slice(-200);
    });
  };

  const toggleThreadProcessed = (threadKey: string) => {
    setProcessedHubThreadKeys((current) =>
      current.includes(threadKey) ? current.filter((key) => key !== threadKey) : [...current, threadKey],
    );
  };

  // Derive effective selected agent: fall back to first in list while state hasn't synced yet.
  // This prevents the brief flash where agents are loaded but none appears selected.
  const effectiveActiveId = activeAgentId || agents[0]?.agentId || '';

  useEffect(() => {
    if (initialAgentId) {
      setActiveAgentId(initialAgentId);
    }
  }, [initialAgentId]);

  useEffect(() => {
    if (initialThreadKey) {
      setSelectedThreadKey(initialThreadKey);
    }
  }, [initialThreadKey]);

  // Persist the selection so explicit clicks are remembered after refetch
  useEffect(() => {
    if (!activeAgentId && agents.length > 0) {
      setActiveAgentId(agents[0]?.agentId);
    }
  }, [agents, activeAgentId]);

  useEffect(() => {
    const token = window.__AF_TOKEN__;
    const port = window.__AF_PORT__;
    const es = new EventSource(`http://127.0.0.1:${port}/api/inbox?token=${token}`);
    es.onmessage = (event: MessageEvent<string>) => {
      try {
        const data = JSON.parse(event.data) as InboxEvent;
        setInboxEvents((current) => {
          const next = [data, ...current.filter((item) => item.id !== data.id)];
          return next.slice(0, 18);
        });
      } catch {
        // ignore malformed inbox events
      }
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    window.localStorage.setItem(HUB_SEEN_EVENT_IDS_STORAGE_KEY, JSON.stringify(seenInboxEventIds));
  }, [seenInboxEventIds]);

  useEffect(() => {
    window.localStorage.setItem(HUB_PROCESSED_THREAD_KEYS_STORAGE_KEY, JSON.stringify(processedHubThreadKeys));
  }, [processedHubThreadKeys]);

  useEffect(() => {
    if (filteredHubThreads.length === 0) {
      if (selectedHubKey) {
        setSelectedHubKey('');
      }
      return;
    }
    const matchingThread = selectedThreadKey
      ? filteredHubThreads.find((thread) => thread.threadKey === selectedThreadKey)
      : null;
    if (matchingThread && matchingThread.key !== selectedHubKey) {
      setSelectedHubKey(matchingThread.key);
      return;
    }
    if (!selectedHubKey || !filteredHubThreads.some((thread) => thread.key === selectedHubKey)) {
      setSelectedHubKey(matchingThread?.key ?? filteredHubThreads[0]?.key ?? '');
    }
  }, [filteredHubThreads, selectedHubKey, selectedThreadKey]);

  useEffect(() => {
    markThreadSeen(selectedHubThread);
  }, [selectedHubThread?.key]);

  const openThreadFromHubEvent = (event: InboxEvent, selectedThreadHubKey: string) => {
    if (mode === 'inbox' && onOpenChatFromInbox) {
      onOpenChatFromInbox({
        agentId: event.agentId,
        threadKey: event.threadKey,
      });
      return;
    }
    setSeenInboxEventIds((current) => (current.includes(event.id) ? current : [...current, event.id]));
    setHubFocusTarget({
      eventId: event.id,
      agentId: event.agentId,
      threadKey: event.threadKey,
      title: event.title,
      text: event.text,
      kind: event.kind,
      channelId: event.channelId,
      deliverableId: event.deliverableId,
    });
    if (event.agentId) {
      setActiveAgentId(event.agentId);
    }
    setSelectedThreadKey(event.threadKey ?? '');
    setSelectedHubKey(selectedThreadHubKey);
  };

  if (mode === 'inbox') {
    return (
      <div className="flex h-[calc(100vh-4rem)] min-h-0 flex-col rounded-[1.75rem] border border-cyan-400/12 bg-[linear-gradient(180deg,rgba(8,47,73,0.32),rgba(2,6,23,0.92))] shadow-[0_24px_80px_rgba(8,47,73,0.22)]">
        <HubWorkspaceContent
          agents={agents}
          hubThreads={hubThreads}
          filteredHubThreads={filteredHubThreads}
          selectedHubThread={selectedHubThread}
          hubChannels={hubChannels}
          hubQuery={hubQuery}
          setHubQuery={setHubQuery}
          hubKindFilter={hubKindFilter}
          setHubKindFilter={setHubKindFilter}
          hubAgentFilter={hubAgentFilter}
          setHubAgentFilter={setHubAgentFilter}
          hubWindowFilter={hubWindowFilter}
          setHubWindowFilter={setHubWindowFilter}
          hubChannelFilter={hubChannelFilter}
          setHubChannelFilter={setHubChannelFilter}
          unreadHubThreadCount={unreadHubThreadCount}
          processedHubThreadCount={processedHubThreadCount}
          showProcessedThreads={showProcessedThreads}
          setShowProcessedThreads={setShowProcessedThreads}
          markThreadSeen={markThreadSeen}
          toggleThreadProcessed={toggleThreadProcessed}
          setSelectedHubKey={setSelectedHubKey}
          setHubFocusTarget={setHubFocusTarget}
          setActiveAgentId={setActiveAgentId}
          setSelectedThreadKey={setSelectedThreadKey}
          onOpenThreadFromEvent={openThreadFromHubEvent}
          seenInboxEventIdSet={seenInboxEventIdSet}
          setSeenInboxEventIds={setSeenInboxEventIds}
          setDeliverableId={setDeliverableId}
        />
        {deliverableId ? <DeliverableModal deliverableId={deliverableId} onClose={() => setDeliverableId(null)} /> : null}
      </div>
    );
  }

  return (
    <div className="grid h-[calc(100vh-4rem)] gap-4 xl:grid-cols-[200px_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col rounded-[1.75rem] border border-white/8 bg-slate-950/55 p-3 shadow-[0_24px_80px_rgba(2,6,23,0.35)]">
        <div className="flex items-center justify-between border-b border-white/8 pb-3 shrink-0">
          <div>
            <h1 className="text-sm font-semibold text-slate-100">{t('chat.title')}</h1>
            <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-slate-500">
              Agent Deck
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={refetch}>
            ↺
          </Button>
        </div>
        <div className="mt-3 flex flex-col gap-1 overflow-y-auto pr-1 min-h-0">
          {agents.length === 0 ? <p className="text-xs text-slate-500 pt-2">{t('chat.noAgents')}</p> : null}
          {agents.map((a) => {
            const active = a.agentId === effectiveActiveId;
            return (
              <button
                key={a.agentId}
                onClick={() => setActiveAgentId(a.agentId)}
                className={`group rounded-2xl border px-3 py-3 text-left transition-all ${
                  active
                    ? 'border-indigo-400/35 bg-indigo-500/12 text-indigo-100 shadow-[0_8px_30px_rgba(99,102,241,0.18)]'
                    : 'border-white/6 bg-slate-900/65 text-slate-400 hover:border-white/12 hover:bg-slate-900/90 hover:text-slate-200'
                }`}
              >
                <div className="text-xs font-semibold truncate">{a.name ?? a.agentId}</div>
                <div className="mt-1 text-[10px] font-mono text-slate-500 truncate group-hover:text-slate-400">
                  {a.agentId}
                </div>
                {a.mentionAliases?.length ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {a.mentionAliases.slice(0, 2).map((alias) => (
                      <span
                        key={`${a.agentId}:${alias}`}
                        className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-slate-400"
                      >
                        @{alias}
                      </span>
                    ))}
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[1.75rem] border border-white/8 bg-slate-950/45 p-3 shadow-[0_24px_80px_rgba(2,6,23,0.3)]">
        <div className="mb-3 flex items-center justify-between gap-3 rounded-2xl border border-white/8 bg-[linear-gradient(135deg,rgba(14,165,233,0.12),rgba(99,102,241,0.08)_45%,rgba(15,23,42,0.65))] px-4 py-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-cyan-300/70">
              {t('chat.inbox.title')}
            </div>
            <div className="mt-1 text-xs text-slate-300/80">{t('chat.hub.mobileHint')}</div>
          </div>
          <Button size="sm" variant="default" onClick={() => onOpenInbox?.()}>
            {t('chat.hub.openWorkspace')}
          </Button>
        </div>
        {agents.length === 0 ? (
          <div className="flex h-full items-center justify-center text-slate-500 text-sm">
            {t('chat.noAgentsAvailable')}
          </div>
        ) : (
          (() => {
            const activeAgent = agents.find((a) => a.agentId === effectiveActiveId) ?? agents[0];
            return activeAgent ? (
              <AgentPanel
                key={`${activeAgent.agentId}:${selectedThreadKey}`}
                agent={activeAgent}
                agents={agents}
                initialThreadKey={
                  selectedThreadKey ||
                  (activeAgent.agentId === effectiveActiveId ? initialThreadKey : '')
                }
                hubFocusTarget={
                  hubFocusTarget?.agentId === activeAgent.agentId ||
                  (hubFocusTarget?.threadKey && hubFocusTarget.threadKey === selectedThreadKey)
                    ? hubFocusTarget
                    : null
                }
                recoveryContext={
                  initialRecoveryContext?.agentId === activeAgent.agentId ? initialRecoveryContext : null
                }
              />
            ) : null;
          })()
        )}
      </div>

      {deliverableId ? <DeliverableModal deliverableId={deliverableId} onClose={() => setDeliverableId(null)} /> : null}
    </div>
  );
}

export function InboxTab({ onOpenChat }: { onOpenChat?: (options: { agentId?: string; threadKey?: string }) => void }) {
  return <ChatTab mode="inbox" onOpenChatFromInbox={onOpenChat} />;
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

function HubConversationBubble({
  event,
  seen,
  agentLabel,
  onOpenThread,
  onOpenDeliverable,
}: {
  event: InboxEvent;
  seen: boolean;
  agentLabel: string;
  onOpenThread: () => void;
  onOpenDeliverable?: () => void;
}) {
  const { t } = useLocale();
  const isDeliverable = event.kind === 'deliverable';

  return (
    <div className={`flex ${isDeliverable ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[92%] rounded-[1.4rem] border px-3 py-3 shadow-[0_14px_30px_rgba(2,6,23,0.18)] ${
          isDeliverable
            ? 'border-fuchsia-300/18 bg-[linear-gradient(135deg,rgba(168,85,247,0.2),rgba(91,33,182,0.16)_52%,rgba(15,23,42,0.82))] text-slate-100 rounded-br-md'
            : 'border-cyan-300/14 bg-[linear-gradient(135deg,rgba(34,211,238,0.16),rgba(15,23,42,0.88)_52%,rgba(30,41,59,0.82))] text-slate-100 rounded-bl-md'
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold uppercase ${
                isDeliverable ? 'bg-fuchsia-200/15 text-fuchsia-100' : 'bg-cyan-200/15 text-cyan-100'
              }`}
            >
              {(agentLabel || t('chat.inbox.system')).slice(0, 1)}
            </span>
            <div className="flex flex-col">
              <span className="text-[11px] font-medium text-slate-100">{agentLabel}</span>
              <span className="text-[10px] text-slate-300/60">{new Date(event.ts).toLocaleTimeString()}</span>
            </div>
            <Badge variant={isDeliverable ? 'purple' : 'blue'}>
              {isDeliverable ? t('chat.inbox.kind.deliverable') : t('chat.inbox.kind.reply')}
            </Badge>
            {!seen ? <Badge variant="blue">{t('chat.hub.unreadShort', { count: 1 })}</Badge> : null}
          </div>
        </div>
        <div className="mt-3 text-sm font-medium text-slate-50">{event.title}</div>
        <div className="mt-2 whitespace-pre-wrap text-xs leading-6 text-slate-100/85">{event.text}</div>
        <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-300/60">
          {event.channelId ? <span>{event.channelId}</span> : null}
          {event.publicationSummary ? <span>{event.publicationSummary}</span> : null}
          {event.threadKey ? <span>{event.threadKey}</span> : null}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {event.threadKey ? (
            <Button size="sm" variant="ghost" className="!px-2 !py-1 text-[10px]" onClick={onOpenThread}>
              {t('chat.inbox.openThread')}
            </Button>
          ) : null}
          {onOpenDeliverable ? (
            <Button size="sm" variant="ghost" className="!px-2 !py-1 text-[10px]" onClick={onOpenDeliverable}>
              {t('deliverables.open')}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function HubWorkspaceContent({
  agents,
  hubThreads,
  filteredHubThreads,
  selectedHubThread,
  hubChannels,
  hubQuery,
  setHubQuery,
  hubKindFilter,
  setHubKindFilter,
  hubAgentFilter,
  setHubAgentFilter,
  hubWindowFilter,
  setHubWindowFilter,
  hubChannelFilter,
  setHubChannelFilter,
  unreadHubThreadCount,
  processedHubThreadCount,
  showProcessedThreads,
  setShowProcessedThreads,
  markThreadSeen,
  toggleThreadProcessed,
  setSelectedHubKey,
  setHubFocusTarget,
  setActiveAgentId,
  setSelectedThreadKey,
  onOpenThreadFromEvent,
  seenInboxEventIdSet,
  setSeenInboxEventIds,
  setDeliverableId,
}: {
  agents: AgentInfo[];
  hubThreads: HubThreadView[];
  filteredHubThreads: HubThreadView[];
  selectedHubThread: HubThreadView | null;
  hubChannels: string[];
  hubQuery: string;
  setHubQuery: (value: string) => void;
  hubKindFilter: 'all' | 'reply' | 'deliverable';
  setHubKindFilter: (value: 'all' | 'reply' | 'deliverable') => void;
  hubAgentFilter: string;
  setHubAgentFilter: (value: string) => void;
  hubWindowFilter: 'all' | '1h' | '24h' | '7d';
  setHubWindowFilter: (value: 'all' | '1h' | '24h' | '7d') => void;
  hubChannelFilter: string;
  setHubChannelFilter: (value: string) => void;
  unreadHubThreadCount: number;
  processedHubThreadCount: number;
  showProcessedThreads: boolean;
  setShowProcessedThreads: (value: boolean) => void;
  markThreadSeen: (thread: HubThreadView | null) => void;
  toggleThreadProcessed: (threadKey: string) => void;
  setSelectedHubKey: (key: string) => void;
  setHubFocusTarget: (target: HubFocusTarget | null) => void;
  setActiveAgentId: (value: string) => void;
  setSelectedThreadKey: (value: string) => void;
  onOpenThreadFromEvent?: (event: InboxEvent, selectedHubThreadKey: string) => void;
  seenInboxEventIdSet: Set<number>;
  setSeenInboxEventIds: (updater: (current: number[]) => number[]) => void;
  setDeliverableId: (value: string | null) => void;
}) {
  const { t } = useLocale();

  return (
    <>
      <div className="relative border-b border-white/8 px-4 py-4 shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.22em] text-cyan-300/70">
              {t('chat.inbox.title')}
            </div>
            <div className="mt-1 text-sm font-semibold text-slate-100">{t('chat.hub.sidebarTitle')}</div>
            <div className="mt-1 text-xs leading-5 text-slate-300/80">{t('chat.hub.sidebarSubtitle')}</div>
          </div>
          <div className="flex items-center gap-2">
            {unreadHubThreadCount > 0 ? <Badge variant="blue">{t('chat.hub.unread', { count: unreadHubThreadCount })}</Badge> : null}
            {processedHubThreadCount > 0 ? <Badge variant="gray">{t('chat.hub.processed', { count: processedHubThreadCount })}</Badge> : null}
          </div>
        </div>
        <div className="mt-4 grid gap-2">
          <input
            value={hubQuery}
            onChange={(event) => setHubQuery(event.target.value)}
            placeholder={t('chat.inbox.searchPlaceholder')}
            className="rounded-xl bg-slate-950/55 ring-1 ring-white/8 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-cyan-400/40"
          />
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            <select
              value={hubKindFilter}
              onChange={(event) => setHubKindFilter(event.target.value as 'all' | 'reply' | 'deliverable')}
              className="rounded-xl bg-slate-950/55 ring-1 ring-white/8 px-3 py-2.5 text-sm text-slate-100 focus:outline-none focus:ring-cyan-400/40"
            >
              <option value="all">{t('chat.inbox.filter.all')}</option>
              <option value="reply">{t('chat.inbox.filter.reply')}</option>
              <option value="deliverable">{t('chat.inbox.filter.deliverable')}</option>
            </select>
            <select
              value={hubAgentFilter}
              onChange={(event) => setHubAgentFilter(event.target.value)}
              className="rounded-xl bg-slate-950/55 ring-1 ring-white/8 px-3 py-2.5 text-sm text-slate-100 focus:outline-none focus:ring-cyan-400/40"
            >
              <option value="all">{t('chat.inbox.filter.allAgents')}</option>
              {agents.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.name ?? agent.agentId}
                </option>
              ))}
            </select>
            <select
              value={hubWindowFilter}
              onChange={(event) => setHubWindowFilter(event.target.value as 'all' | '1h' | '24h' | '7d')}
              className="rounded-xl bg-slate-950/55 ring-1 ring-white/8 px-3 py-2.5 text-sm text-slate-100 focus:outline-none focus:ring-cyan-400/40"
            >
              <option value="all">{t('chat.inbox.window.all')}</option>
              <option value="1h">{t('chat.inbox.window.1h')}</option>
              <option value="24h">{t('chat.inbox.window.24h')}</option>
              <option value="7d">{t('chat.inbox.window.7d')}</option>
            </select>
            <select
              value={hubChannelFilter}
              onChange={(event) => setHubChannelFilter(event.target.value)}
              className="rounded-xl bg-slate-950/55 ring-1 ring-white/8 px-3 py-2.5 text-sm text-slate-100 focus:outline-none focus:ring-cyan-400/40"
            >
              <option value="all">{t('chat.inbox.filter.allChannels')}</option>
              {hubChannels.map((channelId) => (
                <option key={channelId} value={channelId}>
                  {channelId}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-between gap-2 rounded-xl border border-white/8 bg-slate-950/30 px-3 py-2 text-xs text-slate-300">
            <span>{t('chat.hub.threadListTitle')}</span>
            <Button size="sm" variant="ghost" onClick={() => setShowProcessedThreads(!showProcessedThreads)}>
              {showProcessedThreads ? t('chat.hub.hideProcessed') : t('chat.hub.showProcessed')}
            </Button>
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-3 px-3 py-3 xl:grid-cols-[minmax(220px,0.88fr)_minmax(0,1.12fr)]">
        <div className="min-h-0 overflow-hidden rounded-2xl border border-white/8 bg-slate-950/35">
          <div className="flex items-center justify-between border-b border-white/8 px-3 py-2 text-[11px] uppercase tracking-[0.18em] text-slate-500">
            <span>{t('chat.hub.threadListTitle')}</span>
            <span>{filteredHubThreads.length}</span>
          </div>
          <div className="space-y-1 overflow-y-auto px-2 py-2 h-full">
            {filteredHubThreads.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 bg-slate-950/30 px-3 py-4 text-xs text-slate-400">
                {hubThreads.length === 0 ? t('chat.inbox.empty') : t('chat.inbox.emptyFiltered')}
              </div>
            ) : (
              filteredHubThreads.map((thread) => {
                const isActive = thread.key === selectedHubThread?.key;
                const participantSummary =
                  thread.agentIds.length > 0
                    ? thread.agentIds.map((agentId) => getAgentLabel(agentId, agents)).join(' · ')
                    : t('chat.inbox.system');
                return (
                  <button
                    key={thread.key}
                    onClick={() => {
                      markThreadSeen(thread);
                      setSelectedHubKey(thread.key);
                      setHubFocusTarget({
                        eventId: thread.latestEvent.id,
                        agentId: thread.latestEvent.agentId,
                        threadKey: thread.latestEvent.threadKey,
                        title: thread.latestEvent.title,
                        text: thread.latestEvent.text,
                        kind: thread.latestEvent.kind,
                        channelId: thread.latestEvent.channelId,
                        deliverableId: thread.latestEvent.deliverableId,
                      });
                      if (thread.latestEvent.agentId) {
                        setActiveAgentId(thread.latestEvent.agentId);
                      }
                      if (thread.threadKey) {
                        setSelectedThreadKey(thread.threadKey);
                      }
                    }}
                    className={`w-full rounded-[1.35rem] border px-3 py-3 text-left transition-all ${
                      isActive
                        ? 'border-cyan-300/35 bg-cyan-400/10 shadow-[0_12px_30px_rgba(34,211,238,0.08)]'
                        : thread.isProcessed
                        ? 'border-white/8 bg-slate-950/20 text-slate-400 hover:border-white/14 hover:bg-slate-900/55'
                        : 'border-white/8 bg-slate-950/35 hover:border-white/14 hover:bg-slate-900/80'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${isActive ? 'bg-cyan-300/18 text-cyan-100' : 'bg-white/6 text-slate-200'}`}>
                        {participantSummary.slice(0, 1)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <div className={`truncate text-sm font-medium ${thread.isProcessed ? 'text-slate-400' : 'text-slate-100'}`}>
                            {thread.title || t('chat.inbox.threadFallback')}
                          </div>
                          <span className="shrink-0 text-[10px] text-slate-500">{timeAgo(thread.latestTs)}</span>
                        </div>
                        <div className={`mt-1 line-clamp-2 text-xs leading-5 ${thread.isProcessed ? 'text-slate-500' : 'text-slate-300'}`}>
                          {thread.preview}
                        </div>
                        <div className="mt-2 flex items-center gap-2 flex-wrap text-[10px] text-slate-500">
                          <span className="truncate max-w-[150px]">{participantSummary}</span>
                          {thread.unreadCount > 0 ? (
                            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-cyan-400/20 px-1.5 text-[10px] text-cyan-100">
                              {thread.unreadCount}
                            </span>
                          ) : null}
                          {thread.isProcessed ? <Badge variant="gray">{t('chat.hub.processedShort')}</Badge> : null}
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 pl-[3.25rem] text-[10px] text-slate-500">
                      <Badge variant={thread.deliverableCount > 0 ? 'purple' : 'green'}>
                        {thread.deliverableCount > 0 && thread.replyCount > 0
                          ? `${thread.replyCount}+${thread.deliverableCount}`
                          : thread.deliverableCount > 0
                          ? t('chat.inbox.kind.deliverable')
                          : t('chat.inbox.kind.reply')}
                      </Badge>
                      <span>{t('chat.inbox.events', { count: thread.events.length })}</span>
                      {thread.threadKey ? <span>{thread.threadKey}</span> : null}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-white/8 bg-slate-950/35">
          {selectedHubThread ? (
            <>
              <div className="shrink-0 border-b border-white/8 bg-[linear-gradient(135deg,rgba(34,211,238,0.12),rgba(15,23,42,0.92)_58%,rgba(30,41,59,0.82))] px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">
                      {t('chat.inbox.activityTitle')}
                    </div>
                    <div className="mt-1 truncate text-sm font-semibold text-slate-100">
                      {selectedHubThread.title || t('chat.inbox.threadFallback')}
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs text-slate-400">
                      {selectedHubThread.agentIds.length > 0
                        ? selectedHubThread.agentIds.map((agentId) => getAgentLabel(agentId, agents)).join(' · ')
                        : t('chat.inbox.system')}
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Badge variant="green">{t('chat.inbox.replyCount', { count: selectedHubThread.replyCount })}</Badge>
                    <Badge variant="purple">{t('chat.inbox.deliverableCount', { count: selectedHubThread.deliverableCount })}</Badge>
                    {selectedHubThread.unreadCount > 0 ? (
                      <Badge variant="blue">{t('chat.hub.unreadShort', { count: selectedHubThread.unreadCount })}</Badge>
                    ) : null}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={selectedHubThread.isProcessed ? 'default' : 'ghost'}
                    onClick={() => toggleThreadProcessed(selectedHubThread.key)}
                  >
                    {selectedHubThread.isProcessed ? t('chat.hub.reopenThread') : t('chat.hub.markProcessed')}
                  </Button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.06),transparent_42%),linear-gradient(180deg,rgba(2,6,23,0.2),rgba(2,6,23,0.55))] px-3 py-3">
                <div className="flex min-h-full flex-col justify-end gap-3">
                  {selectedHubThread.events.map((event) => {
                    const eventSeen = seenInboxEventIdSet.has(event.id);
                    return (
                      <HubConversationBubble
                        key={event.id}
                        event={event}
                        seen={eventSeen}
                        agentLabel={getAgentLabel(event.agentId, agents)}
                        onOpenThread={() => {
                          if (onOpenThreadFromEvent) {
                            onOpenThreadFromEvent(event, selectedHubThread.key);
                            return;
                          }
                          setSeenInboxEventIds((current) => (current.includes(event.id) ? current : [...current, event.id]));
                          setHubFocusTarget({
                            eventId: event.id,
                            agentId: event.agentId,
                            threadKey: event.threadKey,
                            title: event.title,
                            text: event.text,
                            kind: event.kind,
                            channelId: event.channelId,
                            deliverableId: event.deliverableId,
                          });
                          if (event.agentId) {
                            setActiveAgentId(event.agentId);
                          }
                          setSelectedThreadKey(event.threadKey ?? '');
                          setSelectedHubKey(selectedHubThread.key);
                        }}
                        onOpenDeliverable={
                          event.deliverableId ? () => setDeliverableId(event.deliverableId ?? null) : undefined
                        }
                      />
                    );
                  })}
                </div>
              </div>
            </>
          ) : (
            <div className="m-3 rounded-xl border border-dashed border-white/10 bg-slate-950/30 px-3 py-4 text-xs text-slate-400">
              {hubThreads.length === 0 ? t('chat.inbox.empty') : t('chat.inbox.emptyFiltered')}
            </div>
          )}
        </div>
      </div>
    </>
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

function ChatBubble({
  msg,
  highlighted = false,
  onMount,
}: {
  msg: Message;
  highlighted?: boolean;
  onMount?: (element: HTMLDivElement | null) => void;
}) {
  if (msg.role === 'thinking') {
    return <ThinkingBubble msg={msg} />;
  }

  const isUser = msg.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`} ref={onMount}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 transition-all ${
          highlighted ? 'ring-2 ring-cyan-400/60 shadow-lg shadow-cyan-500/10' : ''
        } ${
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
