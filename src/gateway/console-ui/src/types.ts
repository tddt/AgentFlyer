export {}

declare global {
  interface Window {
    __AF_TOKEN__: string
    __AF_PORT__: number
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface AgentInfo {
  agentId: string
  name?: string
}

export interface AgentConfig {
  id: string
  name?: string
  model?: string
  workspace?: string
  mesh?: Record<string, unknown>
  persona?: string
}

export interface GatewayStatus {
  version: string
  uptime: number
  agents: number
}

export interface AgentListResult {
  agents: AgentInfo[]
}

export interface TaskInfo {
  id: string
  name: string
  /** Agent to invoke. Empty/absent when workflowId is used. */
  agentId?: string;
  /** Workflow to invoke. Takes precedence over agentId when present. */
  workflowId?: string;
  message: string
  cronExpr: string
  reportTo?: string
  outputChannel?: 'logs' | 'cli' | 'web'
  enabled?: boolean
  createdAt?: number
  runCount: number
  lastRunAt?: number
  nextRunAt?: number
  lastResult?: string
}

export interface SchedulerListResult {
  tasks: TaskInfo[]
}

export interface RunningTaskInfo {
  taskId: string
  taskName: string
  startedAt: number
  agentId?: string
  workflowId?: string
}

export interface TaskRunRecord {
  taskId: string
  taskName: string
  startedAt: number
  finishedAt: number
  ok: boolean
  result: string
  agentId?: string
  workflowId?: string
}

export interface TaskHistoryResult {
  records: TaskRunRecord[]
}

export interface SkillInfo {
  id: string
  name: string
  description: string
  shortDesc: string
  tags: string[]
  apiKeyRequired: boolean
}

export interface SkillListResult {
  skills: SkillInfo[]
}

export interface LogEntry {
  ts: number
  level: LogLevel
  name?: string
  msg: string
  [k: string]: unknown
}

export type ChatChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_delta'; id: string; name: string; inputJson: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean }
  | {
      type: 'done'
      inputTokens: number
      outputTokens: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
      stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
    }
  | { type: 'error'; message: string }

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
}

export interface SessionListResult {
  sessions: SessionMetaInfo[];
}

export interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tools?: Array<{ name: string; input: string }>;
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
  /** Global constants available as {{globals.<key>}} in any template. */
  variables?: Record<string, string>;
  /** ID of the first step to execute (defaults to steps[0].id). */
  entryStepId?: string;
  /** When explicitly false, the run panel skips the input form and allows direct execution. */
  inputRequired?: boolean;
  createdAt: number;
  updatedAt: number;
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
export interface MemorySearchResult { results: MemoryEntry[] }

// ── Federation tab types ──────────────────────────────────────────────────────
export interface FederationPeer {
  nodeId: string;
  host: string;
  port: number;
  status: string;
  latencyMs?: number;
  lastSeen?: number;
}
export interface FederationStatusResult { enabled: boolean; peers: FederationPeer[] }

// ── Docs tab types ────────────────────────────────────────────────────────────
export interface DocListResult { docs: string[] }
export interface DocContent { name: string; content: string }
