import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../components/Button.js';
import { useLocale } from '../context/i18n.js';
import { rpc, useQuery } from '../hooks/useRpc.js';
import { getMcpDiagnosticHint } from '../mcp-diagnostic-hints.js';
import {
  collectMcpErrorCodes,
  collectMcpErrorPhases,
  matchMcpServerFilter,
  summarizeMcpStatus,
} from '../mcp-status-insights.js';
import { useToast } from '../hooks/useToast.js';
import type { SkillInfo, SkillListResult } from '../types.js';

type BindMode = 'loopback' | 'local' | 'tailscale';
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogFormat = 'json' | 'pretty';
type MeshRole = 'coordinator' | 'worker' | 'specialist' | 'observer';
type Visibility = 'public' | 'private';
type SearchProviderKind = 'tavily' | 'bing' | 'serpapi' | 'duckduckgo';
type ModelProviderKind = 'anthropic' | 'openai' | 'google' | 'ollama' | 'openai-compat';
type McpTransport = 'stdio' | 'sse';
type McpApprovalMode = 'inherit' | 'always' | 'never';

const PROVIDER_LABELS: Record<ModelProviderKind, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  ollama: 'Ollama',
  'openai-compat': 'OpenAI-Compat',
};

type ConfigSection =
  | 'gateway'
  | 'channels'
  | 'models'
  | 'agents'
  | 'defaults'
  | 'context'
  | 'skills'
  | 'search'
  | 'memory'
  | 'mcp'
  | 'federation'
  | 'log'
  | 'json';

