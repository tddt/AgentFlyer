import type { ProcessId } from '../types.js';

export type ProcessPriority = 'critical' | 'high' | 'normal' | 'low';

export type ProcessStatus = 'ready' | 'running' | 'waiting' | 'suspended' | 'done' | 'error';

export type ProcessSignalCode =
  | 'YIELD'
  | 'WAITING_SYSCALL'
  | 'SUSPENDED'
  | 'DONE'
  | 'ERROR'
  | 'RETRYABLE_ERROR';

export type SyscallKind =
  | 'tool.call'
  | 'llm.generate'
  | 'vfs.read'
  | 'vfs.write'
  | 'ipc.send'
  | 'custom';

export interface ProcessErrorEvent {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface SyscallRequest {
  id: string;
  kind: SyscallKind;
  operation: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface SyscallResolution {
  requestId: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: ProcessErrorEvent;
  resolvedAt: number;
}

export interface KernelProcessSnapshot<TSerializedState = unknown> {
  pid: ProcessId;
  processType: string;
  version: number;
  status: ProcessStatus;
  priority: ProcessPriority;
  state: TSerializedState;
  createdAt: number;
  updatedAt: number;
  runCount: number;
  retryCount: number;
  nextRunAt?: number;
  lastSignal?: ProcessSignalCode;
  lastError?: ProcessErrorEvent;
  pendingSyscall?: SyscallRequest;
  lastSyscallResult?: SyscallResolution;
  metadata: Record<string, string>;
}

export interface ProcessStepContext {
  pid: ProcessId;
  now: number;
  runCount: number;
  retryCount: number;
  pendingSyscall?: SyscallRequest;
  lastSyscallResult?: SyscallResolution;
  metadata: Readonly<Record<string, string>>;
}

export interface ProcessStepResult<TState> {
  signal: ProcessSignalCode;
  state: TState;
  nextRunAt?: number;
  delayMs?: number;
  syscall?: SyscallRequest;
  error?: ProcessErrorEvent;
  metadata?: Record<string, string>;
}

export interface ProcessRuntime<TState, TInput = unknown> {
  readonly type: string;
  readonly version: number;
  createInitialState(input: TInput): TState;
  step(state: TState, context: ProcessStepContext): Promise<ProcessStepResult<TState>>;
  serialize(state: TState): unknown;
  deserialize(payload: unknown): TState;
}

export interface CreateProcessOptions<TInput = unknown> {
  processType: string;
  input: TInput;
  priority?: ProcessPriority;
  metadata?: Record<string, string>;
  processId?: ProcessId;
  createdAt?: number;
}

export interface KernelTickResult {
  kind: 'idle' | 'executed';
  pid?: ProcessId;
  signal?: ProcessSignalCode;
  status?: ProcessStatus;
}

export interface CheckpointStore {
  save(snapshot: KernelProcessSnapshot): Promise<void>;
  load(pid: ProcessId): Promise<KernelProcessSnapshot | null>;
  list(): Promise<KernelProcessSnapshot[]>;
  delete(pid: ProcessId): Promise<void>;
}
