// Core types — no internal imports allowed in this file

// ─── Branded primitive types ────────────────────────────────────────────────
export type AgentId = string & { readonly _brand: 'AgentId' };
export type ThreadKey = string & { readonly _brand: 'ThreadKey' };
export type SessionKey = string & { readonly _brand: 'SessionKey' };
export type NodeId = string & { readonly _brand: 'NodeId' };
export type SkillId = string & { readonly _brand: 'SkillId' };
export type MemoryEntryId = string & { readonly _brand: 'MemoryEntryId' };
export type TaskId = string & { readonly _brand: 'TaskId' };
export type ProcessId = string & { readonly _brand: 'ProcessId' };
export type ReceiptId = string & { readonly _brand: 'ReceiptId' };

// ─── Enums ───────────────────────────────────────────────────────────────────
export type BindMode = 'loopback' | 'local' | 'tailscale';
export type ComputeClass = 'fast' | 'standard' | 'premium';
export type AgentStatus = 'idle' | 'running' | 'paused' | 'error';
export type MeshRole = 'coordinator' | 'worker' | 'specialist' | 'observer';
export type MessageRole = 'user' | 'assistant' | 'system';

// ─── Node identity ────────────────────────────────────────────────────────────
export interface NodeIdentity {
  nodeId: NodeId;
  publicKeyHex: string;
  host?: string;
  port?: number;
  capabilities?: string[];
}

// ─── Session key helpers ──────────────────────────────────────────────────────
const SESSION_KEY_PATTERN = /^agent:([^:]+):(.+)$/;

function ensureNonBlankString(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${label} cannot be empty`);
  }
  return value;
}

function parseSessionKeyParts(key: string): { agentId: string; threadKey: string } | null {
  const match = SESSION_KEY_PATTERN.exec(key);
  if (!match || !match[1] || !match[2]) {
    return null;
  }
  if (match[1].trim().length === 0 || match[2].trim().length === 0) {
    return null;
  }
  return {
    agentId: match[1],
    threadKey: match[2],
  };
}

export function makeSessionKey(agentId: AgentId, threadKey: ThreadKey): SessionKey {
  const safeAgentId = ensureNonBlankString(agentId, 'AgentId');
  const safeThreadKey = ensureNonBlankString(threadKey, 'ThreadKey');
  return `agent:${safeAgentId}:${safeThreadKey}` as SessionKey;
}

export function parseSessionKey(
  key: SessionKey,
): { agentId: AgentId; threadKey: ThreadKey } | null {
  const parsed = parseSessionKeyParts(key);
  if (!parsed) return null;
  return {
    agentId: parsed.agentId as AgentId,
    threadKey: parsed.threadKey as ThreadKey,
  };
}

export function asAgentId(s: string): AgentId {
  return ensureNonBlankString(s, 'AgentId') as AgentId;
}

export function asThreadKey(s: string): ThreadKey {
  return ensureNonBlankString(s, 'ThreadKey') as ThreadKey;
}

export function asSessionKey(s: string): SessionKey {
  if (!parseSessionKeyParts(s)) {
    throw new Error('SessionKey must match agent:<agentId>:<threadKey>');
  }
  return s as SessionKey;
}

export function asNodeId(s: string): NodeId {
  return ensureNonBlankString(s, 'NodeId') as NodeId;
}

export function asSkillId(s: string): SkillId {
  return ensureNonBlankString(s, 'SkillId') as SkillId;
}

export function asMemoryEntryId(s: string): MemoryEntryId {
  return ensureNonBlankString(s, 'MemoryEntryId') as MemoryEntryId;
}

export function asTaskId(s: string): TaskId {
  return ensureNonBlankString(s, 'TaskId') as TaskId;
}

export function asProcessId(s: string): ProcessId {
  return ensureNonBlankString(s, 'ProcessId') as ProcessId;
}

export function asReceiptId(s: string): ReceiptId {
  return ensureNonBlankString(s, 'ReceiptId') as ReceiptId;
}

// ─── Message content types ───────────────────────────────────────────────────
export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string | TextContent[];
  is_error?: boolean;
}

export type MessageContent = TextContent | ToolUseContent | ToolResultContent;

export interface Message {
  role: MessageRole;
  content: string | MessageContent[];
  timestamp?: number;
}

// ─── LLM stream chunks ───────────────────────────────────────────────────────
export interface TextDelta {
  type: 'text_delta';
  text: string;
}

export interface ToolUseDelta {
  type: 'tool_use_delta';
  id: string;
  name: string;
  inputJson: string;
}

export interface StreamDone {
  type: 'done';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
}

export interface StreamError {
  type: 'error';
  message: string;
}

export type StreamChunk = TextDelta | ToolUseDelta | StreamDone | StreamError;

// ─── Tool types ───────────────────────────────────────────────────────────────
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ToolApprovalMode = 'inherit' | 'always' | 'never';

export interface ToolCallResult {
  isError: boolean;
  content: string;
}

// ─── Standardised error codes ─────────────────────────────────────────────────
export type ErrorCode =
  // core
  | 'CORE_INVALID_ARG'
  | 'CORE_IO_ERROR'
  | 'CORE_NOT_FOUND'
  // agent
  | 'AGENT_RUN_FAILED'
  | 'AGENT_TOOL_DENIED'
  | 'AGENT_TOOL_TIMEOUT'
  | 'AGENT_LLM_ERROR'
  // gateway
  | 'GATEWAY_AUTH_FAILED'
  | 'GATEWAY_RATE_LIMITED'
  | 'GATEWAY_RPC_UNKNOWN'
  // mcp
  | 'MCP_CONNECT_FAILED'
  | 'MCP_TOOL_CALL_ERROR'
  // mesh
  | 'MESH_DELEGATE_FAILED'
  // federation
  | 'FED_PEER_UNREACHABLE';

export interface AppError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

// ─── Result<T, E> ─────────────────────────────────────────────────────────────
// Use this pattern instead of bare throws at agent/runner and gateway/rpc boundaries.
export type Result<T, E = AppError> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E = AppError>(error: E): Result<never, E> {
  return { ok: false, error };
}
