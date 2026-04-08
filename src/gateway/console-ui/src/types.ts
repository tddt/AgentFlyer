declare global {
  interface Window {
    __AF_TOKEN__: string;
    __AF_PORT__: number;
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AgentInfo {
  agentId: string;
  name?: string;
  mentionAliases?: string[];
  sandboxProfile?: string;
}

export interface AgentConfig {
  id: string;
  name?: string;
  mentionAliases?: string[];
  model?: string;
  workspace?: string;
  mesh?: Record<string, unknown>;
  tools?: {
    allow?: string[];
    deny?: string[];
    approval?: string[];
    maxRounds?: number;
  };
  persona?: {
    language?: string;
    outputDir?: string;
  };
}

export interface GatewayStatus {
  version: string;
  uptime: number;
  agents: number;
}

export interface AgentListResult {
  agents: AgentInfo[];
}

export interface ChannelInfo {
  id: string;
  name: string;
  supportsAttachment: boolean;
}

export interface ChannelListResult {
  channels: ChannelInfo[];
}

export interface PublicationTargetConfig {
  channelId: string;
  threadKey: string;
  agentId?: string;
}

export interface SchedulerTargetAdvisory {
  kind: 'sandbox-advisory';
  message: string;
  recommendedAgentId?: string;
  recommendedSandboxProfile?: string;
}

export interface TaskInfo {
  id: string;
  name: string;
  /** Agent to invoke. Empty/absent when workflowId is used. */
  agentId?: string;
  /** Workflow to invoke. Takes precedence over agentId when present. */
  workflowId?: string;
  message: string;
  cronExpr: string;
  reportTo?: string;
  outputChannel?: 'logs' | 'cli' | 'web';
  publicationTargets?: PublicationTargetConfig[];
  publicationChannels?: string[];
  enabled?: boolean;
  createdAt?: number;
  runCount: number;
  lastRunAt?: number;
  nextRunAt?: number;
  lastResult?: string;
  latestDeliverableId?: string;
  advisory?: SchedulerTargetAdvisory;
}

export interface SchedulerListResult {
  tasks: TaskInfo[];
}

export interface RunningTaskInfo {
  taskId: string;
  taskName: string;
  startedAt: number;
  agentId?: string;
  workflowId?: string;
}

export interface TaskRunRecord {
  taskId: string;
  taskName: string;
  runKey: string;
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  result: string;
  agentId?: string;
  workflowId?: string;
  workflowRunId?: string;
  deliverableId?: string;
}

export interface TaskHistoryResult {
  records: TaskRunRecord[];
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  shortDesc: string;
  tags: string[];
  apiKeyRequired: boolean;
  source?: 'builtin' | 'user-global' | 'workspace' | 'extra';
}

export interface SkillListResult {
  skills: SkillInfo[];
}

export interface LogEntry {
  ts: number;
  level: LogLevel;
  name?: string;
  msg: string;
  [k: string]: unknown;
}

export type ChatChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_delta'; id: string; name: string; inputJson: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean }
  | {
      type: 'done';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
    }
  | { type: 'error'; message: string };

export interface SessionMetaInfo {
  sessionKey: string;
  agentId: string;
  threadKey: string;
  status: string;
  messageCount: number;
  lastActivity: number;
  createdAt: number;
  contextTokensEstimate: number;
  compactionCount: number;
  error?: string;
  errorCode?: string;
}

export interface SessionListResult {
  sessions: SessionMetaInfo[];
}

export interface ErrorStatsBreakdownEntry {
  code: string;
  count: number;
  lastSeenAt: number;
}

export interface ErrorStatsTrendPoint {
  date: string;
  count: number;
}

export interface ErrorStatsByAgentEntry {
  agentId: string;
  totalErrorSessions: number;
  recentErrorSessions: number;
  latestErrorAt: number;
  topErrorCode: string;
  trend: ErrorStatsTrendPoint[];
}

export interface ErrorStatsSummary {
  totalErrorSessions: number;
  recentErrorSessions: number;
  latestErrorAt: number | null;
  breakdown: ErrorStatsBreakdownEntry[];
  trend: ErrorStatsTrendPoint[];
  byAgent: ErrorStatsByAgentEntry[];
  windowDays: number;
}

export interface StatsResultRow {
  date: string;
  agentId: string;
  model: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface StatsResult {
  rows: StatsResultRow[];
  errors: ErrorStatsSummary;
}

export interface SessionClearResult {
  cleared: boolean;
  agentId?: string;
  sessionKey?: string;
  failedOnly?: boolean;
  errorCode?: string;
  clearedSessions?: number;
  remainingMatchingFailedSessions?: number;
  remainingFailedSessionsForAgent?: number;
}

export type ChatRecoveryMode = 'continue' | 'new_thread';

export interface ChatRecoveryContext {
  eventId: number;
  agentId: string;
  threadKey: string;
  errorCode: string;
  mode: ChatRecoveryMode;
}

export type InboxEventKind = 'agent_reply' | 'deliverable';

export interface InboxEvent {
  id: number;
  ts: number;
  kind: InboxEventKind;
  agentId?: string;
  threadKey?: string;
  channelId?: string;
  title: string;
  text: string;
  deliverableId?: string;
  publicationSummary?: string;
}

export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tools?: Array<{ name: string; input: string }>;
  toolResults?: Array<{ content: string; isError?: boolean }>;
  timestamp: number;
  isToolResult: boolean;
}

export interface SessionMessagesResult {
  sessionKey: string;
  messages: DisplayMessage[];
}

// ── Workflow types ────────────────────────────────────────────────────────────

/** Supported node types in a workflow step. */
export type StepType = 'agent' | 'transform' | 'condition' | 'http';

/** A named variable extracted from a step's output. */
export interface StepOutputVar {
  name: string;
  jsonPath?: string;
  regex?: string;
  /** JS expression body: receives (output, vars, globals) and must return string. */
  transform?: string;
}

/** One branch in a 'condition' step. */
export interface ConditionBranch {
  /** JS expression evaluated with `output`, `vars`, `globals` in scope. */
  expression: string;
  /** Target step id or '$end' to terminate the workflow. */
  goto: string;
}

export interface WorkflowStep {
  id: string;
  /** Node type — defaults to 'agent' for backward compatibility. */
  type?: StepType;
  /** Explicit next step id or '$end'; falls back to array order when omitted. */
  nextStepId?: string;
  /** Required for 'agent' steps. */
  agentId?: string;
  label?: string;
  /**
   * Template / body string.
   * Placeholders: {{input}}, {{prev_output}}, {{step_N_output}},
   *               {{vars.<stepId>.<name>}}, {{globals.<key>}}
   */
  messageTemplate: string;
  /** 'any' = run always; 'on_success' = halt pipeline on error */
  condition: 'any' | 'on_success';
  /** Max automatic retries on error (default 0). */
  maxRetries?: number;
  /** Named variables extracted from this step's output. */
  outputs?: StepOutputVar[];
  /** Branches for 'condition' steps (evaluated top-to-bottom). */
  branches?: ConditionBranch[];
  // ── 'http' step ──────────────────────────────────────────────────────────
  url?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  bodyTemplate?: string;
  // ── 'transform' step ─────────────────────────────────────────────────────
  /** JS expression body: receives (vars, globals, input, prev_output), must return string. */
  transformCode?: string;
  // ── output format constraint (agent steps) ───────────────────────────────
  /** Preset format or 'custom' for a user-defined instruction appended to the message. */
  outputFormat?: 'text' | 'json' | 'markdown' | 'custom';
  /** Appended verbatim to the agent message when outputFormat === 'custom'. */
  outputFormatPrompt?: string;
  /**
   * How the format instruction is applied to the agent message.
   * 'append' (default): instruction added at the end of message.
   * 'prepend': instruction placed before the message (higher priority).
   */
  outputFormatMode?: 'append' | 'prepend';
}

export interface WorkflowDef {
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  publicationTargets?: PublicationTargetConfig[];
  publicationChannels?: string[];
  /** Global constants available as {{globals.<key>}} in any template. */
  variables?: Record<string, string>;
  /** ID of the first step to execute (defaults to steps[0].id). */
  entryStepId?: string;
  /** When explicitly false, the run panel skips the input form and allows direct execution. */
  inputRequired?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowGraphCycleDiagnostic {
  kind: 'cycle';
  entryStepId: string;
  stepId: string;
  path: string[];
}

export interface WorkflowGraphUnreachableDiagnostic {
  kind: 'unreachable';
  entryStepId: string;
  stepIds: string[];
}

export interface WorkflowStepValidationDiagnostic {
  kind: 'step-validation';
  stepId: string;
  message: string;
}

export interface WorkflowStepAdvisoryDiagnostic {
  kind: 'step-advisory';
  stepId: string;
  message: string;
}

export interface WorkflowWorkflowValidationDiagnostic {
  kind: 'workflow-validation';
  message: string;
}

export interface WorkflowWorkflowAdvisoryDiagnostic {
  kind: 'workflow-advisory';
  message: string;
}

export type WorkflowGraphDiagnostic =
  | WorkflowGraphCycleDiagnostic
  | WorkflowGraphUnreachableDiagnostic;

export type WorkflowValidationDiagnostic =
  | WorkflowStepValidationDiagnostic
  | WorkflowStepAdvisoryDiagnostic
  | WorkflowWorkflowValidationDiagnostic
  | WorkflowWorkflowAdvisoryDiagnostic;

export interface WorkflowDiagnoseResult {
  valid: boolean;
  validationError: string | null;
  validationDiagnostics: WorkflowValidationDiagnostic[];
  graphDiagnostics: WorkflowGraphDiagnostic[];
}

export interface WorkflowStepResult {
  stepId: string;
  /** Streaming-in-progress or final output text. */
  output?: string;
  error?: string;
  /** Flat snapshot of ALL named variables accumulated up to this step: "stepId.varName" → value */
  varsSnapshot?: Record<string, string>;
}

/** Run record — mirrors WorkflowRunRecord on the backend. */
export interface WorkflowRunRecord {
  runId: string;
  workflowId: string;
  workflowName: string;
  input: string;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'done' | 'error' | 'cancelled';
  stepResults: WorkflowStepResult[];
  latestDeliverableId?: string;
}

export type DeliverableStatus = 'ready' | 'error' | 'cancelled';
export type DeliverableFormat =
  | 'text'
  | 'markdown'
  | 'json'
  | 'csv'
  | 'image'
  | 'video'
  | 'audio'
  | 'file';

export type ArtifactRole = 'primary' | 'step-output' | 'step-error' | 'file';

export type DeliverablePublicationTargetKind = 'system' | 'agent' | 'channel';
export type DeliverablePublicationMode = 'summary' | 'artifact';
export type DeliverablePublicationStatus = 'planned' | 'available' | 'sent' | 'failed';

export interface DeliverablePublicationTarget {
  id: string;
  kind: DeliverablePublicationTargetKind;
  targetId: string;
  label: string;
  mode: DeliverablePublicationMode;
  status: DeliverablePublicationStatus;
  threadKey?: string;
  agentId?: string;
  detail?: string;
  lastAttemptAt?: number;
}

export interface ArtifactRef {
  id: string;
  name: string;
  role: ArtifactRole;
  format: DeliverableFormat;
  mimeType?: string;
  filePath?: string;
  contentItemId?: string;
  textContent?: string;
  size?: number;
  stepId?: string;
  stepLabel?: string;
  stepIndex?: number;
  createdAt: number;
}

export type DeliverableSource =
  | {
      kind: 'workflow_run';
      workflowId: string;
      workflowName: string;
      runId: string;
    }
  | {
      kind: 'scheduler_task_run';
      taskId: string;
      taskName: string;
      runKey: string;
      startedAt: number;
      finishedAt: number;
      workflowId?: string;
      workflowRunId?: string;
      agentId?: string;
    }
  | {
      kind: 'chat_turn';
      agentId: string;
      threadKey: string;
      channelId: string;
      startedAt: number;
      finishedAt: number;
    };

export interface DeliverableStats {
  total: number;
  ready: number;
  error: number;
  cancelled: number;
  workflowRuns: number;
  schedulerRuns: number;
  chatTurns: number;
  totalArtifacts: number;
  textualArtifacts: number;
  fileArtifacts: number;
  recent24h: number;
}

export interface DeliverableRecord {
  id: string;
  title: string;
  summary: string;
  previewText: string;
  status: DeliverableStatus;
  source: DeliverableSource;
  artifacts: ArtifactRef[];
  publications?: DeliverablePublicationTarget[];
  primaryArtifactId?: string;
  metadata?: Record<string, string | number | boolean | null>;
  createdAt: number;
  updatedAt: number;
}

export interface DeliverableListResult {
  items: DeliverableRecord[];
  stats: DeliverableStats;
}

// ── Enriched agent config ─────────────────────────────────────────────────────

export interface AgentGroup {
  id: string;
  label: string;
  agentIds: string[];
}

// ── Content catalog ──────────────────────────────────────────────────────────
export type ContentItemType = 'image' | 'video' | 'audio' | 'file';

export interface ContentItem {
  id: string;
  agentId: string;
  name: string;
  filePath: string;
  mimeType: string;
  type: ContentItemType;
  size: number;
  createdAt: number;
}

// ── Memory tab types ──────────────────────────────────────────────────────────
export interface MemoryEntry {
  id: string;
  content: string;
  partition?: string;
  importance?: number;
  superseded?: boolean;
  createdAt: number;
  accessedAt?: number;
  score?: number;
}
export interface MemorySearchResult {
  results: MemoryEntry[];
}

// ── Federation tab types ──────────────────────────────────────────────────────
export interface FederationPeer {
  nodeId: string;
  host: string;
  port: number;
  status: string;
  latencyMs?: number;
  lastSeen?: number;
}
export interface FederationStatusResult {
  enabled: boolean;
  peers: FederationPeer[];
}

// ── Docs tab types ────────────────────────────────────────────────────────────
export interface DocListResult {
  docs: string[];
}
export interface DocContent {
  name: string;
  content: string;
}