// ─── SVG icon set ──────────────────────────────────────────────
const ConfigIco: Record<ConfigSection, ReactNode> = {
  gateway: (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
    </svg>
  ),
  channels: (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81a19.79 19.79 0 01-3.07-8.68 2 2 0 012-2.18h3a2 2 0 012 1.72 12.88 12.88 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 6a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.88 12.88 0 002.81.7 2 2 0 011.72 2z" />
    </svg>
  ),
  models: (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2a2 2 0 012 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 017 7h1a1 1 0 01.97 1.24L21.5 18H20a5 5 0 01-9.9 0H8a5 5 0 01-9.9 0H2a1 1 0 01-1-1V14A7 7 0 018 7h1V5.73a2 2 0 01-1-1.73 2 2 0 012-2z" />
      <circle cx="12" cy="14" r="1" fill="currentColor" />
      <circle cx="8" cy="14" r="1" fill="currentColor" />
      <circle cx="16" cy="14" r="1" fill="currentColor" />
    </svg>
  ),
  agents: (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87" />
      <path d="M16 3.13a4 4 0 010 7.75" />
    </svg>
  ),
  defaults: (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.07 4.93l-1.41 1.41M5.34 5.34L3.93 3.93M19.07 19.07l-1.41-1.41M5.34 18.66l-1.41 1.41M21 12h-2M5 12H3M12 21v-2M12 5V3" />
    </svg>
  ),
  context: (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4.03 3-9 3S3 13.66 3 12" />
      <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
    </svg>
  ),
  skills: (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
    </svg>
  ),
  search: (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  memory: (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="2" y1="10" x2="22" y2="10" />
      <line x1="7" y1="15" x2="7.01" y2="15" strokeWidth="2.5" />
      <line x1="12" y1="15" x2="12.01" y2="15" strokeWidth="2.5" />
      <line x1="17" y1="15" x2="17.01" y2="15" strokeWidth="2.5" />
    </svg>
  ),
  mcp: (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3v6" />
      <path d="M9 6h6" />
      <rect x="4" y="9" width="16" height="8" rx="2" />
      <path d="M8 17v4" />
      <path d="M16 17v4" />
      <path d="M9 13h.01" />
      <path d="M15 13h.01" />
    </svg>
  ),
  federation: (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="5" r="2" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
      <line x1="12" y1="7" x2="5" y2="17" />
      <line x1="12" y1="7" x2="19" y2="17" />
      <line x1="5" y1="19" x2="19" y2="19" />
    </svg>
  ),
  log: (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14,2 14,8 20,8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </svg>
  ),
  json: (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="16,18 22,12 16,6" />
      <polyline points="8,6 2,12 8,18" />
    </svg>
  ),
};

const CAPABILITY_OPTIONS = ['code', 'analysis', 'web_search', 'writing'] as const;
const ACCEPT_OPTIONS = ['task', 'query', 'notification'] as const;
const FALLBACK_TOOL_OPTIONS = [
  'bash',
  'fetch_webpage',
  'file_stat',
  'grep_search',
  'list_directory',
  'memory_delete',
  'memory_search',
  'memory_write',
  'mesh_broadcast',
  'mesh_cancel',
  'mesh_discuss',
  'mesh_list',
  'mesh_plan',
  'mesh_send',
  'mesh_spawn',
  'mesh_status',
  'read_file',
  'send_file_to_channel',
  'send_text_to_channel',
  'skill_list',
  'skill_read',
  'task_cancel',
  'task_list',
  'task_schedule',
  'fetch_webpage',
  'web_search',
  'write_file',
] as const;

interface ToolInfo {
  name: string;
  description: string;
  category: string;
  agentIds: string[];
}

interface ToolListResult {
  tools?: ToolInfo[];
}

interface McpServerStatusInfo {
  serverId: string;
  transport: McpTransport;
  enabled: boolean;
  toolPrefix: string;
  approval: McpApprovalMode;
  timeoutMs: number;
  status: 'connected' | 'error' | 'disabled';
  connectionDetails?: string;
  toolCount: number;
  tools: string[];
  lastError?: string;
  lastErrorCode?: string;
  lastErrorPhase?: string;
  autoRetryEligible?: boolean;
  retryCount?: number;
  nextRetryAt?: number;
  lastConnectedAt?: number;
  lastRefreshAt?: number;
}

interface McpStatusResult {
  servers?: McpServerStatusInfo[];
  summaries?: McpHistorySummaryInfo[];
  attention?: McpAttentionInfo[];
}

interface McpHistorySummaryInfo {
  serverId: string;
  transport: McpTransport;
  totalEvents: number;
  connectedEvents: number;
  errorEvents: number;
  disabledEvents: number;
  recentAttempts: number;
  recentConnectedEvents: number;
  recentSuccessRate: number;
  consecutiveErrors: number;
  autoRetryRecoveryCount: number;
  manualFixErrorCount: number;
  lastOutcome?: 'connected' | 'error' | 'disabled';
  lastTrigger?: 'startup' | 'reload' | 'manual-refresh' | 'auto-retry';
  lastEventAt?: number;
  lastRecoveryAt?: number;
  lastFailureAt?: number;
  lastErrorCode?: string;
}

interface McpAttentionInfo {
  serverId: string;
  severity: 'warning' | 'critical';
  state: 'manual-fix' | 'recovering';
  message: string;
  lastErrorCode?: string;
  retryCount?: number;
  nextRetryAt?: number;
}

interface McpHistoryEventInfo {
  serverId: string;
  transport: McpTransport;
  trigger: 'startup' | 'reload' | 'manual-refresh' | 'auto-retry';
  outcome: 'connected' | 'error' | 'disabled';
  timestamp: number;
  toolPrefix: string;
  approval: McpApprovalMode;
  timeoutMs: number;
  toolCount: number;
  connectionDetails?: string;
  lastError?: string;
  lastErrorCode?: string;
  lastErrorPhase?: string;
  autoRetryEligible?: boolean;
  retryCount?: number;
  nextRetryAt?: number;
}

interface McpHistoryResult {
  records?: McpHistoryEventInfo[];
}

interface McpRefreshResult {
  reloaded?: string[];
  refreshed?: string[];
  servers?: McpServerStatusInfo[];
}

interface McpInspectorState {
  serverId: string;
  loading: boolean;
  error: string | null;
  records: McpHistoryEventInfo[];
}

interface McpToolGroup {
  serverId: string;
  toolPrefix: string;
  tools: string[];
  connected: boolean;
}

interface GroupedModelDef {
  id: string;
  maxTokens: number;
  temperature?: number;
}

interface ModelGroup {
  provider: ModelProviderKind;
  apiKey?: string;
  apiBaseUrl?: string;
  models: Record<string, GroupedModelDef>;
}

interface GatewayConfig {
  bind: BindMode;
  port: number;
  auth: { mode: 'token'; token?: string };
}

interface DefaultsConfig {
  model: string;
  maxTokens: number;
  workspace?: string;
}

interface ContextConfig {
  compaction: { soft: number; medium: number; hard: number };
  systemPrompt: { maxTokens: number; lazy: boolean };
}

interface SkillsConfig {
  dirs: string[];
  compact: boolean;
  summaryLength: number;
}

interface SearchTavily {
  provider: 'tavily';
  apiKey: string;
  maxResults: number;
  searchDepth: 'basic' | 'advanced';
}

interface SearchBing {
  provider: 'bing';
  apiKey: string;
  maxResults: number;
  market: string;
}

interface SearchSerpApi {
  provider: 'serpapi';
  apiKey: string;
  maxResults: number;
  engine: string;
  hl: string;
  gl: string;
}

interface SearchDuckDuckGo {
  provider: 'duckduckgo';
  maxResults: number;
  region: string;
}

type SearchProvider = SearchTavily | SearchBing | SearchSerpApi | SearchDuckDuckGo;

interface SearchConfig {
  providers: SearchProvider[];
}

interface McpServerConfig {
  id: string;
  transport: McpTransport;
  enabled: boolean;
  toolPrefix?: string;
  approval: McpApprovalMode;
  timeoutMs: number;
  command?: string;
  args: string[];
  url?: string;
  env: Record<string, string>;
  allowTools?: string[];
}

interface McpAutoReconnectConfig {
  enabled: boolean;
  pollIntervalMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

function formatMcpTimestamp(value?: number): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return new Date(value).toLocaleString();
}

function formatMcpHistoryTrigger(trigger: McpHistoryEventInfo['trigger']): string {
  switch (trigger) {
    case 'startup':
      return 'startup';
    case 'reload':
      return 'config-reload';
    case 'manual-refresh':
      return 'manual-reconnect';
    case 'auto-retry':
      return 'auto-retry';
  }
}

function formatMcpHistoryOutcome(outcome: McpHistoryEventInfo['outcome']): string {
  switch (outcome) {
    case 'connected':
      return 'connected';
    case 'error':
      return 'error';
    case 'disabled':
      return 'disabled';
  }
}

function formatMcpSuccessRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function formatMcpAttentionState(state: McpAttentionInfo['state']): string {
  return state === 'manual-fix' ? 'manual-fix' : 'auto-retrying';
}

interface McpConfig {
  servers: McpServerConfig[];
  autoReconnect: McpAutoReconnectConfig;
}

interface MemoryConfig {
  enabled: boolean;
  embed: { model: string; provider: 'local' | 'api' };
  decay: { enabled: boolean; halfLifeDays: number };
  maxEntries: number;
}

interface FederationPeer {
  nodeId: string;
  host: string;
  port: number;
  publicKeyHex: string;
}

interface FederationConfig {
  enabled: boolean;
  peers: FederationPeer[];
  discovery: { mdns: boolean; tailscale: boolean; static: boolean };
  economy: {
    mode: 'isolated' | 'invite-only' | 'open-network';
    earn: { maxDaily: number; maxPerTask: number };
    spend: { maxDaily: number; minBalance: number };
    peerToolPolicy: 'none' | 'read-only' | 'safe' | 'full';
    notifications: { onContribution: boolean; monthlyReport: boolean };
  };
}

interface SandboxProfileSummary {
  network: 'none' | 'bridge' | 'full';
  cpu: number;
  memoryMb: number;
  timeoutMs: number;
  writableMounts: string[];
  readOnlyMounts: string[];
}

interface SandboxConfig {
  enabled: boolean;
  provider: 'host' | 'docker';
  image?: string;
  defaultProfile?: string;
  profiles?: Record<string, SandboxProfileSummary>;
}

interface AgentConfig {
  id: string;
  name?: string;
  mentionAliases?: string[];
  workspace?: string;
  skills: string[];
  model?: string;
  mesh: {
    role: MeshRole;
    capabilities: string[];
    accepts: string[];
    visibility: Visibility;
    triggers: string[];
  };
  owners: string[];
  tools: {
    allow?: string[];
    deny: string[];
    approval: string[];
    maxRounds: number;
    sandboxProfile?: string;
  };
  persona: { language: string; outputDir: string };
  soulFile?: string;
  agentsFile?: string;
}

interface LogConfig {
  level: LogLevel;
  format: LogFormat;
}

interface ChannelsConfig {
  defaults: {
    output: 'logs' | 'cli' | 'web' | 'telegram' | 'discord' | 'feishu' | 'qq';
    schedulerOutput: 'logs' | 'cli' | 'web' | 'telegram' | 'discord' | 'feishu' | 'qq';
  };
  cli: { enabled: boolean };
  web: { enabled: boolean };
  logs: { enabled: boolean };
  telegram: {
    enabled: boolean;
    botToken: string;
    defaultAgentId: string;
    allowedChatIds: number[];
    pollIntervalMs: number;
  };
  discord: {
    enabled: boolean;
    botToken: string;
    defaultAgentId: string;
    allowedChannelIds: string[];
    commandPrefix: string;
  };
  feishu: {
    enabled: boolean;
    appId: string;
    appSecret: string;
    verificationToken: string;
    encryptKey: string;
    defaultAgentId: string;
    allowedChatIds: string[];
  };
  qq: {
    enabled: boolean;
    appId: string;
    clientSecret: string;
    defaultAgentId: string;
    allowedGroupIds: string[];
  };
}

interface ConfigShape {
  version: number;
  gateway: GatewayConfig;
  models: Record<string, ModelGroup>;
  defaults: DefaultsConfig;
  context: ContextConfig;
  agents: AgentConfig[];
  skills: SkillsConfig;
  search: SearchConfig;
  memory: MemoryConfig;
  mcp: McpConfig;
  sandbox?: SandboxConfig;
  federation: FederationConfig;
  channels: ChannelsConfig;
  log: LogConfig;
}

interface GroupModalState {
  mode: 'add' | 'edit';
  originalKey?: string;
  groupName: string;
  draft: Omit<ModelGroup, 'models'>;
}

interface ModelInGroupModalState {
  mode: 'add' | 'edit';
  groupName: string;
  originalModelKey?: string;
  modelKey: string;
  draft: GroupedModelDef;
}

interface AgentModalState {
  mode: 'add' | 'edit';
  index?: number;
  draft: AgentConfig;
}

interface SearchModalState {
  mode: 'add' | 'edit';
  index?: number;
  draft: SearchProvider;
}

interface PeerModalState {
  mode: 'add' | 'edit';
  index?: number;
  draft: FederationPeer;
}

interface McpModalState {
  mode: 'add' | 'edit';
  index?: number;
  draft: McpServerConfig;
}

function asStringArray(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function toCsv(values: string[] | undefined): string {
  return (values ?? []).join(', ');
}

function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp_');
}

function uniqueSortedStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function updateAgentMcpToolSelection(
  tools: AgentConfig['tools'],
  discoveredMcpTools: string[],
  selectedMcpTools: string[],
): AgentConfig['tools'] {
  const mcpCatalog = uniqueSortedStrings(discoveredMcpTools.filter(isMcpToolName));
  const selected = new Set(selectedMcpTools.filter((name) => mcpCatalog.includes(name)));
  const nonMcpAllow = (tools.allow ?? []).filter((name) => !isMcpToolName(name));
  const nonMcpDeny = tools.deny.filter((name) => !isMcpToolName(name));
  const nextAllow =
    nonMcpAllow.length === 0 && selected.size === mcpCatalog.length
      ? []
      : uniqueSortedStrings([...nonMcpAllow, ...mcpCatalog.filter((name) => selected.has(name))]);
  const nextDeny = uniqueSortedStrings([
    ...nonMcpDeny,
    ...mcpCatalog.filter((name) => !selected.has(name)),
  ]);

  return {
    ...tools,
    allow: nextAllow,
    deny: nextDeny,
  };
}

function getEnabledMcpTools(tools: AgentConfig['tools'], availableMcpTools: string[]): string[] {
  const allow = tools.allow ?? [];
  const allowed = allow.length > 0 ? new Set(allow.filter(isMcpToolName)) : null;
  const denied = new Set(tools.deny.filter(isMcpToolName));

  return availableMcpTools.filter((name) => !denied.has(name) && (!allowed || allowed.has(name)));
}

function buildMcpToolGroups(
  statuses: McpServerStatusInfo[],
  fallbackTools: string[],
): McpToolGroup[] {
  const groups = new Map<string, McpToolGroup>();
  const seenTools = new Set<string>();

  for (const status of statuses) {
    const tools = uniqueSortedStrings(status.tools.filter(isMcpToolName));
    groups.set(status.serverId, {
      serverId: status.serverId,
      toolPrefix: status.toolPrefix,
      tools,
      connected: status.status === 'connected',
    });
    for (const tool of tools) {
      seenTools.add(tool);
    }
  }

  const ungroupedTools = uniqueSortedStrings(
    fallbackTools.filter((tool) => isMcpToolName(tool) && !seenTools.has(tool)),
  );
  if (ungroupedTools.length > 0) {
    groups.set('__ungrouped__', {
      serverId: 'ungrouped',
      toolPrefix: 'mcp',
      tools: ungroupedTools,
      connected: false,
    });
  }

  return [...groups.values()]
    .filter((group) => group.tools.length > 0)
    .sort((left, right) => {
      const connectedDelta = Number(right.connected) - Number(left.connected);
      if (connectedDelta !== 0) {
        return connectedDelta;
      }
      return left.serverId.localeCompare(right.serverId);
    });
}

function formatGroupedMcpToolName(toolName: string, toolPrefix: string): string {
  const prefix = `${toolPrefix}_`;
  return toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
}

function summarizeEnabledMcpGroups(enabledMcpTools: string[], groups: McpToolGroup[]): string {
  const enabledSet = new Set(enabledMcpTools);
  const groupSummaries = groups
    .map((group) => {
      const activeTools = group.tools.filter((toolName) => enabledSet.has(toolName));
      if (activeTools.length === 0) {
        return null;
      }

      const visibleTools = activeTools
        .slice(0, 2)
        .map((toolName) => formatGroupedMcpToolName(toolName, group.toolPrefix));
      const hiddenToolCount = activeTools.length - visibleTools.length;
      const groupLabel = group.serverId === 'ungrouped' ? 'other' : group.serverId;

      return `${groupLabel}: ${visibleTools.join(', ')}${hiddenToolCount > 0 ? ` +${hiddenToolCount}` : ''}`;
    })
    .filter((summary): summary is string => summary !== null);

  const visibleGroups = groupSummaries.slice(0, 2);
  const hiddenGroupCount = groupSummaries.length - visibleGroups.length;

  return `${visibleGroups.join(' · ')}${hiddenGroupCount > 0 ? ` · +${hiddenGroupCount} server${hiddenGroupCount === 1 ? '' : 's'}` : ''}`;
}

function defaultSearchProvider(kind: SearchProviderKind): SearchProvider {
  if (kind === 'tavily')
    return { provider: 'tavily', apiKey: '', maxResults: 5, searchDepth: 'basic' };
  if (kind === 'bing') return { provider: 'bing', apiKey: '', maxResults: 5, market: 'zh-CN' };
  if (kind === 'serpapi')
    return {
      provider: 'serpapi',
      apiKey: '',
      maxResults: 5,
      engine: 'google',
      hl: 'zh-cn',
      gl: 'cn',
    };
  return { provider: 'duckduckgo', maxResults: 5, region: 'cn-zh' };
}

function defaultAgent(index: number): AgentConfig {
  return {
    id: `agent-${index + 1}`,
    name: `Agent ${index + 1}`,
    mentionAliases: [],
    workspace: '',
    skills: [],
    model: '',
    mesh: {
      role: 'worker',
      capabilities: ['code'],
      accepts: ['task', 'query', 'notification'],
      visibility: 'public',
      triggers: [],
    },
    owners: [],
    tools: { allow: [], deny: [], approval: ['bash'], maxRounds: 60, sandboxProfile: '' },
    persona: { language: 'zh-CN', outputDir: 'output' },
  };
}

function defaultPeer(index: number): FederationPeer {
  return { nodeId: `peer-${index + 1}`, host: '127.0.0.1', port: 19789, publicKeyHex: '' };
}

function defaultMcpServer(index: number): McpServerConfig {
  return {
    id: `server-${index + 1}`,
    transport: 'stdio',
    enabled: true,
    toolPrefix: '',
    approval: 'inherit',
    timeoutMs: 20_000,
    command: '',
    args: [],
    url: '',
    env: {},
    allowTools: [],
  };
}

function formatEnvLines(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function parseEnvLines(value: string): Record<string, string> {
  const next: Record<string, string> = {};
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const splitIndex = line.indexOf('=');
    if (splitIndex === -1) {
      next[line] = '';
      continue;
    }
    const key = line.slice(0, splitIndex).trim();
    if (!key) continue;
    next[key] = line.slice(splitIndex + 1);
  }
  return next;
}

function normalizeAgentDraft(agent: AgentConfig): AgentConfig {
  const sandboxProfile = agent.tools.sandboxProfile?.trim();

  return {
    ...agent,
    tools: {
      ...agent.tools,
      sandboxProfile: sandboxProfile ? sandboxProfile : undefined,
    },
  };
}

function ensureConfigShape(raw: unknown): ConfigShape {
  const data = raw as ConfigShape;
  // Migrate legacy flat model entries { provider, id, maxTokens } → grouped format
  if (data.models && typeof data.models === 'object') {
    const migrated: Record<string, ModelGroup> = {};
    for (const [key, entry] of Object.entries(data.models)) {
      const e = entry as
        | ModelGroup
        | {
            provider: ModelProviderKind;
            id: string;
            maxTokens: number;
            temperature?: number;
            apiKey?: string;
            apiBaseUrl?: string;
          };
      if ('models' in e && e.models !== null && typeof e.models === 'object') {
        migrated[key] = e as ModelGroup;
      } else {
        const flat = e as {
          provider: ModelProviderKind;
          id: string;
          maxTokens: number;
          temperature?: number;
          apiKey?: string;
          apiBaseUrl?: string;
        };
        migrated[key] = {
          provider: flat.provider,
          apiKey: flat.apiKey,
          apiBaseUrl: flat.apiBaseUrl,
          models: {
            default: { id: flat.id, maxTokens: flat.maxTokens, temperature: flat.temperature },
          },
        };
      }
    }
    data.models = migrated;
  }
  data.mcp = {
    autoReconnect: {
      enabled: data.mcp?.autoReconnect?.enabled ?? true,
      pollIntervalMs: data.mcp?.autoReconnect?.pollIntervalMs ?? 5_000,
      baseDelayMs: data.mcp?.autoReconnect?.baseDelayMs ?? 15_000,
      maxDelayMs: Math.max(
        data.mcp?.autoReconnect?.baseDelayMs ?? 15_000,
        data.mcp?.autoReconnect?.maxDelayMs ?? 300_000,
      ),
    },
    servers: Array.isArray(data.mcp?.servers)
      ? data.mcp.servers.map((server) => ({
          id: server.id,
          transport: server.transport ?? 'stdio',
          enabled: server.enabled ?? true,
          toolPrefix: server.toolPrefix ?? '',
          approval: server.approval ?? 'inherit',
          timeoutMs: server.timeoutMs ?? 20_000,
          command: server.command ?? '',
          args: Array.isArray(server.args) ? server.args : [],
          url: server.url ?? '',
          env:
            server.env && typeof server.env === 'object'
              ? Object.fromEntries(
                  Object.entries(server.env).filter(
                    (entry): entry is [string, string] => typeof entry[1] === 'string',
                  ),
                )
              : {},
          allowTools: Array.isArray(server.allowTools) ? server.allowTools : [],
        }))
      : [],
  };
  return data;
}

// ── UI Primitives ────────────────────────────────────────────────────────────

function HelpTip({ text }: { text: string }) {
  return (
    <span className="relative inline-flex items-center group">
      <span className="h-4 w-4 rounded-full bg-slate-700 hover:bg-slate-600 text-[10px] text-slate-300 inline-flex items-center justify-center cursor-help transition-colors">
        ?
      </span>
      <span className="pointer-events-none absolute z-20 left-6 top-1/2 -translate-y-1/2 hidden group-hover:block whitespace-pre-wrap w-72 rounded-lg bg-slate-900 ring-1 ring-slate-600/80 shadow-xl px-3 py-2 text-[11px] text-slate-200 leading-relaxed">
        {text}
      </span>
    </span>
  );
}

function FieldLabel({ label, help }: { label: string; help: string }) {
  return (
    <span className="text-sm text-slate-300 inline-flex items-center gap-2 font-medium">
      {label}
      <HelpTip text={help} />
    </span>
  );
}

function PanelSection({
  title,
  description,
  children,
}: { title: string; description?: string; children: ReactNode }) {
  return (
    <section
      className="rounded-xl p-5 flex flex-col gap-4 ring-1 ring-white/[0.07]"
      style={{ background: 'rgba(14,17,28,0.85)' }}
    >
      <div>
        <h3 className="text-[13px] font-semibold text-slate-100">{title}</h3>
        {description && (
          <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function FieldRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4 items-center">{children}</div>;
}

const inputCls =
  'bg-slate-900/80 ring-1 ring-slate-700 focus:ring-indigo-500/60 focus:outline-none text-slate-200 text-sm rounded-lg px-3 py-2 transition-shadow w-full';
const selectCls =
  'bg-slate-900/80 ring-1 ring-slate-700 focus:ring-indigo-500/60 focus:outline-none text-slate-200 text-sm rounded-lg px-3 py-2 transition-shadow w-full';

function TextRow({
  label,
  help,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  help: string;
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <FieldRow>
      <FieldLabel label={label} help={help} />
      <input
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={inputCls}
      />
    </FieldRow>
  );
}

function NumberRow({
  label,
  help,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  help: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  return (
    <FieldRow>
      <FieldLabel label={label} help={help} />
      <input
        type="number"
        min={min}
        max={max}
        value={Number.isFinite(value) ? String(value) : '0'}
        onChange={(e) => onChange(Number(e.target.value))}
        className={inputCls}
      />
    </FieldRow>
  );
}

function ToggleRow({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <FieldRow>
      <FieldLabel label={label} help={help} />
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 ${checked ? 'bg-indigo-600' : 'bg-slate-700'}`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${checked ? 'translate-x-6' : 'translate-x-1'}`}
        />
      </button>
    </FieldRow>
  );
}

function SelectRow<T extends string>({
  label,
  help,
  value,
  options,
  onChange,
}: {
  label: string;
  help: string;
  value: T;
  options: T[];
  onChange: (value: T) => void;
}) {
  return (
    <FieldRow>
      <FieldLabel label={label} help={help} />
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className={selectCls}>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </FieldRow>
  );
}

// Model select grouped by user-named groups — uses <optgroup> per group,
// options are "groupName/modelKey" values so references are unambiguous.
function GroupedModelSelect({
  label,
  help,
  value,
  onChange,
  modelGroups,
  includeNone = false,
}: {
  label: string;
  help: string;
  value: string;
  onChange: (v: string) => void;
  modelGroups: Record<string, ModelGroup>;
  includeNone?: boolean;
}) {
  const groups = Object.entries(modelGroups);

  return (
    <FieldRow>
      <FieldLabel label={label} help={help} />
      <select value={value} onChange={(e) => onChange(e.target.value)} className={selectCls}>
        {(includeNone || groups.length === 0) && <option value="">— (default) —</option>}
        {groups.map(([groupName, group]) => {
          const models = Object.entries(group.models ?? {});
          if (models.length === 0) return null;
          return (
            <optgroup
              key={groupName}
              label={`${groupName} (${PROVIDER_LABELS[group.provider] ?? group.provider})`}
            >
              {models.map(([modelKey, def]) => (
                <option key={`${groupName}/${modelKey}`} value={`${groupName}/${modelKey}`}>
                  {modelKey} — {def.id || '(no id)'}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </FieldRow>
  );
}

function MultiChoiceRow({
  label,
  help,
  options,
  selected,
  onChange,
}: {
  label: string;
  help: string;
  options: readonly string[];
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  return (
    <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4 items-start">
      <FieldLabel label={label} help={help} />
      <div className="grid grid-cols-2 gap-2">
        {options.map((opt) => {
          const checked = selected.includes(opt);
          return (
            <label
              key={opt}
              className="inline-flex items-center gap-2 text-sm text-slate-300 bg-slate-800/60 ring-1 ring-slate-700/40 rounded-lg px-3 py-2 cursor-pointer hover:bg-slate-700/60 transition-colors"
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => {
                  if (e.target.checked) onChange([...selected, opt]);
                  else onChange(selected.filter((v) => v !== opt));
                }}
                className="accent-indigo-500"
              />
              {opt}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function GroupedMcpChoiceRow({
  label,
  help,
  groups,
  selected,
  onChange,
}: {
  label: string;
  help: string;
  groups: McpToolGroup[];
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const [search, setSearch] = useState('');
  const selectedSet = new Set(selected);
  const normalizedSearch = search.trim().toLowerCase();
  const filteredGroups = groups
    .map((group) => {
      const groupLabel = group.serverId === 'ungrouped' ? 'Other MCP tools' : group.serverId;
      const groupMatches = groupLabel.toLowerCase().includes(normalizedSearch);
      const tools =
        normalizedSearch.length === 0 || groupMatches
          ? group.tools
          : group.tools.filter((toolName) => {
              const formattedName = formatGroupedMcpToolName(toolName, group.toolPrefix).toLowerCase();
              return (
                toolName.toLowerCase().includes(normalizedSearch) ||
                formattedName.includes(normalizedSearch)
              );
            });

      return {
        ...group,
        tools,
      };
    })
    .filter((group) => group.tools.length > 0);
  const visibleTools = uniqueSortedStrings(filteredGroups.flatMap((group) => group.tools));
  const selectedVisibleCount = visibleTools.filter((toolName) => selectedSet.has(toolName)).length;

  function updateBatchSelection(toolNames: string[], checked: boolean): void {
    if (checked) {
      onChange(uniqueSortedStrings([...selected, ...toolNames]));
      return;
    }

    const toolSet = new Set(toolNames);
    onChange(selected.filter((value) => !toolSet.has(value)));
  }

  return (
    <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4 items-start">
      <FieldLabel label={label} help={help} />
      <div className="flex flex-col gap-3">
        <div className="rounded-xl border border-slate-700/60 bg-slate-900/45 px-3 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={search}
              placeholder="Search MCP tools or servers"
              onChange={(event) => setSearch(event.target.value)}
              className={`${inputCls} min-w-[220px] flex-1`}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => updateBatchSelection(visibleTools, true)}
              disabled={visibleTools.length === 0 || selectedVisibleCount === visibleTools.length}
            >
              Select Visible
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => updateBatchSelection(visibleTools, false)}
              disabled={selectedVisibleCount === 0}
            >
              Clear Visible
            </Button>
          </div>
          <div className="mt-2 text-[11px] text-slate-500">
            visible tools {visibleTools.length} · selected {selectedVisibleCount}
          </div>
        </div>
        {filteredGroups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/35 px-3 py-4 text-sm text-slate-500">
            No MCP tools match the current search.
          </div>
        ) : (
          filteredGroups.map((group) => {
            const activeGroupToolCount = group.tools.filter((toolName) => selectedSet.has(toolName)).length;

            return (
          <div
            key={group.serverId}
            className="rounded-xl border border-slate-700/60 bg-slate-900/45 px-3 py-3"
          >
            <div className="mb-2 flex flex-wrap items-center gap-2 justify-between">
              <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-slate-100">
                {group.serverId === 'ungrouped' ? 'Other MCP tools' : group.serverId}
              </span>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                  group.connected
                    ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
                    : 'border-slate-600/30 bg-slate-800/70 text-slate-300'
                }`}
              >
                {group.connected ? 'connected' : 'cached'}
              </span>
              <span className="text-[11px] text-slate-500">{group.tools.length} tools</span>
              {activeGroupToolCount > 0 && (
                <span className="text-[11px] text-slate-500">selected {activeGroupToolCount}</span>
              )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => updateBatchSelection(group.tools, true)}
                  disabled={activeGroupToolCount === group.tools.length}
                >
                  Select Group
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => updateBatchSelection(group.tools, false)}
                  disabled={activeGroupToolCount === 0}
                >
                  Clear Group
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
              {group.tools.map((toolName) => {
                const checked = selectedSet.has(toolName);
                return (
                  <label
                    key={toolName}
                    className="inline-flex items-center gap-2 rounded-lg bg-slate-800/60 px-3 py-2 text-sm text-slate-300 ring-1 ring-slate-700/40 transition-colors hover:bg-slate-700/60"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => {
                        if (event.target.checked) onChange([...selected, toolName]);
                        else onChange(selected.filter((value) => value !== toolName));
                      }}
                      className="accent-indigo-500"
                    />
                    <span className="truncate" title={toolName}>
                      {formatGroupedMcpToolName(toolName, group.toolPrefix)}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// CSV field that only commits to parent on blur — prevents trailing-comma being stripped mid-typing
function DeferredTextRow({
  label,
  help,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  help: string;
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [local, setLocal] = useState(value ?? '');
  useEffect(() => {
    setLocal(value ?? '');
  }, [value]);
  return (
    <FieldRow>
      <FieldLabel label={label} help={help} />
      <input
        value={local}
        placeholder={placeholder}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => onChange(local)}
        className={inputCls}
      />
    </FieldRow>
  );
}

// Tag-input with optional preset quick-toggle chips + free-form custom entry
function TagInputRow({
  label,
  help,
  values,
  presets,
  onChange,
}: {
  label: string;
  help: string;
  values: string[];
  presets?: readonly string[];
  onChange: (values: string[]) => void;
}) {
  const [inputVal, setInputVal] = useState('');

  function commit(raw: string) {
    const tag = raw.trim();
    if (tag && !values.includes(tag)) onChange([...values, tag]);
    setInputVal('');
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(inputVal);
    } else if (e.key === 'Backspace' && inputVal === '' && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  }

  return (
    <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4 items-start">
      <FieldLabel label={label} help={help} />
      <div className="flex flex-col gap-2">
        {/* Preset quick-toggle chips */}
        {presets && presets.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {presets.map((opt) => {
              const active = values.includes(opt);
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => {
                    if (active) onChange(values.filter((v) => v !== opt));
                    else onChange([...values, opt]);
                  }}
                  className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                    active
                      ? 'bg-indigo-600/30 border-indigo-500/50 text-indigo-300'
                      : 'border-slate-700/60 text-slate-500 hover:text-slate-200 hover:border-slate-600'
                  }`}
                  style={active ? {} : { background: 'rgba(30,34,50,0.6)' }}
                >
                  {opt}
                </button>
              );
            })}
          </div>
        )}
        {/* Tag display + custom-entry input */}
        <div
          className="min-h-[36px] flex flex-wrap gap-1.5 items-center ring-1 ring-slate-700 focus-within:ring-indigo-500/60 rounded-lg px-2 py-1.5 transition-shadow"
          style={{ background: 'rgba(15,18,30,0.8)' }}
        >
          {values.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 text-xs bg-slate-700/70 text-slate-200 rounded-md px-2 py-0.5 shrink-0"
            >
              {tag}
              <button
                type="button"
                onClick={() => onChange(values.filter((v) => v !== tag))}
                className="text-slate-400 hover:text-white leading-none ml-0.5"
                aria-label={`Remove ${tag}`}
              >
                ×
              </button>
            </span>
          ))}
          <input
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              if (inputVal.trim()) commit(inputVal);
            }}
            placeholder={values.length === 0 ? 'Enter or , to add…' : ''}
            className="flex-1 min-w-[100px] bg-transparent text-slate-200 text-sm outline-none placeholder:text-slate-600"
          />
        </div>
      </div>
    </div>
  );
}

function ListSummary({ values }: { values: string[] }) {
  return (
    <span className="text-sm text-slate-400">{values.length > 0 ? values.join(', ') : 'none'}</span>
  );
}

function ItemCard({ children }: { children: ReactNode }) {
  return (
    <div
      className="rounded-xl px-4 py-3 flex items-center justify-between gap-3 ring-1 ring-white/[0.07] hover:ring-white/[0.12] transition-all"
      style={{ background: 'rgba(12,15,24,0.7)' }}
    >
      {children}
    </div>
  );
}

function FormModal({
  title,
  description,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  description: string;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center backdrop-blur-sm"
      style={{ background: 'rgba(0,0,0,0.65)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-2xl mx-4 rounded-2xl flex flex-col overflow-hidden"
        style={{
          maxHeight: '85vh',
          background: 'linear-gradient(160deg, rgba(20,23,37,0.98) 0%, rgba(12,14,22,0.98) 100%)',
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(99,102,241,0.08) inset',
        }}
      >
        {/* Header — fixed */}
        <div className="px-6 pt-6 pb-4 shrink-0">
          <h3 className="text-[15px] font-semibold text-slate-100">{title}</h3>
          <p className="text-sm text-slate-400 mt-1 leading-relaxed">{description}</p>
        </div>

        {/* Scrollable form area */}
        <div className="flex-1 overflow-y-auto px-6">
          <div className="flex flex-col gap-4 pb-2">{children}</div>
        </div>

        {/* Footer — fixed at bottom */}
        <div
          className="px-6 py-4 flex justify-end gap-2 shrink-0"
          style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
        >
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={onSubmit}>
            Confirm
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Config Panels ────────────────────────────────────────────────────────────

interface PanelProps {
  cfg: ConfigShape;
  onChange: (next: ConfigShape) => void;
  modelKeys: string[];
  mcpToolOptions: string[];
  availableSkills: SkillInfo[];
  sandboxProfileOptions: string[];
  defaultSandboxProfile?: string;
  groupModal: GroupModalState | null;
  setGroupModal: (m: GroupModalState | null) => void;
  modelInGroupModal: ModelInGroupModalState | null;
  setModelInGroupModal: (m: ModelInGroupModalState | null) => void;
  agentModal: AgentModalState | null;
  setAgentModal: (m: AgentModalState | null) => void;
  searchModal: SearchModalState | null;
  setSearchModal: (m: SearchModalState | null) => void;
  peerModal: PeerModalState | null;
  setPeerModal: (m: PeerModalState | null) => void;
  mcpModal: McpModalState | null;
  setMcpModal: (m: McpModalState | null) => void;
  mcpStatus: McpServerStatusInfo[];
  mcpSummaries: McpHistorySummaryInfo[];
  mcpAttention: McpAttentionInfo[];
  mcpHistory: McpHistoryEventInfo[];
  onRefreshMcp: (serverId?: string) => void;
  onInspectMcp: (serverId: string) => void;
  mcpRefreshing: boolean;
  mcpRefreshingTarget: string | null;
}

function McpHistoryEventCard({ record }: { record: McpHistoryEventInfo }) {
  const outcomeTone =
    record.outcome === 'connected'
      ? 'text-emerald-200 bg-emerald-500/10 border-emerald-500/20'
      : record.outcome === 'disabled'
        ? 'text-slate-300 bg-slate-700/40 border-slate-600/30'
        : 'text-amber-200 bg-amber-500/10 border-amber-500/20';
  const triggerTone =
    record.trigger === 'auto-retry'
      ? 'text-cyan-200 bg-cyan-500/10 border-cyan-500/20'
      : record.trigger === 'manual-refresh'
        ? 'text-indigo-200 bg-indigo-500/10 border-indigo-500/20'
        : 'text-slate-300 bg-slate-700/40 border-slate-600/30';
  const nextRetryAt = formatMcpTimestamp(record.nextRetryAt);

  return (
    <div className="rounded-xl border border-white/8 bg-slate-900/60 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-slate-100">{record.serverId}</span>
        <span className="rounded-full border border-slate-600/30 bg-slate-800/60 px-2 py-0.5 uppercase tracking-wide text-slate-300">
          {record.transport}
        </span>
        <span className={`rounded-full border px-2 py-0.5 uppercase tracking-wide ${triggerTone}`}>
          {formatMcpHistoryTrigger(record.trigger)}
        </span>
        <span className={`rounded-full border px-2 py-0.5 uppercase tracking-wide ${outcomeTone}`}>
          {formatMcpHistoryOutcome(record.outcome)}
        </span>
        <span className="text-slate-500">{formatMcpTimestamp(record.timestamp)}</span>
      </div>
      <div className="mt-2 text-[11px] text-slate-500 leading-relaxed">
        prefix={record.toolPrefix} · approval={record.approval} · timeout={record.timeoutMs}ms · tools={record.toolCount}
        {typeof record.retryCount === 'number' ? ` · retries=${record.retryCount}` : ''}
        {nextRetryAt ? ` · next retry ${nextRetryAt}` : ''}
      </div>
      {record.connectionDetails && record.outcome === 'connected' && (
        <div className="mt-1.5 text-[11px] text-cyan-200/80 break-all">{record.connectionDetails}</div>
      )}
      {record.lastError && (
        <div className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 leading-relaxed">
          {(record.lastErrorCode || record.lastErrorPhase || record.autoRetryEligible === false) && (
            <div className="mb-1 flex flex-wrap gap-1.5">
              {record.lastErrorPhase && (
                <span className="rounded-full border border-amber-500/20 bg-amber-950/40 px-1.5 py-0.5 uppercase tracking-wide text-[10px] text-amber-100/90">
                  phase={record.lastErrorPhase}
                </span>
              )}
              {record.lastErrorCode && (
                <span className="rounded-full border border-amber-500/20 bg-amber-950/40 px-1.5 py-0.5 uppercase tracking-wide text-[10px] text-amber-100/90">
                  code={record.lastErrorCode}
                </span>
              )}
              {record.autoRetryEligible === false && (
                <span className="rounded-full border border-rose-500/20 bg-rose-950/40 px-1.5 py-0.5 uppercase tracking-wide text-[10px] text-rose-100/90">
                  manual-fix
                </span>
              )}
            </div>
          )}
          {record.lastError}
        </div>
      )}
    </div>
  );
}

function McpHistoryInspectorModal({
  server,
  runtimeStatus,
  summary,
  attention,
  inspector,
  onClose,
  onRefresh,
}: {
  server?: McpServerConfig;
  runtimeStatus?: McpServerStatusInfo;
  summary?: McpHistorySummaryInfo;
  attention?: McpAttentionInfo;
  inspector: McpInspectorState;
  onClose: () => void;
  onRefresh: () => void;
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="w-full max-w-5xl mx-4 max-h-[88vh] overflow-auto rounded-2xl bg-slate-900 ring-1 ring-slate-700 p-5 flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-slate-100">MCP Server Drilldown · {inspector.serverId}</h3>
            <p className="text-xs text-slate-400 mt-1">
              {server?.transport === 'stdio'
                ? `command=${server.command || '(unset)'}`
                : `url=${server?.url || '(unset)'}`}
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onRefresh}>
              Refresh History
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <div className="rounded-xl border border-white/10 bg-slate-900/60 px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">Runtime</div>
            <div className="mt-1 text-lg font-semibold text-slate-100">{runtimeStatus?.status ?? 'unknown'}</div>
          </div>
          <div className="rounded-xl border border-white/10 bg-slate-900/60 px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">Recent Success</div>
            <div className="mt-1 text-lg font-semibold text-slate-100">
              {summary ? formatMcpSuccessRate(summary.recentSuccessRate) : '—'}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-slate-900/60 px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">Attempts</div>
            <div className="mt-1 text-lg font-semibold text-slate-100">{summary?.recentAttempts ?? 0}</div>
          </div>
          <div className="rounded-xl border border-white/10 bg-slate-900/60 px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">Consecutive Errors</div>
            <div className="mt-1 text-lg font-semibold text-slate-100">{summary?.consecutiveErrors ?? 0}</div>
          </div>
          <div className="rounded-xl border border-white/10 bg-slate-900/60 px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">Auto Recoveries</div>
            <div className="mt-1 text-lg font-semibold text-slate-100">{summary?.autoRetryRecoveryCount ?? 0}</div>
          </div>
          <div className="rounded-xl border border-white/10 bg-slate-900/60 px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">Manual Fix Events</div>
            <div className="mt-1 text-lg font-semibold text-slate-100">{summary?.manualFixErrorCount ?? 0}</div>
          </div>
        </div>

        {(summary?.lastFailureAt || summary?.lastRecoveryAt || attention) && (
          <div className="rounded-xl border border-white/8 bg-slate-900/60 px-4 py-3 text-sm text-slate-300 leading-relaxed">
            {summary?.lastFailureAt && <div>Last failure: {formatMcpTimestamp(summary.lastFailureAt)}</div>}
            {summary?.lastRecoveryAt && <div>Last recovery: {formatMcpTimestamp(summary.lastRecoveryAt)}</div>}
            {attention && (
              <div className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-100">
                <div className="font-medium">{formatMcpAttentionState(attention.state)}</div>
                <div className="mt-1">{attention.message}</div>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium text-slate-200">Recent Events</div>
          {inspector.loading ? (
            <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/40 px-4 py-5 text-sm text-slate-400">
              Loading server history…
            </div>
          ) : inspector.error ? (
            <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-5 text-sm text-rose-200">
              {inspector.error}
            </div>
          ) : inspector.records.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/40 px-4 py-5 text-sm text-slate-400">
              No MCP runtime events recorded yet for this server.
            </div>
          ) : (
            inspector.records.map((record, index) => (
              <McpHistoryEventCard key={`${record.serverId}-${record.timestamp}-${index}`} record={record} />
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function GatewayPanel({ cfg, onChange }: Pick<PanelProps, 'cfg' | 'onChange'>) {
  return (
    <PanelSection title="Gateway" description="Network binding, port, and authentication settings.">
      <SelectRow
        label="Bind mode"
        help="Network interface to bind the gateway.\n• loopback — 127.0.0.1 only\n• local — all LAN interfaces\n• tailscale — Tailscale VPN interface"
        value={cfg.gateway.bind}
        options={['loopback', 'local', 'tailscale']}
        onChange={(bind) => onChange({ ...cfg, gateway: { ...cfg.gateway, bind } })}
      />
      <NumberRow
        label="Port"
        help="TCP port the gateway listens on."
        value={cfg.gateway.port}
        min={1}
        max={65535}
        onChange={(port) => onChange({ ...cfg, gateway: { ...cfg.gateway, port } })}
      />
      <TextRow
        label="Auth token"
        help="Bearer token for RPC authentication. Clients must send: Authorization: Bearer <token>."
        value={cfg.gateway.auth.token ?? ''}
        placeholder="(leave blank to disable auth)"
        onChange={(token) =>
          onChange({ ...cfg, gateway: { ...cfg.gateway, auth: { ...cfg.gateway.auth, token } } })
        }
      />
    </PanelSection>
  );
}

function ChannelsPanel({ cfg, onChange }: Pick<PanelProps, 'cfg' | 'onChange'>) {
  return (
    <div className="flex flex-col gap-4">
      <PanelSection
        title="Defaults"
        description="Default output channel for agent replies and scheduler tasks."
      >
        <SelectRow
          label="Default output"
          help="Channel for agent reply routing when not specified per-session."
          value={cfg.channels.defaults.output}
          options={['logs', 'cli', 'web', 'telegram', 'discord', 'feishu', 'qq']}
          onChange={(output) =>
            onChange({
              ...cfg,
              channels: { ...cfg.channels, defaults: { ...cfg.channels.defaults, output } },
            })
          }
        />
        <SelectRow
          label="Scheduler output"
          help="Channel for scheduled task result delivery."
          value={cfg.channels.defaults.schedulerOutput}
          options={['logs', 'cli', 'web', 'telegram', 'discord', 'feishu', 'qq']}
          onChange={(schedulerOutput) =>
            onChange({
              ...cfg,
              channels: {
                ...cfg.channels,
                defaults: { ...cfg.channels.defaults, schedulerOutput },
              },
            })
          }
        />
      </PanelSection>

      <PanelSection title="Built-in Channels" description="CLI, Web UI, and Logs output channels.">
        <ToggleRow
          label="CLI channel"
          help="Enable CLI interactive channel."
          checked={cfg.channels.cli?.enabled ?? false}
          onChange={(enabled) =>
            onChange({ ...cfg, channels: { ...cfg.channels, cli: { enabled } } })
          }
        />
        <ToggleRow
          label="Web channel"
          help="Enable web console channel."
          checked={cfg.channels.web?.enabled ?? false}
          onChange={(enabled) =>
            onChange({ ...cfg, channels: { ...cfg.channels, web: { enabled } } })
          }
        />
        <ToggleRow
          label="Logs channel"
          help="Route replies to gateway log output."
          checked={cfg.channels.logs?.enabled ?? false}
          onChange={(enabled) =>
            onChange({ ...cfg, channels: { ...cfg.channels, logs: { enabled } } })
          }
        />
      </PanelSection>

      <PanelSection title="Telegram" description="Telegram bot via long-polling.">
        <ToggleRow
          label="Enabled"
          help="Enable Telegram bot channel."
          checked={cfg.channels.telegram?.enabled ?? false}
          onChange={(enabled) =>
            onChange({
              ...cfg,
              channels: { ...cfg.channels, telegram: { ...cfg.channels.telegram, enabled } },
            })
          }
        />
        {cfg.channels.telegram?.enabled && (
          <div className="pl-4 border-l-2 border-indigo-600/40 flex flex-col gap-3">
            <TextRow
              label="Bot token"
              help="Telegram bot token from @BotFather."
              value={cfg.channels.telegram.botToken}
              onChange={(botToken) =>
                onChange({
                  ...cfg,
                  channels: { ...cfg.channels, telegram: { ...cfg.channels.telegram, botToken } },
                })
              }
            />
            <TextRow
              label="Default agent ID"
              help="Agent that handles Telegram messages."
              value={cfg.channels.telegram.defaultAgentId ?? 'main'}
              onChange={(defaultAgentId) =>
                onChange({
                  ...cfg,
                  channels: {
                    ...cfg.channels,
                    telegram: { ...cfg.channels.telegram, defaultAgentId },
                  },
                })
              }
            />
            <TextRow
              label="Allowed chat IDs"
              help="Comma-separated numeric chat IDs. Empty = allow all."
              value={(cfg.channels.telegram.allowedChatIds ?? []).join(', ')}
              onChange={(raw) => {
                const allowedChatIds = raw
                  .split(',')
                  .map((s) => Number(s.trim()))
                  .filter(Number.isFinite);
                onChange({
                  ...cfg,
                  channels: {
                    ...cfg.channels,
                    telegram: { ...cfg.channels.telegram, allowedChatIds },
                  },
                });
              }}
            />
            <NumberRow
              label="Poll interval (ms)"
              help="Long-poll interval in milliseconds."
              value={cfg.channels.telegram.pollIntervalMs ?? 1000}
              min={500}
              onChange={(pollIntervalMs) =>
                onChange({
                  ...cfg,
                  channels: {
                    ...cfg.channels,
                    telegram: { ...cfg.channels.telegram, pollIntervalMs },
                  },
                })
              }
            />
          </div>
        )}
      </PanelSection>

      <PanelSection title="Discord" description="Discord bot using slash commands.">
        <ToggleRow
          label="Enabled"
          help="Enable Discord bot channel."
          checked={cfg.channels.discord?.enabled ?? false}
          onChange={(enabled) =>
            onChange({
              ...cfg,
              channels: { ...cfg.channels, discord: { ...cfg.channels.discord, enabled } },
            })
          }
        />
        {cfg.channels.discord?.enabled && (
          <div className="pl-4 border-l-2 border-indigo-600/40 flex flex-col gap-3">
            <TextRow
              label="Bot token"
              help="Discord bot token from Discord Developer Portal."
              value={cfg.channels.discord.botToken}
              onChange={(botToken) =>
                onChange({
                  ...cfg,
                  channels: { ...cfg.channels, discord: { ...cfg.channels.discord, botToken } },
                })
              }
            />
            <TextRow
              label="Default agent ID"
              help="Agent that handles Discord messages."
              value={cfg.channels.discord.defaultAgentId ?? 'main'}
              onChange={(defaultAgentId) =>
                onChange({
                  ...cfg,
                  channels: {
                    ...cfg.channels,
                    discord: { ...cfg.channels.discord, defaultAgentId },
                  },
                })
              }
            />
            <TextRow
              label="Command prefix"
              help="Prefix for bot commands (e.g. !)."
              value={cfg.channels.discord.commandPrefix ?? '!'}
              onChange={(commandPrefix) =>
                onChange({
                  ...cfg,
                  channels: {
                    ...cfg.channels,
                    discord: { ...cfg.channels.discord, commandPrefix },
                  },
                })
              }
            />
            <TextRow
              label="Allowed channel IDs"
              help="Comma-separated Discord channel IDs. Empty = allow all."
              value={(cfg.channels.discord.allowedChannelIds ?? []).join(', ')}
              onChange={(raw) => {
                const allowedChannelIds = raw
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean);
                onChange({
                  ...cfg,
                  channels: {
                    ...cfg.channels,
                    discord: { ...cfg.channels.discord, allowedChannelIds },
                  },
                });
              }}
            />
          </div>
        )}
      </PanelSection>

      <PanelSection title="Feishu / Lark" description="Feishu Open Platform webhook events.">
        <ToggleRow
          label="Enabled"
          help="Enable Feishu bot channel. Configure event subscription URL in Feishu as: https://your-gateway/channels/feishu/event"
          checked={cfg.channels.feishu?.enabled ?? false}
          onChange={(enabled) =>
            onChange({
              ...cfg,
              channels: { ...cfg.channels, feishu: { ...cfg.channels.feishu, enabled } },
            })
          }
        />
        {cfg.channels.feishu?.enabled && (
          <div className="pl-4 border-l-2 border-indigo-600/40 flex flex-col gap-3">
            <TextRow
              label="App ID"
              help="Feishu Open Platform App ID (e.g. cli_xxxxxxxx)."
              value={cfg.channels.feishu.appId ?? ''}
              onChange={(appId) =>
                onChange({
                  ...cfg,
                  channels: { ...cfg.channels, feishu: { ...cfg.channels.feishu, appId } },
                })
              }
            />
            <TextRow
              label="App Secret"
              help="Feishu App Secret. Keep this secret."
              value={cfg.channels.feishu.appSecret ?? ''}
              onChange={(appSecret) =>
                onChange({
                  ...cfg,
                  channels: { ...cfg.channels, feishu: { ...cfg.channels.feishu, appSecret } },
                })
              }
            />
            <TextRow
              label="Verification token"
              help="Legacy verification token from event subscription page. Leave blank if using Encrypt Key."
              value={cfg.channels.feishu.verificationToken ?? ''}
              onChange={(verificationToken) =>
                onChange({
                  ...cfg,
                  channels: {
                    ...cfg.channels,
                    feishu: { ...cfg.channels.feishu, verificationToken },
                  },
                })
              }
            />
            <TextRow
              label="Encrypt key"
              help="AES encrypt key for event payload decryption (recommended)."
              value={cfg.channels.feishu.encryptKey ?? ''}
              onChange={(encryptKey) =>
                onChange({
                  ...cfg,
                  channels: { ...cfg.channels, feishu: { ...cfg.channels.feishu, encryptKey } },
                })
              }
            />
            <TextRow
              label="Default agent ID"
              help="Agent that receives Feishu messages."
              value={cfg.channels.feishu.defaultAgentId ?? 'main'}
              onChange={(defaultAgentId) =>
                onChange({
                  ...cfg,
                  channels: { ...cfg.channels, feishu: { ...cfg.channels.feishu, defaultAgentId } },
                })
              }
            />
            <TextRow
              label="Allowed chat IDs"
              help="Comma-separated Feishu chat IDs. Empty = allow all."
              value={(cfg.channels.feishu.allowedChatIds ?? []).join(', ')}
              onChange={(raw) => {
                const allowedChatIds = raw
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean);
                onChange({
                  ...cfg,
                  channels: { ...cfg.channels, feishu: { ...cfg.channels.feishu, allowedChatIds } },
                });
              }}
            />
          </div>
        )}
      </PanelSection>

      <PanelSection title="QQ 开放平台" description="QQ Open Platform webhook events.">
        <ToggleRow
          label="Enabled"
          help="Enable QQ bot channel. Configure callback URL as: https://your-gateway/channels/qq/event"
          checked={cfg.channels.qq?.enabled ?? false}
          onChange={(enabled) =>
            onChange({ ...cfg, channels: { ...cfg.channels, qq: { ...cfg.channels.qq, enabled } } })
          }
        />
        {cfg.channels.qq?.enabled && (
          <div className="pl-4 border-l-2 border-indigo-600/40 flex flex-col gap-3">
            <TextRow
              label="App ID"
              help="QQ Open Platform App ID."
              value={cfg.channels.qq.appId ?? ''}
              onChange={(appId) =>
                onChange({
                  ...cfg,
                  channels: { ...cfg.channels, qq: { ...cfg.channels.qq, appId } },
                })
              }
            />
            <TextRow
              label="Client secret"
              help="QQ App client secret. Used for access token and Ed25519 webhook verification."
              value={cfg.channels.qq.clientSecret ?? ''}
              onChange={(clientSecret) =>
                onChange({
                  ...cfg,
                  channels: { ...cfg.channels, qq: { ...cfg.channels.qq, clientSecret } },
                })
              }
            />
            <TextRow
              label="Default agent ID"
              help="Agent that receives QQ messages."
              value={cfg.channels.qq.defaultAgentId ?? 'main'}
              onChange={(defaultAgentId) =>
                onChange({
                  ...cfg,
                  channels: { ...cfg.channels, qq: { ...cfg.channels.qq, defaultAgentId } },
                })
              }
            />
            <TextRow
              label="Allowed group IDs"
              help="Comma-separated QQ group openids. Empty = allow all."
              value={(cfg.channels.qq.allowedGroupIds ?? []).join(', ')}
              onChange={(raw) => {
                const allowedGroupIds = raw
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean);
                onChange({
                  ...cfg,
                  channels: { ...cfg.channels, qq: { ...cfg.channels.qq, allowedGroupIds } },
                });
              }}
            />
          </div>
        )}
      </PanelSection>
    </div>
  );
}

function ModelsPanel({
  cfg,
  onChange,
  setGroupModal,
  setModelInGroupModal,
}: Pick<
  PanelProps,
  'cfg' | 'onChange' | 'setGroupModal' | 'setModelInGroupModal'
>) {
  function openAddGroup() {
    setGroupModal({ mode: 'add', groupName: '', draft: { provider: 'openai-compat' } });
  }

  function openEditGroup(groupName: string, group: ModelGroup) {
    setGroupModal({
      mode: 'edit',
      originalKey: groupName,
      groupName,
      draft: { provider: group.provider, apiKey: group.apiKey, apiBaseUrl: group.apiBaseUrl },
    });
  }

  function openAddModel(groupName: string) {
    const count = Object.keys(cfg.models[groupName]?.models ?? {}).length;
    setModelInGroupModal({
      mode: 'add',
      groupName,
      modelKey: `model-${count + 1}`,
      draft: { id: '', maxTokens: 8192 },
    });
  }

  function openEditModel(groupName: string, modelKey: string, def: GroupedModelDef) {
    setModelInGroupModal({
      mode: 'edit',
      groupName,
      originalModelKey: modelKey,
      modelKey,
      draft: { ...def },
    });
  }

  const groups = Object.entries(cfg.models);

  return (
    <PanelSection
      title="Model Groups"
      description='Group models by provider. Credentials (API key / base URL) are shared per group. Reference a model as "groupName/modelKey" in agent and defaults config.'
    >
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={openAddGroup}>
          + New Group
        </Button>
      </div>

      {groups.length === 0 && (
        <p className="text-sm text-slate-500 text-center py-4">
          No model groups configured. Add a group to get started.
        </p>
      )}

      <div className="flex flex-col gap-3">
        {groups.map(([groupName, group]) => {
          const modelEntries = Object.entries(group.models ?? {});
          const apiKey = group.apiKey?.trim() ?? '';
          const hasApiKey = apiKey.length > 0;
          const hasBaseUrl = !!group.apiBaseUrl?.trim();
          return (
            <div
              key={groupName}
              className="rounded-xl overflow-hidden"
              style={{ border: '1px solid rgba(255,255,255,0.08)' }}
            >
              {/* Group header — shows group name, provider, shared credentials */}
              <div
                className="flex items-center gap-3 px-4 py-2.5"
                style={{
                  background: 'rgba(255,255,255,0.03)',
                  borderBottom: '1px solid rgba(255,255,255,0.06)',
                }}
              >
                <span className="text-[13px] font-bold text-slate-100 shrink-0">{groupName}</span>
                <span className="text-[10px] font-bold text-indigo-300 uppercase tracking-wider shrink-0">
                  {PROVIDER_LABELS[group.provider] ?? group.provider}
                </span>
                {hasApiKey && (
                  <span className="text-xs text-slate-500 font-mono shrink-0">
                    {apiKey.slice(0, 6)}
                    {'\u2022'.repeat(Math.min(8, Math.max(0, apiKey.length - 6)))}
                  </span>
                )}
                {hasBaseUrl && (
                  <span className="text-xs text-slate-500 font-mono truncate max-w-[200px]">
                    {group.apiBaseUrl}
                  </span>
                )}
                <span className="text-xs text-slate-600 shrink-0">
                  {modelEntries.length}&nbsp;model{modelEntries.length !== 1 ? 's' : ''}
                </span>
                <div className="ml-auto flex gap-2 shrink-0">
                  <Button size="sm" variant="ghost" onClick={() => openEditGroup(groupName, group)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => openAddModel(groupName)}>
                    + Add Model
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      const next = { ...cfg.models };
                      delete next[groupName];
                      onChange({ ...cfg, models: next });
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </div>

              {/* Model rows inside this group */}
              {modelEntries.length === 0 ? (
                <div className="px-4 py-3 text-xs text-slate-600 italic">
                  No models yet — use "+ Add Model".
                </div>
              ) : (
                modelEntries.map(([modelKey, def]) => (
                  <div
                    key={modelKey}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-800/30 transition-colors"
                    style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}
                  >
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-semibold text-slate-200">{modelKey}</span>
                      <span className="mx-1.5 text-slate-700">·</span>
                      <span className="text-xs text-slate-400 font-mono">
                        {def.id || <em className="text-slate-600">no id</em>}
                      </span>
                      <span className="ml-2 text-[10px] text-slate-600 font-mono bg-slate-800/60 px-1.5 py-0.5 rounded">
                        {groupName}/{modelKey}
                      </span>
                    </div>
                    <span className="text-xs text-slate-500 shrink-0">
                      max&nbsp;{def.maxTokens.toLocaleString()}
                      {def.temperature !== undefined ? ` · temp ${def.temperature}` : ''}
                    </span>
                    <div className="flex gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openEditModel(groupName, modelKey, def)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          const nextModels = { ...group.models };
                          delete nextModels[modelKey];
                          onChange({
                            ...cfg,
                            models: {
                              ...cfg.models,
                              [groupName]: { ...group, models: nextModels },
                            },
                          });
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          );
        })}
      </div>
    </PanelSection>
  );
}

function AgentsPanel({
  cfg,
  onChange,
  mcpToolOptions,
  mcpStatus,
  setAgentModal,
}: Pick<PanelProps, 'cfg' | 'onChange' | 'mcpToolOptions' | 'mcpStatus' | 'setAgentModal'>) {
  return (
    <PanelSection
      title="Agent Nodes"
      description="Configure agents. Each agent runs independently with its own model, skills, mesh role, and tools policy."
    >
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setAgentModal({ mode: 'add', draft: defaultAgent(cfg.agents.length) })}
        >
          + Add Agent
        </Button>
      </div>
      {cfg.agents.length === 0 && (
        <p className="text-sm text-slate-500 text-center py-4">No agents configured.</p>
      )}
      <div className="flex flex-col gap-2">
        {cfg.agents.map((agent, idx) => {
          const availableAgentMcpTools = uniqueSortedStrings([
            ...mcpToolOptions,
            ...(agent.tools.allow ?? []).filter(isMcpToolName),
            ...agent.tools.deny.filter(isMcpToolName),
          ]);
          const enabledAgentMcpTools = getEnabledMcpTools(agent.tools, availableAgentMcpTools);
          const availableAgentMcpGroups = buildMcpToolGroups(mcpStatus, availableAgentMcpTools);
          const enabledAgentMcpSummary = summarizeEnabledMcpGroups(
            enabledAgentMcpTools,
            availableAgentMcpGroups,
          );

          return (
            <ItemCard key={`${agent.id}-${idx}`}>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-200">
                  {agent.id}
                  {agent.name ? ` · ${agent.name}` : ''}
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  model={agent.model || '(default)'} · role={agent.mesh.role} · accepts:{' '}
                  <ListSummary values={agent.mesh.accepts} />
                  {agent.tools.sandboxProfile ? ` · sandbox=${agent.tools.sandboxProfile}` : ''}
                  {availableAgentMcpTools.length > 0
                    ? ` · mcp=${enabledAgentMcpTools.length}/${availableAgentMcpTools.length}`
                    : ''}
                </div>
                {enabledAgentMcpTools.length > 0 && (
                  <div className="text-xs text-slate-500 mt-0.5 leading-relaxed">
                    MCP: {enabledAgentMcpSummary}
                  </div>
                )}
                {(agent.soulFile || agent.agentsFile) && (
                  <div className="text-xs text-slate-500 mt-0.5">
                    {agent.soulFile && (
                      <span>
                        soul: <span className="text-slate-400 font-mono">{agent.soulFile}</span>
                      </span>
                    )}
                    {agent.soulFile && agent.agentsFile && <span className="mx-1">·</span>}
                    {agent.agentsFile && (
                      <span>
                        agents: <span className="text-slate-400 font-mono">{agent.agentsFile}</span>
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="flex gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setAgentModal({
                      mode: 'edit',
                      index: idx,
                      draft: {
                        ...agent,
                        mesh: { ...agent.mesh },
                        tools: {
                          ...agent.tools,
                          allow: [...(agent.tools.allow ?? [])],
                          deny: [...agent.tools.deny],
                          approval: [...agent.tools.approval],
                          maxRounds: agent.tools.maxRounds ?? 60,
                          sandboxProfile: agent.tools.sandboxProfile ?? '',
                        },
                        persona: { ...agent.persona },
                      },
                    })
                  }
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => onChange({ ...cfg, agents: cfg.agents.filter((_, i) => i !== idx) })}
                >
                  Remove
                </Button>
              </div>
            </ItemCard>
          );
        })}
      </div>
    </PanelSection>
  );
}

function DefaultsPanel({ cfg, onChange }: Pick<PanelProps, 'cfg' | 'onChange'>) {
  return (
    <PanelSection
      title="Defaults"
      description="Fallback settings used when an agent does not override them."
    >
      <GroupedModelSelect
        label="Default model"
        help='Reference as "groupName/modelKey". Must match a model in the registry.'
        value={cfg.defaults.model}
        modelGroups={cfg.models}
        onChange={(model) => onChange({ ...cfg, defaults: { ...cfg.defaults, model } })}
      />
      <NumberRow
        label="Default max tokens"
        help="Token budget when agent-level max tokens is not set."
        value={cfg.defaults.maxTokens}
        min={1}
        onChange={(maxTokens) => onChange({ ...cfg, defaults: { ...cfg.defaults, maxTokens } })}
      />
      <TextRow
        label="Default workspace"
        help="Workspace path fallback for agents without a workspace."
        value={cfg.defaults.workspace ?? ''}
        onChange={(workspace) => onChange({ ...cfg, defaults: { ...cfg.defaults, workspace } })}
      />
    </PanelSection>
  );
}

function ContextPanel({ cfg, onChange }: Pick<PanelProps, 'cfg' | 'onChange'>) {
  return (
    <PanelSection
      title="Context & Compaction"
      description="Token compaction thresholds and system prompt settings."
    >
      <NumberRow
        label="Soft threshold"
        help="Ratio at which soft compaction is triggered (0–1)."
        value={cfg.context.compaction.soft}
        min={0}
        max={1}
        onChange={(soft) =>
          onChange({
            ...cfg,
            context: { ...cfg.context, compaction: { ...cfg.context.compaction, soft } },
          })
        }
      />
      <NumberRow
        label="Medium threshold"
        help="Ratio at which medium compaction is triggered (0–1)."
        value={cfg.context.compaction.medium}
        min={0}
        max={1}
        onChange={(medium) =>
          onChange({
            ...cfg,
            context: { ...cfg.context, compaction: { ...cfg.context.compaction, medium } },
          })
        }
      />
      <NumberRow
        label="Hard threshold"
        help="Ratio at which hard compaction is triggered (0–1)."
        value={cfg.context.compaction.hard}
        min={0}
        max={1}
        onChange={(hard) =>
          onChange({
            ...cfg,
            context: { ...cfg.context, compaction: { ...cfg.context.compaction, hard } },
          })
        }
      />
      <ToggleRow
        label="Lazy system prompt"
        help="Enable lazy loading of large prompt resources."
        checked={cfg.context.systemPrompt.lazy}
        onChange={(lazy) =>
          onChange({
            ...cfg,
            context: { ...cfg.context, systemPrompt: { ...cfg.context.systemPrompt, lazy } },
          })
        }
      />
    </PanelSection>
  );
}

function SkillsPanel({
  cfg,
  onChange,
  availableSkills,
}: Pick<PanelProps, 'cfg' | 'onChange' | 'availableSkills'>) {
  const [showDirModal, setShowDirModal] = useState(false);
  const [dirInput, setDirInput] = useState('');
  const [dirValidating, setDirValidating] = useState(false);
  const [dirValidResult, setDirValidResult] = useState<{
    valid: boolean;
    count: number;
    skills: string[];
  } | null>(null);
  const [dirValidError, setDirValidError] = useState<string | null>(null);

  function openDirModal() {
    setDirInput('');
    setDirValidResult(null);
    setDirValidError(null);
    setDirValidating(false);
    setShowDirModal(true);
  }

  function closeDirModal() {
    setShowDirModal(false);
  }

  async function handleValidateDir() {
    if (!dirInput.trim()) return;
    setDirValidating(true);
    setDirValidResult(null);
    setDirValidError(null);
    try {
      const res = await rpc<{ valid: boolean; count: number; skills: string[] }>(
        'skill.validateDir',
        { dir: dirInput.trim() },
      );
      setDirValidResult(res);
    } catch (e) {
      setDirValidError(e instanceof Error ? e.message : String(e));
    } finally {
      setDirValidating(false);
    }
  }

  function confirmAddDir() {
    if (!dirInput.trim()) return;
    onChange({
      ...cfg,
      skills: { ...cfg.skills, dirs: [...(cfg.skills.dirs ?? []), dirInput.trim()] },
    });
    closeDirModal();
  }

  return (
    <div className="flex flex-col gap-4">
      {showDirModal && (
        <FormModal
          title="Add Skill Directory"
          description="Enter an absolute path to a directory containing SKILL.md files. Click Validate to check for skills."
          onClose={closeDirModal}
          onSubmit={confirmAddDir}
        >
          <div className="flex gap-2">
            <input
              type="text"
              value={dirInput}
              onChange={(e) => {
                setDirInput(e.target.value);
                setDirValidResult(null);
                setDirValidError(null);
              }}
              placeholder="/path/to/skills"
              className="flex-1 font-mono text-sm bg-slate-900/80 ring-1 ring-slate-700 focus:ring-indigo-500/60 focus:outline-none text-slate-200 rounded-xl px-4 py-2 transition-shadow"
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void handleValidateDir()}
              disabled={dirValidating || !dirInput.trim()}
            >
              {dirValidating ? '…' : 'Validate'}
            </Button>
          </div>
          {dirValidResult !== null && (
            <p className={`text-sm ${dirValidResult.valid ? 'text-emerald-400' : 'text-amber-400'}`}>
              {dirValidResult.valid
                ? `✓ Found ${dirValidResult.count} skill${dirValidResult.count !== 1 ? 's' : ''}: ${dirValidResult.skills.join(', ')}`
                : 'No SKILL.md files found — confirm to add anyway.'}
            </p>
          )}
          {dirValidError && <p className="text-sm text-red-400">✗ {dirValidError}</p>}
          {dirValidResult === null && !dirValidError && (
            <p className="text-xs text-slate-500">
              Validate first, or click Confirm to add the directory without checking.
            </p>
          )}
        </FormModal>
      )}
      <PanelSection
        title="Skill Pool Settings"
        description="Global skill directories and compaction behaviour."
      >
        <ToggleRow
          label="Compact summaries"
          help="Inject compact skill summaries into agent system prompt."
          checked={cfg.skills.compact}
          onChange={(compact) => onChange({ ...cfg, skills: { ...cfg.skills, compact } })}
        />
      </PanelSection>

      <PanelSection
        title="Extra Skill Directories"
        description="Additional directories scanned for SKILL.md files. Default dirs (~/.agentflyer/skills, workspace/skills) are always included."
      >
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={openDirModal}
          >
            + Add Dir
          </Button>
        </div>
        {(cfg.skills.dirs ?? []).length === 0 ? (
          <p className="text-sm text-slate-500">
            No extra dirs configured. Default dirs are always scanned.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {(cfg.skills.dirs ?? []).map((dir, i) => (
              <ItemCard key={`${dir}-${i}`}>
                <span className="text-sm font-mono text-slate-300 truncate flex-1">{dir}</span>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() =>
                    onChange({
                      ...cfg,
                      skills: {
                        ...cfg.skills,
                        dirs: (cfg.skills.dirs ?? []).filter((_, j) => j !== i),
                      },
                    })
                  }
                >
                  Remove
                </Button>
              </ItemCard>
            ))}
          </div>
        )}
      </PanelSection>

      <PanelSection
        title={`Discovered Skills (${availableSkills.length})`}
        description="Skills currently found in the pool."
      >
        {availableSkills.length === 0 ? (
          <p className="text-sm text-slate-500">
            No skills detected. Add skill dirs or place SKILL.md files in ~/.agentflyer/skills/.
          </p>
        ) : (
          <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
            {availableSkills.map((sk) => (
              <div
                key={sk.id}
                className="rounded-lg bg-slate-900/50 ring-1 ring-slate-700/40 px-3 py-2.5 flex items-start gap-3"
              >
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-slate-200">{sk.name}</span>
                  <span className="text-xs text-slate-500 ml-2">{sk.shortDesc}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {sk.source === 'builtin' && (
                    <span className="text-xs text-indigo-400 bg-indigo-400/10 px-1.5 py-0.5 rounded">
                      built-in
                    </span>
                  )}
                  {sk.source === 'workspace' && (
                    <span className="text-xs text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded">
                      workspace
                    </span>
                  )}
                  {sk.source === 'user-global' && (
                    <span className="text-xs text-sky-400 bg-sky-400/10 px-1.5 py-0.5 rounded">
                      global
                    </span>
                  )}
                  {sk.apiKeyRequired && (
                    <span className="text-xs text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded">
                      key req'd
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </PanelSection>
    </div>
  );
}

function SearchPanel({
  cfg,
  onChange,
  setSearchModal,
}: Pick<PanelProps, 'cfg' | 'onChange' | 'setSearchModal'>) {
  return (
    <PanelSection
      title="Search Providers"
      description="Ordered search provider chain. Each provider is tried in sequence."
    >
      <div className="flex items-center justify-end gap-2">
        {(['tavily', 'bing', 'serpapi', 'duckduckgo'] as SearchProviderKind[]).map((kind) => (
          <Button
            key={kind}
            size="sm"
            variant="ghost"
            onClick={() => setSearchModal({ mode: 'add', draft: defaultSearchProvider(kind) })}
          >
            + {kind}
          </Button>
        ))}
      </div>
      {cfg.search.providers.length === 0 && (
        <p className="text-sm text-slate-500 text-center py-4">No search providers configured.</p>
      )}
      <div className="flex flex-col gap-2">
        {cfg.search.providers.map((provider, idx) => (
          <ItemCard key={`${provider.provider}-${idx}`}>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-slate-200 capitalize">
                {provider.provider}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">max {provider.maxResults} results</div>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setSearchModal({
                    mode: 'edit',
                    index: idx,
                    draft: { ...provider } as SearchProvider,
                  })
                }
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() =>
                  onChange({
                    ...cfg,
                    search: {
                      ...cfg.search,
                      providers: cfg.search.providers.filter((_, i) => i !== idx),
                    },
                  })
                }
              >
                Remove
              </Button>
            </div>
          </ItemCard>
        ))}
      </div>
    </PanelSection>
  );
}

function MemoryPanel({ cfg, onChange }: Pick<PanelProps, 'cfg' | 'onChange'>) {
  return (
    <PanelSection title="Memory" description="Memory embedding, decay, and retention settings.">
      <ToggleRow
        label="Enabled"
        help="Enable the memory module."
        checked={cfg.memory.enabled}
        onChange={(enabled) => onChange({ ...cfg, memory: { ...cfg.memory, enabled } })}
      />
      <SelectRow
        label="Embed provider"
        help="Embedding provider mode."
        value={cfg.memory.embed.provider}
        options={['local', 'api']}
        onChange={(provider) =>
          onChange({ ...cfg, memory: { ...cfg.memory, embed: { ...cfg.memory.embed, provider } } })
        }
      />
      <TextRow
        label="Embed model"
        help="Embedding model used for memory vectorization."
        value={cfg.memory.embed.model}
        onChange={(model) =>
          onChange({ ...cfg, memory: { ...cfg.memory, embed: { ...cfg.memory.embed, model } } })
        }
      />
      <ToggleRow
        label="Decay enabled"
        help="Enable time-decay scoring on memory retrieval."
        checked={cfg.memory.decay.enabled}
        onChange={(enabled) =>
          onChange({ ...cfg, memory: { ...cfg.memory, decay: { ...cfg.memory.decay, enabled } } })
        }
      />
      <NumberRow
        label="Half-life (days)"
        help="Memory strength decay half-life in days."
        value={cfg.memory.decay.halfLifeDays}
        min={1}
        onChange={(halfLifeDays) =>
          onChange({
            ...cfg,
            memory: { ...cfg.memory, decay: { ...cfg.memory.decay, halfLifeDays } },
          })
        }
      />
      <NumberRow
        label="Max entries"
        help="Maximum number of retained memory entries."
        value={cfg.memory.maxEntries}
        min={1}
        onChange={(maxEntries) => onChange({ ...cfg, memory: { ...cfg.memory, maxEntries } })}
      />
    </PanelSection>
  );
}

function McpPanel({
  cfg,
  onChange,
  setMcpModal,
  mcpStatus,
  mcpSummaries,
  mcpAttention,
  mcpHistory,
  onRefreshMcp,
  onInspectMcp,
  mcpRefreshing,
  mcpRefreshingTarget,
}: Pick<
  PanelProps,
  | 'cfg'
  | 'onChange'
  | 'setMcpModal'
  | 'mcpStatus'
  | 'mcpSummaries'
  | 'mcpAttention'
  | 'mcpHistory'
  | 'onRefreshMcp'
  | 'onInspectMcp'
  | 'mcpRefreshing'
  | 'mcpRefreshingTarget'
>) {
  const servers = cfg.mcp.servers ?? [];
  const statusByServerId = new Map(mcpStatus.map((status) => [status.serverId, status]));
  const summaryByServerId = useMemo(
    () => new Map(mcpSummaries.map((summary) => [summary.serverId, summary])),
    [mcpSummaries],
  );
  const attentionByServerId = useMemo(
    () => new Map(mcpAttention.map((entry) => [entry.serverId, entry])),
    [mcpAttention],
  );
  const [statusFilter, setStatusFilter] = useState<'all' | 'connected' | 'error' | 'disabled' | 'unconfigured'>('all');
  const [transportFilter, setTransportFilter] = useState<'all' | 'stdio' | 'sse'>('all');
  const [errorCodeFilter, setErrorCodeFilter] = useState('all');
  const [errorPhaseFilter, setErrorPhaseFilter] = useState('all');
  const statusSummary = useMemo(
    () => summarizeMcpStatus(servers, mcpStatus),
    [servers, mcpStatus],
  );
  const errorCodeOptions = useMemo(() => collectMcpErrorCodes(mcpStatus), [mcpStatus]);
  const errorPhaseOptions = useMemo(() => collectMcpErrorPhases(mcpStatus), [mcpStatus]);
  const filteredServers = useMemo(
    () =>
      servers.filter((server) =>
        matchMcpServerFilter({
          config: server,
          runtimeStatus: statusByServerId.get(server.id),
          statusFilter,
          transportFilter,
          errorCodeFilter,
          errorPhaseFilter,
        }),
      ),
    [servers, statusByServerId, statusFilter, transportFilter, errorCodeFilter, errorPhaseFilter],
  );
  const hasActiveFilters =
    statusFilter !== 'all' ||
    transportFilter !== 'all' ||
    errorCodeFilter !== 'all' ||
    errorPhaseFilter !== 'all';
  const visibleServerIds = new Set(filteredServers.map((server) => server.id));
  const filteredHistory = useMemo(
    () =>
      mcpHistory.filter((record) =>
        hasActiveFilters
          ? visibleServerIds.has(record.serverId)
          : statusByServerId.has(record.serverId),
      ),
    [mcpHistory, hasActiveFilters, visibleServerIds, statusByServerId],
  );
  const manualFixCount = mcpAttention.filter((entry) => entry.state === 'manual-fix').length;
  const recoveringCount = mcpAttention.filter((entry) => entry.state === 'recovering').length;

  return (
    <div className="flex flex-col gap-4">
      <PanelSection
        title="Auto Reconnect"
        description="Tune MCP automatic recovery behavior instead of relying on a fixed backend policy."
      >
        <ToggleRow
          label="Enabled"
          help="Automatically retry recoverable MCP server failures in the background. Manual-fix errors are never retried automatically."
          checked={cfg.mcp.autoReconnect.enabled}
          onChange={(enabled) =>
            onChange({
              ...cfg,
              mcp: { ...cfg.mcp, autoReconnect: { ...cfg.mcp.autoReconnect, enabled } },
            })
          }
        />
        <NumberRow
          label="Poll interval (ms)"
          help="How often the gateway scans MCP runtime status for due reconnect attempts."
          value={cfg.mcp.autoReconnect.pollIntervalMs}
          min={1000}
          onChange={(pollIntervalMs) =>
            onChange({
              ...cfg,
              mcp: {
                ...cfg.mcp,
                autoReconnect: { ...cfg.mcp.autoReconnect, pollIntervalMs },
              },
            })
          }
        />
        <NumberRow
          label="Base retry delay (ms)"
          help="Initial backoff delay for recoverable MCP connection failures."
          value={cfg.mcp.autoReconnect.baseDelayMs}
          min={1000}
          onChange={(baseDelayMs) =>
            onChange({
              ...cfg,
              mcp: {
                ...cfg.mcp,
                autoReconnect: {
                  ...cfg.mcp.autoReconnect,
                  baseDelayMs,
                  maxDelayMs: Math.max(baseDelayMs, cfg.mcp.autoReconnect.maxDelayMs),
                },
              },
            })
          }
        />
        <NumberRow
          label="Max retry delay (ms)"
          help="Upper bound for exponential backoff during automatic MCP reconnects."
          value={cfg.mcp.autoReconnect.maxDelayMs}
          min={cfg.mcp.autoReconnect.baseDelayMs}
          onChange={(maxDelayMs) =>
            onChange({
              ...cfg,
              mcp: {
                ...cfg.mcp,
                autoReconnect: {
                  ...cfg.mcp.autoReconnect,
                  maxDelayMs: Math.max(cfg.mcp.autoReconnect.baseDelayMs, maxDelayMs),
                },
              },
            })
          }
        />
      </PanelSection>

      <PanelSection
        title="Runtime Summary"
        description="Quick health overview for configured MCP servers, grouped before you drill into one server card."
      >
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-8">
          <div className="rounded-xl border border-white/10 bg-slate-900/60 px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">Configured</div>
            <div className="mt-1 text-2xl font-semibold text-slate-100">{statusSummary.configured}</div>
          </div>
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-emerald-300/80">Connected</div>
            <div className="mt-1 text-2xl font-semibold text-emerald-200">{statusSummary.connected}</div>
          </div>
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-amber-300/80">Errors</div>
            <div className="mt-1 text-2xl font-semibold text-amber-200">{statusSummary.errored}</div>
          </div>
          <div className="rounded-xl border border-slate-600/30 bg-slate-800/40 px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-400">Disabled</div>
            <div className="mt-1 text-2xl font-semibold text-slate-200">{statusSummary.disabled}</div>
          </div>
          <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-cyan-300/80">stdio</div>
            <div className="mt-1 text-2xl font-semibold text-cyan-200">{statusSummary.stdio}</div>
          </div>
          <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-indigo-300/80">sse</div>
            <div className="mt-1 text-2xl font-semibold text-indigo-200">{statusSummary.sse}</div>
          </div>
          <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-rose-300/80">Manual Fix</div>
            <div className="mt-1 text-2xl font-semibold text-rose-200">{manualFixCount}</div>
          </div>
          <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-cyan-300/80">Retrying</div>
            <div className="mt-1 text-2xl font-semibold text-cyan-200">{recoveringCount}</div>
          </div>
        </div>
      </PanelSection>

      <PanelSection
        title="Operator Attention"
        description="Current MCP issues that can impact unattended workflow or scheduler execution."
      >
        {mcpAttention.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/40 px-4 py-5 text-sm text-slate-400">
            No MCP operator attention items right now.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {mcpAttention.map((entry) => (
              <div
                key={entry.serverId}
                className="rounded-xl border border-white/8 bg-slate-900/60 px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium text-slate-100">{entry.serverId}</span>
                  <span
                    className={`rounded-full border px-2 py-0.5 uppercase tracking-wide ${
                      entry.severity === 'critical'
                        ? 'text-rose-100 border-rose-500/20 bg-rose-500/10'
                        : 'text-cyan-100 border-cyan-500/20 bg-cyan-500/10'
                    }`}
                  >
                    {formatMcpAttentionState(entry.state)}
                  </span>
                </div>
                <div className="mt-2 text-sm text-slate-200 leading-relaxed">{entry.message}</div>
                {(entry.lastErrorCode || typeof entry.retryCount === 'number' || entry.nextRetryAt) && (
                  <div className="mt-2 text-[11px] text-slate-500 leading-relaxed">
                    {entry.lastErrorCode ? `code=${entry.lastErrorCode}` : ''}
                    {typeof entry.retryCount === 'number' ? ` · retries=${entry.retryCount}` : ''}
                    {entry.nextRetryAt ? ` · next retry ${formatMcpTimestamp(entry.nextRetryAt)}` : ''}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </PanelSection>

      <PanelSection
        title="MCP Servers"
        description="Register external MCP servers and expose their tools through AgentFlyer ToolRegistry. This panel manages config only; health probing stays in a later slice."
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
              className="rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
            >
              <option value="all">status: all</option>
              <option value="connected">status: connected</option>
              <option value="error">status: error</option>
              <option value="disabled">status: disabled</option>
              <option value="unconfigured">status: no runtime</option>
            </select>
            <select
              value={transportFilter}
              onChange={(event) => setTransportFilter(event.target.value as typeof transportFilter)}
              className="rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
            >
              <option value="all">transport: all</option>
              <option value="stdio">transport: stdio</option>
              <option value="sse">transport: sse</option>
            </select>
            <select
              value={errorCodeFilter}
              onChange={(event) => setErrorCodeFilter(event.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
            >
              <option value="all">error code: all</option>
              {errorCodeOptions.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            <select
              value={errorPhaseFilter}
              onChange={(event) => setErrorPhaseFilter(event.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
            >
              <option value="all">error phase: all</option>
              {errorPhaseOptions.map((phase) => (
                <option key={phase} value={phase}>
                  {phase}
                </option>
              ))}
            </select>
            {hasActiveFilters && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setStatusFilter('all');
                  setTransportFilter('all');
                  setErrorCodeFilter('all');
                  setErrorPhaseFilter('all');
                }}
              >
                Clear Filters
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onRefreshMcp()}
              disabled={mcpRefreshing}
            >
              {mcpRefreshing ? 'Refreshing…' : 'Refresh Runtime'}
            </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setMcpModal({ mode: 'add', draft: defaultMcpServer(servers.length) })}
          >
            + Add MCP Server
          </Button>
          </div>
        </div>

        {servers.length === 0 ? (
          <p className="text-sm text-slate-500">
            No MCP servers configured. Add a server here instead of editing raw JSON.
          </p>
        ) : filteredServers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/40 px-4 py-5 text-sm text-slate-400">
            No MCP servers match the current filters. Clear one or more filters to inspect the full runtime surface.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filteredServers.map((server) => {
              const index = servers.findIndex((candidate) => candidate.id === server.id);
              const runtimeStatus = statusByServerId.get(server.id);
              const historySummary = summaryByServerId.get(server.id);
              const serverAttention = attentionByServerId.get(server.id);
              const diagnosticHint = getMcpDiagnosticHint(runtimeStatus?.lastErrorCode);
              const serverRefreshing = mcpRefreshing && mcpRefreshingTarget === server.id;
              const nextRetryAt = formatMcpTimestamp(runtimeStatus?.nextRetryAt);
              const lastConnectedAt = formatMcpTimestamp(runtimeStatus?.lastConnectedAt);
              const lastRefreshAt = formatMcpTimestamp(runtimeStatus?.lastRefreshAt);
              const statusTone =
                runtimeStatus?.status === 'connected'
                  ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20'
                  : runtimeStatus?.status === 'disabled'
                    ? 'text-slate-300 bg-slate-700/40 border-slate-600/30'
                    : 'text-amber-300 bg-amber-500/10 border-amber-500/20';

              return (
              <ItemCard key={`${server.id}-${index}`}>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-slate-200 flex items-center gap-2">
                    <span>{server.id}</span>
                    <span className="text-[10px] uppercase tracking-wide text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 rounded-full px-2 py-0.5">
                      {server.transport}
                    </span>
                    {!server.enabled && (
                      <span className="text-[10px] uppercase tracking-wide text-slate-400 bg-slate-700/40 rounded-full px-2 py-0.5">
                        disabled
                      </span>
                    )}
                    {runtimeStatus && (
                      <span className={`text-[10px] uppercase tracking-wide border rounded-full px-2 py-0.5 ${statusTone}`}>
                        {runtimeStatus.status}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5 leading-relaxed">
                    {server.transport === 'stdio'
                      ? `command=${server.command || '(unset)'}${server.args.length > 0 ? ` ${server.args.join(' ')}` : ''}`
                      : `url=${server.url || '(unset)'}`}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5 leading-relaxed">
                    approval={server.approval} · prefix={server.toolPrefix?.trim() || `mcp_${server.id}`} · timeout={server.timeoutMs}ms
                    {server.allowTools && server.allowTools.length > 0
                      ? ` · allowTools=${server.allowTools.join(', ')}`
                      : ' · allowTools=all'}
                  </div>
                  {runtimeStatus && (
                    <div className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                      tools={runtimeStatus.toolCount}
                      {runtimeStatus.tools.length > 0
                        ? ` · ${runtimeStatus.tools.slice(0, 4).join(', ')}${runtimeStatus.tools.length > 4 ? ' ...' : ''}`
                        : ''}
                    </div>
                  )}
                  {historySummary && (
                    <div className="text-[11px] text-slate-500 mt-1.5 leading-relaxed">
                      recent success {formatMcpSuccessRate(historySummary.recentSuccessRate)} across {historySummary.recentAttempts} attempt{historySummary.recentAttempts === 1 ? '' : 's'}
                      {' · '}consecutive errors {historySummary.consecutiveErrors}
                      {' · '}auto recoveries {historySummary.autoRetryRecoveryCount}
                    </div>
                  )}
                  {runtimeStatus?.connectionDetails && (
                    <div className="text-[11px] text-cyan-200/80 mt-1.5 leading-relaxed break-all">
                      {runtimeStatus.connectionDetails}
                    </div>
                  )}
                  {runtimeStatus && (lastConnectedAt || lastRefreshAt || nextRetryAt) && (
                    <div className="text-[11px] text-slate-500 mt-1.5 leading-relaxed">
                      {lastConnectedAt ? `last connected ${lastConnectedAt}` : 'never connected'}
                      {lastRefreshAt ? ` · last refresh ${lastRefreshAt}` : ''}
                      {nextRetryAt ? ` · next retry ${nextRetryAt}` : ''}
                    </div>
                  )}
                  {runtimeStatus?.lastError && (
                    <div className="mt-1.5 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 leading-relaxed">
                      {(runtimeStatus.lastErrorCode || runtimeStatus.lastErrorPhase) && (
                        <div className="mb-1 flex flex-wrap gap-1.5">
                          {runtimeStatus.lastErrorPhase && (
                            <span className="text-[10px] uppercase tracking-wide text-amber-200/90 bg-amber-950/40 border border-amber-500/20 rounded-full px-1.5 py-0.5">
                              phase={runtimeStatus.lastErrorPhase}
                            </span>
                          )}
                          {runtimeStatus.lastErrorCode && (
                            <span className="text-[10px] uppercase tracking-wide text-amber-200/90 bg-amber-950/40 border border-amber-500/20 rounded-full px-1.5 py-0.5">
                              code={runtimeStatus.lastErrorCode}
                            </span>
                          )}
                          {typeof runtimeStatus.retryCount === 'number' && runtimeStatus.retryCount > 0 && (
                            <span className="text-[10px] uppercase tracking-wide text-slate-300 bg-slate-950/60 border border-slate-500/20 rounded-full px-1.5 py-0.5">
                              retries={runtimeStatus.retryCount}
                            </span>
                          )}
                          {runtimeStatus.autoRetryEligible === false && (
                            <span className="text-[10px] uppercase tracking-wide text-rose-200/90 bg-rose-950/40 border border-rose-500/20 rounded-full px-1.5 py-0.5">
                              manual-fix
                            </span>
                          )}
                        </div>
                      )}
                      {runtimeStatus.lastError}
                      {diagnosticHint && (
                        <div className="mt-2 rounded-md border border-amber-400/15 bg-slate-950/20 px-2.5 py-2">
                          <div className="font-medium text-amber-100">{diagnosticHint.title}</div>
                          <div className="mt-1 text-amber-100/75">{diagnosticHint.description}</div>
                        </div>
                      )}
                    </div>
                  )}
                  {serverAttention && (
                    <div className="mt-1.5 rounded-lg border border-amber-500/15 bg-slate-950/30 px-3 py-2 text-[11px] text-amber-100/90 leading-relaxed">
                      {serverAttention.message}
                    </div>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onRefreshMcp(server.id)}
                    disabled={mcpRefreshing || server.enabled === false}
                  >
                    {serverRefreshing ? 'Reconnecting…' : 'Reconnect'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onInspectMcp(server.id)}>
                    Inspect History
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setMcpModal({
                        mode: 'edit',
                        index,
                        draft: {
                          ...server,
                          args: [...server.args],
                          env: { ...server.env },
                          allowTools: [...(server.allowTools ?? [])],
                        },
                      })
                    }
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() =>
                      onChange({
                        ...cfg,
                        mcp: {
                          ...cfg.mcp,
                          servers: servers.filter((_, candidateIndex) => candidateIndex !== index),
                        },
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              </ItemCard>
              );
            })}
          </div>
        )}
      </PanelSection>

      <PanelSection
        title="Recent Runtime Events"
        description="Newest-first MCP recovery timeline. Use it to confirm whether a server failed once, kept auto-retrying, or recovered after manual intervention."
      >
        {filteredHistory.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/40 px-4 py-5 text-sm text-slate-400">
            No MCP runtime events recorded yet for the current server scope.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filteredHistory.slice(0, 20).map((record, index) => {
              return (
                <McpHistoryEventCard
                  key={`${record.serverId}-${record.timestamp}-${index}`}
                  record={record}
                />
              );
            })}
          </div>
        )}
      </PanelSection>

      <PanelSection
        title="Operator Notes"
        description="MCP now supports runtime health, reconnect, structured diagnostics, and a recent event timeline. Use these notes to keep the operator path predictable."
      >
        <div className="text-sm text-slate-400 leading-relaxed space-y-2">
          <p>Automatic reconnect only retries recoverable failures. manual-fix states mean the server config or transport contract needs operator intervention.</p>
          <p>Recent Runtime Events shows the last transition per retry or reconnect attempt, so you can tell whether a recovery came from startup, config reload, manual reconnect, or auto retry.</p>
          <p>toolPrefix defaults to mcp_serverId. Keep prefixes stable to avoid tool-name churn across agent prompts and approval rules.</p>
          <p>allowTools is optional. Leave it empty to expose the full server tool catalog; set it when you need a narrower operator-approved surface.</p>
        </div>
      </PanelSection>
    </div>
  );
}

function FederationPanel({
  cfg,
  onChange,
  setPeerModal,
}: Pick<PanelProps, 'cfg' | 'onChange' | 'setPeerModal'>) {
  return (
    <div className="flex flex-col gap-4">
      <PanelSection
        title="Federation Settings"
        description="Enable/disable federation and configure peer discovery and economy."
      >
        <ToggleRow
          label="Enabled"
          help="Enable federation network behavior."
          checked={cfg.federation.enabled}
          onChange={(enabled) => onChange({ ...cfg, federation: { ...cfg.federation, enabled } })}
        />
        <ToggleRow
          label="mDNS discovery"
          help="Enable LAN peer discovery with mDNS."
          checked={cfg.federation.discovery.mdns}
          onChange={(mdns) =>
            onChange({
              ...cfg,
              federation: { ...cfg.federation, discovery: { ...cfg.federation.discovery, mdns } },
            })
          }
        />
        <ToggleRow
          label="Tailscale discovery"
          help="Enable peer discovery via Tailscale network."
          checked={cfg.federation.discovery.tailscale}
          onChange={(tailscale) =>
            onChange({
              ...cfg,
              federation: {
                ...cfg.federation,
                discovery: { ...cfg.federation.discovery, tailscale },
              },
            })
          }
        />
        <SelectRow
          label="Economy mode"
          help="Token economy participation mode."
          value={cfg.federation.economy.mode}
          options={['isolated', 'invite-only', 'open-network']}
          onChange={(modeValue) =>
            onChange({
              ...cfg,
              federation: {
                ...cfg.federation,
                economy: { ...cfg.federation.economy, mode: modeValue },
              },
            })
          }
        />
        <SelectRow
          label="Peer tool policy"
          help="Allowed remote tool policy for federation peers."
          value={cfg.federation.economy.peerToolPolicy}
          options={['none', 'read-only', 'safe', 'full']}
          onChange={(peerToolPolicy) =>
            onChange({
              ...cfg,
              federation: {
                ...cfg.federation,
                economy: { ...cfg.federation.economy, peerToolPolicy },
              },
            })
          }
        />
      </PanelSection>

      <PanelSection
        title="Federation Peers"
        description="Known peer nodes for federated task routing."
      >
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setPeerModal({ mode: 'add', draft: defaultPeer(cfg.federation.peers.length) })
            }
          >
            + Add Peer
          </Button>
        </div>
        {cfg.federation.peers.length === 0 && (
          <p className="text-sm text-slate-500 text-center py-4">No peers configured.</p>
        )}
        <div className="flex flex-col gap-2">
          {cfg.federation.peers.map((peer, idx) => (
            <ItemCard key={`${peer.nodeId}-${idx}`}>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-200">{peer.nodeId}</div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {peer.host}:{peer.port}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setPeerModal({ mode: 'edit', index: idx, draft: { ...peer } })}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() =>
                    onChange({
                      ...cfg,
                      federation: {
                        ...cfg.federation,
                        peers: cfg.federation.peers.filter((_, i) => i !== idx),
                      },
                    })
                  }
                >
                  Remove
                </Button>
              </div>
            </ItemCard>
          ))}
        </div>
      </PanelSection>
    </div>
  );
}

function LogPanel({ cfg, onChange }: Pick<PanelProps, 'cfg' | 'onChange'>) {
  return (
    <PanelSection title="Logging" description="Gateway log level and output format.">
      <SelectRow
        label="Log level"
        help="Minimum log severity to output."
        value={cfg.log.level}
        options={['debug', 'info', 'warn', 'error']}
        onChange={(level) => onChange({ ...cfg, log: { ...cfg.log, level } })}
      />
      <SelectRow
        label="Log format"
        help="Output formatter for log lines."
        value={cfg.log.format}
        options={['json', 'pretty']}
        onChange={(format) => onChange({ ...cfg, log: { ...cfg.log, format } })}
      />
    </PanelSection>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export function ConfigTab() {
  const { toast } = useToast();
  const { t } = useLocale();

  const NAV_SECTIONS: { id: ConfigSection; label: string }[] = [
    { id: 'gateway', label: t('config.sections.gateway') },
    { id: 'channels', label: t('config.sections.channels') },
    { id: 'models', label: t('config.sections.models') },
    { id: 'agents', label: t('config.sections.agents') },
    { id: 'defaults', label: t('config.sections.defaults') },
    { id: 'context', label: t('config.sections.context') },
    { id: 'skills', label: t('config.sections.skills') },
    { id: 'search', label: t('config.sections.search') },
    { id: 'memory', label: t('config.sections.memory') },
    { id: 'mcp', label: t('config.sections.mcp') },
    { id: 'federation', label: t('config.sections.federation') },
    { id: 'log', label: t('config.sections.log') },
    { id: 'json', label: t('config.sections.json') },
  ];
  const [text, setText] = useState('');
  const [cfg, setCfg] = useState<ConfigShape | null>(null);
  const [activeSection, setActiveSection] = useState<ConfigSection>('gateway');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  const [groupModal, setGroupModal] = useState<GroupModalState | null>(null);
  const [modelInGroupModal, setModelInGroupModal] = useState<ModelInGroupModalState | null>(null);
  const [agentModal, setAgentModal] = useState<AgentModalState | null>(null);
  const [searchModal, setSearchModal] = useState<SearchModalState | null>(null);
  const [peerModal, setPeerModal] = useState<PeerModalState | null>(null);
  const [mcpModal, setMcpModal] = useState<McpModalState | null>(null);
  const [mcpInspector, setMcpInspector] = useState<McpInspectorState | null>(null);
  const [mcpRefreshing, setMcpRefreshing] = useState(false);
  const [mcpRefreshingTarget, setMcpRefreshingTarget] = useState<string | null>(null);

  const { data, loading, error, refetch } = useQuery<unknown>(() => rpc<unknown>('config.get'), []);
  const { data: skillListData } = useQuery<SkillListResult>(
    () => rpc<SkillListResult>('skill.list'),
    [],
  );
  const { data: toolListData, refetch: refetchToolList } = useQuery<ToolListResult>(
    () => rpc<ToolListResult>('tool.list'),
    [],
  );
  const { data: mcpStatusData, refetch: refetchMcpStatus } = useQuery<McpStatusResult>(
    () => rpc<McpStatusResult>('mcp.status'),
    [],
  );
  const { data: mcpHistoryData, refetch: refetchMcpHistory } = useQuery<McpHistoryResult>(
    () => rpc<McpHistoryResult>('mcp.history', { limit: 50 }),
    [],
  );

  useEffect(() => {
    if (data !== null && data !== undefined) {
      setCfg(ensureConfigShape(data));
      setText(JSON.stringify(data, null, 2));
      setDirty(false);
    }
  }, [data]);

  const availableSkills: SkillInfo[] = useMemo(() => skillListData?.skills ?? [], [skillListData]);
  const toolCatalog = useMemo(() => toolListData?.tools ?? [], [toolListData]);
  const toolOptions = useMemo(() => {
    if (toolCatalog.length === 0) {
      return [...new Set(FALLBACK_TOOL_OPTIONS)];
    }
    return toolCatalog
      .slice()
      .sort((left, right) => {
        const categoryCompare = left.category.localeCompare(right.category);
        if (categoryCompare !== 0) return categoryCompare;
        return left.name.localeCompare(right.name);
      })
      .map((tool) => tool.name);
  }, [toolCatalog]);
  const mcpToolOptions = useMemo(
    () =>
      uniqueSortedStrings([
        ...toolCatalog.filter((tool) => tool.category === 'mcp').map((tool) => tool.name),
        ...(mcpStatusData?.servers ?? []).flatMap((server) => server.tools.filter(isMcpToolName)),
      ]),
    [mcpStatusData, toolCatalog],
  );
  const modelKeys = useMemo(() => {
    if (!cfg) return [];
    return Object.entries(cfg.models).flatMap(([g, grp]) =>
      Object.keys(grp.models ?? {}).map((m) => `${g}/${m}`),
    );
  }, [cfg]);
  const sandboxProfileOptions = useMemo(() => {
    if (!cfg?.sandbox?.profiles) return [];
    return Object.keys(cfg.sandbox.profiles).sort((left, right) => left.localeCompare(right));
  }, [cfg]);
  const agentMcpToolOptions = useMemo(() => {
    if (!agentModal) return mcpToolOptions;
    return uniqueSortedStrings([
      ...mcpToolOptions,
      ...(agentModal.draft.tools.allow ?? []).filter(isMcpToolName),
      ...agentModal.draft.tools.deny.filter(isMcpToolName),
    ]);
  }, [agentModal, mcpToolOptions]);
  const selectedAgentMcpTools = useMemo(() => {
    if (!agentModal) return [];
    return getEnabledMcpTools(agentModal.draft.tools, agentMcpToolOptions);
  }, [agentModal, agentMcpToolOptions]);
  const agentMcpToolGroups = useMemo(
    () => buildMcpToolGroups(mcpStatusData?.servers ?? [], agentMcpToolOptions),
    [agentMcpToolOptions, mcpStatusData],
  );
  const defaultSandboxProfile = cfg?.sandbox?.defaultProfile;

  function handleCfgChange(next: ConfigShape) {
    setCfg(next);
    setText(JSON.stringify(next, null, 2));
    setDirty(true);
    setParseError(null);
  }

  function handleJsonChange(raw: string) {
    setText(raw);
    setDirty(true);
    try {
      setCfg(ensureConfigShape(JSON.parse(raw)));
      setParseError(null);
    } catch {
      setParseError('Invalid JSON — fix before saving.');
    }
  }

  async function handleSave() {
    if (!cfg || parseError) return;
    setSaving(true);
    try {
      await rpc('config.save', cfg);
      setDirty(false);
      refetchMcpStatus();
      refetchMcpHistory();
      refetchToolList();
      toast('Config saved', 'success');
    } catch (e) {
      toast(`Save failed: ${String(e)}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  function openMcpInspector(serverId: string): void {
    setMcpInspector({ serverId, loading: true, error: null, records: [] });
    void rpc<McpHistoryResult>('mcp.history', { serverId, limit: 100 })
      .then((result) => {
        setMcpInspector({
          serverId,
          loading: false,
          error: null,
          records: result.records ?? [],
        });
      })
      .catch((error) => {
        setMcpInspector({
          serverId,
          loading: false,
          error: `Failed to load MCP history: ${String(error)}`,
          records: [],
        });
      });
  }

  function handleRefreshMcp(serverId?: string): void {
    setMcpRefreshing(true);
    setMcpRefreshingTarget(serverId ?? null);
    void rpc<McpRefreshResult>('mcp.refresh', serverId ? { serverId } : undefined)
      .then((result) => {
        refetchMcpStatus();
        refetchMcpHistory();
        refetchToolList();
        if (mcpInspector?.serverId && (!serverId || serverId === mcpInspector.serverId)) {
          openMcpInspector(mcpInspector.serverId);
        }
        const refreshedLabel = result.refreshed?.length
          ? result.refreshed.join(', ')
          : serverId ?? 'all servers';
        toast(`MCP runtime refreshed: ${refreshedLabel}`, 'success');
      })
      .catch((e) => {
        toast(`MCP refresh failed: ${String(e)}`, 'error');
      })
      .finally(() => {
        setMcpRefreshing(false);
        setMcpRefreshingTarget(null);
      });
  }

  function handleReset() {
    refetch();
    setDirty(false);
    setParseError(null);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-400 text-sm gap-2">
        <span className="animate-spin">⟳</span> Loading config…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center justify-center h-64 text-red-400 text-sm">
        Failed to load config: {String(error)}
      </div>
    );
  }

  const panelProps: PanelProps = {
    cfg: cfg!,
    onChange: handleCfgChange,
    modelKeys,
    availableSkills,
    mcpToolOptions,
    sandboxProfileOptions,
    defaultSandboxProfile,
    groupModal,
    setGroupModal,
    modelInGroupModal,
    setModelInGroupModal,
    agentModal,
    setAgentModal,
    searchModal,
    setSearchModal,
    peerModal,
    setPeerModal,
    mcpModal,
    setMcpModal,
    mcpStatus: mcpStatusData?.servers ?? [],
    mcpSummaries: mcpStatusData?.summaries ?? [],
    mcpAttention: mcpStatusData?.attention ?? [],
    mcpHistory: mcpHistoryData?.records ?? [],
    onRefreshMcp: handleRefreshMcp,
    onInspectMcp: openMcpInspector,
    mcpRefreshing,
    mcpRefreshingTarget,
  };

  return (
    <div className="flex h-[calc(100vh-4rem)] bg-slate-950">
      {/* ── Left Config Nav ── */}
      <nav
        className="w-52 shrink-0 flex flex-col h-full"
        style={{
          background: 'linear-gradient(180deg, rgba(12,14,22,0.9) 0%, rgba(9,11,18,0.9) 100%)',
          borderRight: '1px solid rgba(255,255,255,0.055)',
        }}
      >
        <div
          className="px-4 py-[14px]"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.055)' }}
        >
          <h2 className="text-[10.5px] font-semibold text-slate-500 uppercase tracking-[0.12em]">
            Settings
          </h2>
        </div>

        <div className="flex-1 overflow-y-auto py-2 px-2">
          {NAV_SECTIONS.map(({ id, label }) => {
            const active = activeSection === id;
            return (
              <button
                key={id}
                onClick={() => setActiveSection(id)}
                className={`relative w-full flex items-center gap-3 px-3 py-[9px] rounded-lg text-[13px] font-medium mb-px text-left transition-colors duration-150 ${
                  active
                    ? 'text-indigo-300 bg-indigo-500/10'
                    : 'text-slate-500 hover:text-slate-200 hover:bg-white/[0.04]'
                }`}
              >
                {active && (
                  <span className="absolute left-0 top-[7px] bottom-[7px] w-[2px] rounded-r-full bg-indigo-400" />
                )}
                <span className={`shrink-0 ${active ? 'text-indigo-400' : ''}`}>
                  {ConfigIco[id]}
                </span>
                <span className="truncate">{label}</span>
                {dirty && active && (
                  <span className="ml-auto h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
                )}
              </button>
            );
          })}
        </div>

        {/* Save / Reset in nav footer */}
        <div className="px-3 py-3 border-t border-slate-700/50 flex flex-col gap-2">
          {parseError && <p className="text-xs text-red-400 px-1">{parseError}</p>}
          {dirty && !parseError && <p className="text-xs text-amber-400 px-1">Unsaved changes</p>}
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={saving || !dirty || !!parseError}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
          <Button variant="ghost" size="sm" onClick={handleReset} disabled={saving}>
            Reset
          </Button>
        </div>
      </nav>

      {/* ── Right Content Panel ── */}
      <div className="flex-1 overflow-y-auto p-6">
        {!cfg ? (
          <div className="flex items-center justify-center h-64 text-slate-400 text-sm">
            No config loaded.
          </div>
        ) : (
          <>
            {activeSection === 'gateway' && <GatewayPanel cfg={cfg} onChange={handleCfgChange} />}
            {activeSection === 'channels' && <ChannelsPanel cfg={cfg} onChange={handleCfgChange} />}
            {activeSection === 'models' && <ModelsPanel {...panelProps} />}
            {activeSection === 'agents' && <AgentsPanel {...panelProps} />}
            {activeSection === 'defaults' && (
              <DefaultsPanel cfg={cfg} onChange={handleCfgChange} />
            )}
            {activeSection === 'context' && <ContextPanel cfg={cfg} onChange={handleCfgChange} />}
            {activeSection === 'skills' && (
              <SkillsPanel cfg={cfg} onChange={handleCfgChange} availableSkills={availableSkills} />
            )}
            {activeSection === 'search' && <SearchPanel {...panelProps} />}
            {activeSection === 'memory' && <MemoryPanel cfg={cfg} onChange={handleCfgChange} />}
            {activeSection === 'mcp' && <McpPanel {...panelProps} />}
            {activeSection === 'federation' && <FederationPanel {...panelProps} />}
            {activeSection === 'log' && <LogPanel cfg={cfg} onChange={handleCfgChange} />}
            {activeSection === 'json' && (
              <PanelSection
                title="Raw JSON"
                description="Directly edit the config JSON. Errors block saving."
              >
                <textarea
                  value={text}
                  onChange={(e) => handleJsonChange(e.target.value)}
                  rows={32}
                  spellCheck={false}
                  className="w-full font-mono text-sm bg-slate-900/80 ring-1 ring-slate-700 focus:ring-indigo-500/60 focus:outline-none text-slate-200 rounded-xl px-4 py-3 resize-none transition-shadow"
                />
              </PanelSection>
            )}
          </>
        )}
      </div>

      {/* ── CRUD Modals ── */}
      {cfg && groupModal && (
        <FormModal
          title={groupModal.mode === 'add' ? 'Add Model Group' : 'Edit Model Group'}
          description="A group shares one provider, API key, and base URL. Add individual models inside the group."
          onClose={() => setGroupModal(null)}
          onSubmit={() => {
            const trimmedName = groupModal.groupName.trim();
            if (!trimmedName) return;
            const nextModels = { ...cfg.models };
            if (
              groupModal.mode === 'edit' &&
              groupModal.originalKey &&
              groupModal.originalKey !== trimmedName
            ) {
              // Rename: preserve existing models sub-object under new key
              const existing = nextModels[groupModal.originalKey];
              delete nextModels[groupModal.originalKey];
              nextModels[trimmedName] = { ...groupModal.draft, models: existing?.models ?? {} };
            } else if (groupModal.mode === 'edit' && groupModal.originalKey) {
              nextModels[groupModal.originalKey] = {
                ...groupModal.draft,
                models: nextModels[groupModal.originalKey]?.models ?? {},
              };
            } else {
              nextModels[trimmedName] = { ...groupModal.draft, models: {} };
            }
            handleCfgChange({ ...cfg, models: nextModels });
            setGroupModal(null);
          }}
        >
          <TextRow
            label="Group name"
            help="Short English identifier for this provider group (e.g. deepseek, anthropic). Used as the prefix in model references like groupName/modelKey."
            value={groupModal.groupName}
            onChange={(groupName) => setGroupModal({ ...groupModal, groupName })}
          />
          <SelectRow
            label="Provider"
            help="LLM provider protocol for all models in this group."
            value={groupModal.draft.provider}
            options={['anthropic', 'openai', 'google', 'ollama', 'openai-compat']}
            onChange={(provider) =>
              setGroupModal({ ...groupModal, draft: { ...groupModal.draft, provider } })
            }
          />
          <TextRow
            label="API base URL"
            help="Required for openai-compat and ollama. E.g. https://api.deepseek.com/v1"
            value={groupModal.draft.apiBaseUrl ?? ''}
            onChange={(apiBaseUrl) =>
              setGroupModal({ ...groupModal, draft: { ...groupModal.draft, apiBaseUrl } })
            }
          />
          <TextRow
            label="API key"
            help="Shared API key for all models in this group."
            value={groupModal.draft.apiKey ?? ''}
            onChange={(apiKey) =>
              setGroupModal({ ...groupModal, draft: { ...groupModal.draft, apiKey } })
            }
          />
        </FormModal>
      )}

      {cfg && modelInGroupModal && (
        <FormModal
          title={
            modelInGroupModal.mode === 'add'
              ? `Add Model to "${modelInGroupModal.groupName}"`
              : `Edit Model in "${modelInGroupModal.groupName}"`
          }
          description={`Reference this model as ${modelInGroupModal.groupName}/${modelInGroupModal.modelKey || '<key>'} in agent and defaults config.`}
          onClose={() => setModelInGroupModal(null)}
          onSubmit={() => {
            const { groupName, modelKey, originalModelKey, draft } = modelInGroupModal;
            const trimmedKey = modelKey.trim();
            if (!trimmedKey) return;
            const group = cfg.models[groupName];
            if (!group) return;
            const nextGroupModels = { ...group.models };
            if (originalModelKey && originalModelKey !== trimmedKey) {
              delete nextGroupModels[originalModelKey];
            }
            nextGroupModels[trimmedKey] = draft;
            handleCfgChange({
              ...cfg,
              models: { ...cfg.models, [groupName]: { ...group, models: nextGroupModels } },
            });
            setModelInGroupModal(null);
          }}
        >
          <TextRow
            label="Model key"
            help='Local key within the group (e.g. chat, fast, reasoner). The full reference will be "groupName/modelKey".'
            value={modelInGroupModal.modelKey}
            onChange={(modelKey) => setModelInGroupModal({ ...modelInGroupModal, modelKey })}
          />
          <TextRow
            label="Provider model ID"
            help="Exact model identifier on the provider side (e.g. deepseek-chat, claude-3-5-haiku-latest)."
            value={modelInGroupModal.draft.id}
            onChange={(id) =>
              setModelInGroupModal({
                ...modelInGroupModal,
                draft: { ...modelInGroupModal.draft, id },
              })
            }
          />
          <NumberRow
            label="Max tokens"
            help="Completion token budget for this model."
            value={modelInGroupModal.draft.maxTokens}
            min={1}
            onChange={(maxTokens) =>
              setModelInGroupModal({
                ...modelInGroupModal,
                draft: { ...modelInGroupModal.draft, maxTokens },
              })
            }
          />
          <NumberRow
            label="Temperature"
            help="Sampling temperature in [0, 2]. Leave at 0 to use provider default."
            value={modelInGroupModal.draft.temperature ?? 0}
            min={0}
            max={2}
            onChange={(temperature) =>
              setModelInGroupModal({
                ...modelInGroupModal,
                draft: { ...modelInGroupModal.draft, temperature },
              })
            }
          />
        </FormModal>
      )}

      {cfg && agentModal && (
        <FormModal
          title={agentModal.mode === 'add' ? 'Add Agent' : 'Edit Agent'}
          description="Configure agent identity, model, mesh role, and tools policy."
          onClose={() => setAgentModal(null)}
          onSubmit={() => {
            const list = [...cfg.agents];
            const normalizedDraft = normalizeAgentDraft(agentModal.draft);
            if (agentModal.mode === 'add') list.push(normalizedDraft);
            else if (agentModal.index !== undefined) list[agentModal.index] = normalizedDraft;
            handleCfgChange({ ...cfg, agents: list });
            setAgentModal(null);
          }}
        >
          <TextRow
            label="Agent ID"
            help="Unique identifier for routing and sessions."
            value={agentModal.draft.id}
            onChange={(id) => setAgentModal({ ...agentModal, draft: { ...agentModal.draft, id } })}
          />
          <TextRow
            label="Name"
            help="Display name for console and logs."
            value={agentModal.draft.name ?? ''}
            onChange={(name) =>
              setAgentModal({ ...agentModal, draft: { ...agentModal.draft, name } })
            }
          />
          <TextRow
            label="Mention aliases"
            help="Comma-separated aliases accepted by the chat Hub and @mention routing."
            value={toCsv(agentModal.draft.mentionAliases)}
            onChange={(mentionAliases) =>
              setAgentModal({
                ...agentModal,
                draft: {
                  ...agentModal.draft,
                  mentionAliases: asStringArray(mentionAliases),
                },
              })
            }
          />
          <TextRow
            label="Workspace"
            help="Agent workspace path."
            value={agentModal.draft.workspace ?? ''}
            onChange={(workspace) =>
              setAgentModal({ ...agentModal, draft: { ...agentModal.draft, workspace } })
            }
          />
          <TextRow
            label="Soul file"
            help="Optional path of SOUL.md override for this agent."
            value={agentModal.draft.soulFile ?? ''}
            onChange={(soulFile) =>
              setAgentModal({ ...agentModal, draft: { ...agentModal.draft, soulFile } })
            }
          />
          <TextRow
            label="Agents file"
            help="Optional path of AGENTS.md override for this agent."
            value={agentModal.draft.agentsFile ?? ''}
            onChange={(agentsFile) =>
              setAgentModal({ ...agentModal, draft: { ...agentModal.draft, agentsFile } })
            }
          />
          <GroupedModelSelect
            label="Model"
            help='Select from the model registry. Format: "groupName/modelKey".'
            value={agentModal.draft.model ?? ''}
            modelGroups={cfg?.models}
            includeNone
            onChange={(model) =>
              setAgentModal({ ...agentModal, draft: { ...agentModal.draft, model } })
            }
          />
          <SelectRow
            label="Mesh role"
            help="Agent role in the distributed mesh."
            value={agentModal.draft.mesh.role}
            options={['coordinator', 'worker', 'specialist', 'observer']}
            onChange={(role) =>
              setAgentModal({
                ...agentModal,
                draft: { ...agentModal.draft, mesh: { ...agentModal.draft.mesh, role } },
              })
            }
          />
          <SelectRow
            label="Visibility"
            help="Agent discoverability in mesh."
            value={agentModal.draft.mesh.visibility}
            options={['public', 'private']}
            onChange={(visibility) =>
              setAgentModal({
                ...agentModal,
                draft: { ...agentModal.draft, mesh: { ...agentModal.draft.mesh, visibility } },
              })
            }
          />
          <MultiChoiceRow
            label="Capabilities"
            help="Capability flags for this agent."
            options={CAPABILITY_OPTIONS}
            selected={agentModal.draft.mesh.capabilities}
            onChange={(capabilities) =>
              setAgentModal({
                ...agentModal,
                draft: { ...agentModal.draft, mesh: { ...agentModal.draft.mesh, capabilities } },
              })
            }
          />
          <MultiChoiceRow
            label="Accepts"
            help="Inbound message kinds this agent handles."
            options={ACCEPT_OPTIONS}
            selected={agentModal.draft.mesh.accepts}
            onChange={(accepts) =>
              setAgentModal({
                ...agentModal,
                draft: { ...agentModal.draft, mesh: { ...agentModal.draft.mesh, accepts } },
              })
            }
          />
          <MultiChoiceRow
            label="Tools approval"
            help="Tools requiring interactive user approval."
            options={toolOptions}
            selected={agentModal.draft.tools.approval}
            onChange={(approval) =>
              setAgentModal({
                ...agentModal,
                draft: { ...agentModal.draft, tools: { ...agentModal.draft.tools, approval } },
              })
            }
          />
          {agentMcpToolOptions.length > 0 ? (
            <GroupedMcpChoiceRow
              label="Available MCP tools"
              help="勾选这个 Agent 可以使用的 MCP 工具。这里会自动同步对应的 allow 和 deny 规则。"
              groups={agentMcpToolGroups}
              selected={selectedAgentMcpTools}
              onChange={(selectedMcpTools) =>
                setAgentModal({
                  ...agentModal,
                  draft: {
                    ...agentModal.draft,
                    tools: updateAgentMcpToolSelection(
                      agentModal.draft.tools,
                      agentMcpToolOptions,
                      selectedMcpTools,
                    ),
                  },
                })
              }
            />
          ) : (
            <FieldRow>
              <FieldLabel
                label="Available MCP tools"
                help="先在 MCP 面板连通并刷新运行时，这里才会出现可勾选的 MCP 工具。"
              />
              <div className="rounded-lg border border-dashed border-slate-700 bg-slate-900/40 px-3 py-2 text-sm text-slate-500">
                No MCP tools discovered yet.
              </div>
            </FieldRow>
          )}
          <TagInputRow
            label="Tools allow"
            help="Optional tool allowlist — checked preset or custom name. Empty = all tools allowed."
            values={agentModal.draft.tools.allow ?? []}
            presets={toolOptions}
            onChange={(allow) =>
              setAgentModal({
                ...agentModal,
                draft: { ...agentModal.draft, tools: { ...agentModal.draft.tools, allow } },
              })
            }
          />
          <TagInputRow
            label="Tools deny"
            help="Tool denylist — these tools are blocked for this agent."
            values={agentModal.draft.tools.deny}
            presets={toolOptions}
            onChange={(deny) =>
              setAgentModal({
                ...agentModal,
                draft: { ...agentModal.draft, tools: { ...agentModal.draft.tools, deny } },
              })
            }
          />
          <NumberRow
            label="Tool round cap"
            help="Safety cap for tool-invoking rounds in one turn. Increase this for longer autonomous tasks."
            value={agentModal.draft.tools.maxRounds}
            min={1}
            onChange={(maxRounds) =>
              setAgentModal({
                ...agentModal,
                draft: {
                  ...agentModal.draft,
                  tools: {
                    ...agentModal.draft.tools,
                    maxRounds: Number.isFinite(maxRounds) && maxRounds > 0 ? maxRounds : 60,
                  },
                },
              })
            }
          />
          <FieldRow>
            <FieldLabel
              label="Sandbox profile"
              help={`Optional sandbox profile override for execution tools. Leave blank to use sandbox.defaultProfile${defaultSandboxProfile ? ` (${defaultSandboxProfile})` : ''}.`}
            />
            <select
              value={agentModal.draft.tools.sandboxProfile ?? ''}
              onChange={(e) => {
                const sandboxProfile = e.target.value;
                setAgentModal({
                  ...agentModal,
                  draft: {
                    ...agentModal.draft,
                    tools: {
                      ...agentModal.draft.tools,
                      sandboxProfile,
                    },
                  },
                });
              }}
              className={selectCls}
            >
              <option value="">
                Use sandbox.defaultProfile{defaultSandboxProfile ? ` (${defaultSandboxProfile})` : ''}
              </option>
              {sandboxProfileOptions.map((profileName) => (
                <option key={profileName} value={profileName}>
                  {profileName}
                </option>
              ))}
            </select>
          </FieldRow>
          <TagInputRow
            label="Triggers"
            help="Keywords that activate this agent. Press Enter or comma to add each trigger."
            values={agentModal.draft.mesh.triggers}
            onChange={(triggers) =>
              setAgentModal({
                ...agentModal,
                draft: { ...agentModal.draft, mesh: { ...agentModal.draft.mesh, triggers } },
              })
            }
          />
          {availableSkills.length > 0 ? (
            <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4 items-start">
              <FieldLabel
                label="Skills"
                help="Select skills from the global pool to assign to this agent."
              />
              <div className="flex flex-col gap-1 max-h-40 overflow-y-auto bg-slate-900/60 ring-1 ring-slate-700/50 rounded-xl p-2">
                {availableSkills.map((sk) => {
                  const checked = agentModal.draft.skills.includes(sk.id);
                  return (
                    <label
                      key={sk.id}
                      className="inline-flex items-start gap-2 text-sm text-slate-300 hover:bg-slate-700/40 rounded-lg px-2 py-1.5 cursor-pointer transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const skills = e.target.checked
                            ? [...agentModal.draft.skills, sk.id]
                            : agentModal.draft.skills.filter((s) => s !== sk.id);
                          setAgentModal({ ...agentModal, draft: { ...agentModal.draft, skills } });
                        }}
                        className="mt-0.5 accent-indigo-500 shrink-0"
                      />
                      <span className="flex flex-col gap-0.5 flex-1 min-w-0">
                        <span className="font-medium flex items-center gap-1.5">
                          {sk.name}
                          {sk.source === 'builtin' && (
                            <span className="text-xs text-indigo-400 bg-indigo-400/10 px-1 py-0.5 rounded leading-none">
                              built-in
                            </span>
                          )}
                          {sk.source === 'workspace' && (
                            <span className="text-xs text-emerald-400 bg-emerald-400/10 px-1 py-0.5 rounded leading-none">
                              workspace
                            </span>
                          )}
                          {sk.source === 'user-global' && (
                            <span className="text-xs text-sky-400 bg-sky-400/10 px-1 py-0.5 rounded leading-none">
                              global
                            </span>
                          )}
                        </span>
                        <span className="text-xs text-slate-500">{sk.shortDesc}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ) : (
            <DeferredTextRow
              label="Skills (CSV)"
              help="Skill IDs assigned to this agent. Add skill dirs in the Skills section."
              value={toCsv(agentModal.draft.skills)}
              onChange={(v) =>
                setAgentModal({
                  ...agentModal,
                  draft: { ...agentModal.draft, skills: asStringArray(v) },
                })
              }
            />
          )}
          <DeferredTextRow
            label="Owners (CSV)"
            help="Owner IDs allowed to manage this agent. Comma-separated."
            value={toCsv(agentModal.draft.owners)}
            onChange={(v) =>
              setAgentModal({
                ...agentModal,
                draft: { ...agentModal.draft, owners: asStringArray(v) },
              })
            }
          />
          <TextRow
            label="Persona language"
            help="BCP-47 language tag for response language."
            value={agentModal.draft.persona.language}
            onChange={(language) =>
              setAgentModal({
                ...agentModal,
                draft: { ...agentModal.draft, persona: { ...agentModal.draft.persona, language } },
              })
            }
          />
          <TextRow
            label="Persona output dir"
            help="Default output folder under workspace."
            value={agentModal.draft.persona.outputDir}
            onChange={(outputDir) =>
              setAgentModal({
                ...agentModal,
                draft: { ...agentModal.draft, persona: { ...agentModal.draft.persona, outputDir } },
              })
            }
          />
        </FormModal>
      )}

      {cfg && searchModal && (
        <FormModal
          title={searchModal.mode === 'add' ? 'Add Search Provider' : 'Edit Search Provider'}
          description="Configure provider type and provider-specific fields."
          onClose={() => setSearchModal(null)}
          onSubmit={() => {
            const providers = [...cfg.search.providers];
            if (searchModal.mode === 'add') providers.push(searchModal.draft);
            else if (searchModal.index !== undefined)
              providers[searchModal.index] = searchModal.draft;
            handleCfgChange({ ...cfg, search: { ...cfg.search, providers } });
            setSearchModal(null);
          }}
        >
          {(() => {
            const setSearchDraft = (draft: SearchProvider) =>
              setSearchModal({ ...searchModal, draft });

            return (
              <>
          <SelectRow
            label="Provider"
            help="Choose provider type."
            value={searchModal.draft.provider}
            options={['tavily', 'bing', 'serpapi', 'duckduckgo']}
            onChange={(provider) =>
              setSearchModal({ ...searchModal, draft: defaultSearchProvider(provider) })
            }
          />
          <NumberRow
            label="Max results"
            help="Maximum result items per query."
            value={searchModal.draft.maxResults}
            min={1}
            onChange={(maxResults) =>
              setSearchDraft({ ...searchModal.draft, maxResults })
            }
          />
          {searchModal.draft.provider === 'tavily' && (
            <>
              <TextRow
                label="API key"
                help="Tavily API key."
                value={searchModal.draft.apiKey}
                onChange={(apiKey) =>
                  setSearchDraft({ ...(searchModal.draft as SearchTavily), apiKey })
                }
              />
              <SelectRow
                label="Search depth"
                help="Tavily search depth."
                value={searchModal.draft.searchDepth}
                options={['basic', 'advanced']}
                onChange={(searchDepth) =>
                  setSearchDraft({ ...(searchModal.draft as SearchTavily), searchDepth })
                }
              />
            </>
          )}
          {searchModal.draft.provider === 'bing' && (
            <>
              <TextRow
                label="API key"
                help="Bing Search API key."
                value={searchModal.draft.apiKey}
                onChange={(apiKey) =>
                  setSearchDraft({ ...(searchModal.draft as SearchBing), apiKey })
                }
              />
              <TextRow
                label="Market"
                help="Bing market code, e.g. zh-CN."
                value={searchModal.draft.market}
                onChange={(market) =>
                  setSearchDraft({ ...(searchModal.draft as SearchBing), market })
                }
              />
            </>
          )}
          {searchModal.draft.provider === 'serpapi' && (
            <>
              <TextRow
                label="API key"
                help="SerpApi API key."
                value={searchModal.draft.apiKey}
                onChange={(apiKey) =>
                  setSearchDraft({ ...(searchModal.draft as SearchSerpApi), apiKey })
                }
              />
              <TextRow
                label="Engine"
                help="Search engine name for SerpApi."
                value={searchModal.draft.engine}
                onChange={(engine) =>
                  setSearchDraft({ ...(searchModal.draft as SearchSerpApi), engine })
                }
              />
              <TextRow
                label="hl"
                help="Language hint for SerpApi."
                value={searchModal.draft.hl}
                onChange={(hl) =>
                  setSearchDraft({ ...(searchModal.draft as SearchSerpApi), hl })
                }
              />
              <TextRow
                label="gl"
                help="Geo hint for SerpApi."
                value={searchModal.draft.gl}
                onChange={(gl) =>
                  setSearchDraft({ ...(searchModal.draft as SearchSerpApi), gl })
                }
              />
            </>
          )}
          {searchModal.draft.provider === 'duckduckgo' && (
            <TextRow
              label="Region"
              help="DuckDuckGo region code, e.g. cn-zh."
              value={searchModal.draft.region}
              onChange={(region) =>
                setSearchDraft({ ...(searchModal.draft as SearchDuckDuckGo), region })
              }
            />
          )}
              </>
            );
          })()}
        </FormModal>
      )}

      {cfg && mcpModal && (
        <FormModal
          title={mcpModal.mode === 'add' ? 'Add MCP Server' : 'Edit MCP Server'}
          description="Configure one MCP server. The runtime currently supports stdio execution and keeps SSE declarations for forward compatibility."
          onClose={() => setMcpModal(null)}
          onSubmit={() => {
            const servers = [...cfg.mcp.servers];
            const draft = {
              ...mcpModal.draft,
              id: mcpModal.draft.id.trim(),
              toolPrefix: mcpModal.draft.toolPrefix?.trim() ?? '',
              command: mcpModal.draft.command?.trim() ?? '',
              url: mcpModal.draft.url?.trim() ?? '',
              args: (mcpModal.draft.args ?? []).map((arg) => arg.trim()).filter(Boolean),
              allowTools: (mcpModal.draft.allowTools ?? []).map((name) => name.trim()).filter(Boolean),
              env: Object.fromEntries(
                Object.entries(mcpModal.draft.env ?? {}).filter((entry) => entry[0].trim()),
              ),
            } satisfies McpServerConfig;
            if (!draft.id) {
              return;
            }
            if (mcpModal.mode === 'add') servers.push(draft);
            else if (mcpModal.index !== undefined) servers[mcpModal.index] = draft;
            handleCfgChange({ ...cfg, mcp: { ...cfg.mcp, servers } });
            setMcpModal(null);
          }}
        >
          <TextRow
            label="Server ID"
            help="Stable identifier used in tool prefixing and future health/status surfaces."
            value={mcpModal.draft.id}
            onChange={(id) => setMcpModal({ ...mcpModal, draft: { ...mcpModal.draft, id } })}
          />
          <ToggleRow
            label="Enabled"
            help="Disabled servers stay in config but are not connected during gateway startup."
            checked={mcpModal.draft.enabled}
            onChange={(enabled) =>
              setMcpModal({ ...mcpModal, draft: { ...mcpModal.draft, enabled } })
            }
          />
          <SelectRow
            label="Transport"
            help="stdio is implemented now. SSE can be declared for later compatibility but will not yet connect."
            value={mcpModal.draft.transport}
            options={['stdio', 'sse']}
            onChange={(transport) =>
              setMcpModal({
                ...mcpModal,
                draft: {
                  ...mcpModal.draft,
                  transport,
                  command: transport === 'stdio' ? mcpModal.draft.command ?? '' : '',
                  url: transport === 'sse' ? mcpModal.draft.url ?? '' : '',
                },
              })
            }
          />
          <TextRow
            label="Tool prefix"
            help="Optional tool name prefix. Leave blank to use mcp_serverId."
            value={mcpModal.draft.toolPrefix ?? ''}
            onChange={(toolPrefix) =>
              setMcpModal({ ...mcpModal, draft: { ...mcpModal.draft, toolPrefix } })
            }
          />
          <SelectRow
            label="Approval"
            help="inherit keeps agent-level approval behavior. always/never reserve space for later stricter MCP-specific policy."
            value={mcpModal.draft.approval}
            options={['inherit', 'always', 'never']}
            onChange={(approval) =>
              setMcpModal({ ...mcpModal, draft: { ...mcpModal.draft, approval } })
            }
          />
          <NumberRow
            label="Timeout (ms)"
            help="Upper bound for one MCP request."
            value={mcpModal.draft.timeoutMs}
            min={1000}
            onChange={(timeoutMs) =>
              setMcpModal({ ...mcpModal, draft: { ...mcpModal.draft, timeoutMs } })
            }
          />
          {mcpModal.draft.transport === 'stdio' ? (
            <>
              <TextRow
                label="Command"
                help="Executable used to start the MCP server process."
                value={mcpModal.draft.command ?? ''}
                onChange={(command) =>
                  setMcpModal({ ...mcpModal, draft: { ...mcpModal.draft, command } })
                }
              />
              <DeferredTextRow
                label="Args (CSV)"
                help="Command arguments, comma-separated."
                value={toCsv(mcpModal.draft.args)}
                onChange={(raw) =>
                  setMcpModal({ ...mcpModal, draft: { ...mcpModal.draft, args: asStringArray(raw) } })
                }
              />
            </>
          ) : (
            <TextRow
              label="SSE URL"
              help="Server-sent events endpoint for the MCP server."
              value={mcpModal.draft.url ?? ''}
              onChange={(url) => setMcpModal({ ...mcpModal, draft: { ...mcpModal.draft, url } })}
            />
          )}
          <DeferredTextRow
            label="Allow tools (CSV)"
            help="Optional allowlist of MCP tool names. Leave blank to expose all tools from this server."
            value={toCsv(mcpModal.draft.allowTools)}
            onChange={(raw) =>
              setMcpModal({
                ...mcpModal,
                draft: { ...mcpModal.draft, allowTools: asStringArray(raw) },
              })
            }
          />
          <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4 items-start">
            <FieldLabel
              label="Env"
              help="One KEY=value per line. Only used for stdio transport process launch."
            />
            <textarea
              value={formatEnvLines(mcpModal.draft.env)}
              onChange={(e) =>
                setMcpModal({
                  ...mcpModal,
                  draft: { ...mcpModal.draft, env: parseEnvLines(e.target.value) },
                })
              }
              rows={6}
              spellCheck={false}
              className="w-full font-mono text-sm bg-slate-900/80 ring-1 ring-slate-700 focus:ring-indigo-500/60 focus:outline-none text-slate-200 rounded-xl px-4 py-3 resize-y transition-shadow"
            />
          </div>
        </FormModal>
      )}

      {cfg && mcpInspector && (
        <McpHistoryInspectorModal
          server={cfg.mcp.servers.find((server) => server.id === mcpInspector.serverId)}
          runtimeStatus={mcpStatusData?.servers?.find((server) => server.serverId === mcpInspector.serverId)}
          summary={mcpStatusData?.summaries?.find((summary) => summary.serverId === mcpInspector.serverId)}
          attention={mcpStatusData?.attention?.find((entry) => entry.serverId === mcpInspector.serverId)}
          inspector={mcpInspector}
          onClose={() => setMcpInspector(null)}
          onRefresh={() => openMcpInspector(mcpInspector.serverId)}
        />
      )}

      {cfg && peerModal && (
        <FormModal
          title={peerModal.mode === 'add' ? 'Add Federation Peer' : 'Edit Federation Peer'}
          description="Configure remote peer endpoint and identity."
          onClose={() => setPeerModal(null)}
          onSubmit={() => {
            const peers = [...cfg.federation.peers];
            if (peerModal.mode === 'add') peers.push(peerModal.draft);
            else if (peerModal.index !== undefined) peers[peerModal.index] = peerModal.draft;
            handleCfgChange({ ...cfg, federation: { ...cfg.federation, peers } });
            setPeerModal(null);
          }}
        >
          <TextRow
            label="Node ID"
            help="Remote peer node identifier."
            value={peerModal.draft.nodeId}
            onChange={(nodeId) =>
              setPeerModal({ ...peerModal, draft: { ...peerModal.draft, nodeId } })
            }
          />
          <TextRow
            label="Host"
            help="Peer host or IP address."
            value={peerModal.draft.host}
            onChange={(host) => setPeerModal({ ...peerModal, draft: { ...peerModal.draft, host } })}
          />
          <NumberRow
            label="Port"
            help="Peer gateway port."
            value={peerModal.draft.port}
            min={1}
            max={65535}
            onChange={(port) => setPeerModal({ ...peerModal, draft: { ...peerModal.draft, port } })}
          />
          <TextRow
            label="Public key (hex)"
            help="Ed25519 public key in hex for signature verification."
            value={peerModal.draft.publicKeyHex}
            onChange={(publicKeyHex) =>
              setPeerModal({ ...peerModal, draft: { ...peerModal.draft, publicKeyHex } })
            }
          />
        </FormModal>
      )}
    </div>
  );
}
