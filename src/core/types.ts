// Core types — no internal imports allowed in this file

// ─── Branded primitive types ────────────────────────────────────────────────
export type AgentId = string & { readonly _brand: 'AgentId' };
export type ThreadKey = string & { readonly _brand: 'ThreadKey' };
export type SessionKey = string & { readonly _brand: 'SessionKey' };
export type NodeId = string & { readonly _brand: 'NodeId' };
export type SkillId = string & { readonly _brand: 'SkillId' };
export type MemoryEntryId = string & { readonly _brand: 'MemoryEntryId' };
export type TaskId = string & { readonly _brand: 'TaskId' };
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
export function makeSessionKey(agentId: AgentId, threadKey: ThreadKey): SessionKey {
  return `agent:${agentId}:${threadKey}` as SessionKey;
}

export function parseSessionKey(
  key: SessionKey,
): { agentId: AgentId; threadKey: ThreadKey } | null {
  const match = /^agent:([^:]+):(.+)$/.exec(key);
  if (!match || !match[1] || !match[2]) return null;
  return {
    agentId: match[1] as AgentId,
    threadKey: match[2] as ThreadKey,
  };
}

export function asAgentId(s: string): AgentId {
  return s as AgentId;
}

export function asThreadKey(s: string): ThreadKey {
  return s as ThreadKey;
}

export function asSessionKey(s: string): SessionKey {
  return s as SessionKey;
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

export interface ToolCallResult {
  isError: boolean;
  content: string;
}
