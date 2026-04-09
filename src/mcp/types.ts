import type { ToolApprovalMode, ToolCallResult, ToolDefinition } from '../core/types.js';

export type McpServerTransport = 'stdio' | 'sse';
export type McpApprovalMode = ToolApprovalMode;
export type McpHistoryTrigger = 'startup' | 'reload' | 'manual-refresh' | 'auto-retry';
export type McpHistoryOutcome = 'connected' | 'error' | 'disabled';
export interface McpAutoReconnectPolicy {
  enabled: boolean;
  pollIntervalMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}
export type McpRuntimeErrorPhase =
  | 'transport'
  | 'config'
  | 'connect'
  | 'endpoint'
  | 'initialize'
  | 'request'
  | 'stream';
export type McpRuntimeErrorCode =
  | 'UNKNOWN_TRANSPORT'
  | 'STDIO_COMMAND_MISSING'
  | 'STDIO_FRAME_INVALID'
  | 'STDIO_PROCESS_EXIT'
  | 'STDIO_REQUEST_TIMEOUT'
  | 'SSE_URL_MISSING'
  | 'SSE_CONNECT_HTTP'
  | 'SSE_CONNECT_NO_BODY'
  | 'SSE_ENDPOINT_INVALID'
  | 'SSE_REQUEST_HTTP'
  | 'SSE_REQUEST_TIMEOUT'
  | 'SSE_NOTIFY_HTTP'
  | 'SSE_STREAM_CLOSED';

export interface McpServerConfigLike {
  id: string;
  transport: McpServerTransport;
  enabled?: boolean;
  toolPrefix?: string;
  approval?: McpApprovalMode;
  timeoutMs?: number;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  allowTools?: string[];
}

export interface McpToolManifest {
  name: string;
  description: string;
  inputSchema: ToolDefinition['inputSchema'];
}

export interface McpToolCallOutput extends ToolCallResult {}

export interface McpClient {
  listTools(): Promise<McpToolManifest[]>;
  callTool(name: string, input: unknown): Promise<McpToolCallOutput>;
  getConnectionDetails?(): string | undefined;
  close(): Promise<void>;
}

export interface McpToolBinding {
  serverId: string;
  originalName: string;
  prefixedName: string;
  description: string;
  inputSchema: ToolDefinition['inputSchema'];
  approval: McpApprovalMode;
}

export interface McpServerRuntimeStatus {
  serverId: string;
  transport: McpServerTransport;
  enabled: boolean;
  toolPrefix: string;
  approval: McpApprovalMode;
  timeoutMs: number;
  status: 'connected' | 'error' | 'disabled';
  connectionDetails?: string;
  toolCount: number;
  tools: string[];
  lastError?: string;
  lastErrorCode?: McpRuntimeErrorCode;
  lastErrorPhase?: McpRuntimeErrorPhase;
  autoRetryEligible?: boolean;
  retryCount?: number;
  nextRetryAt?: number;
  lastConnectedAt?: number;
  lastRefreshAt?: number;
}

export interface McpServerHistoryRecord {
  serverId: string;
  transport: McpServerTransport;
  trigger: McpHistoryTrigger;
  outcome: McpHistoryOutcome;
  timestamp: number;
  toolPrefix: string;
  approval: McpApprovalMode;
  timeoutMs: number;
  toolCount: number;
  connectionDetails?: string;
  lastError?: string;
  lastErrorCode?: McpRuntimeErrorCode;
  lastErrorPhase?: McpRuntimeErrorPhase;
  autoRetryEligible?: boolean;
  retryCount?: number;
  nextRetryAt?: number;
}

export interface McpServerHistorySummary {
  serverId: string;
  transport: McpServerTransport;
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
  lastOutcome?: McpHistoryOutcome;
  lastTrigger?: McpHistoryTrigger;
  lastEventAt?: number;
  lastRecoveryAt?: number;
  lastFailureAt?: number;
  lastErrorCode?: McpRuntimeErrorCode;
}

export interface McpServerOperatorAttention {
  serverId: string;
  severity: 'warning' | 'critical';
  state: 'manual-fix' | 'recovering';
  message: string;
  lastErrorCode?: McpRuntimeErrorCode;
  retryCount?: number;
  nextRetryAt?: number;
}

export type McpHistoryRecorder =
  | ((record: McpServerHistoryRecord) => void | Promise<void>)
  | undefined;

export interface AdaptedTool {
  definition: ToolDefinition;
  invoke(input: unknown): Promise<ToolCallResult>;
  approvalMode: McpApprovalMode;
  metadata: {
    category: 'mcp';
    serverId: string;
    originalName: string;
  };
}
