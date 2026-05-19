import type {
  KernelProcessSnapshot,
  ProcessErrorEvent,
  ProcessStatus,
} from '../core/kernel/types.js';
import type { AgentTurnProcessState } from './process-runtime.js';
import type { TurnResult } from './runner.js';
import {
  type AgentTurnControlState,
  type AgentTurnPhase,
  fallbackAgentTurnPhaseForProcessStatus,
} from './turn-phase-contract.js';
export {
  deriveAgentTurnControlStateForPhase,
  type AgentTurnControlState,
} from './turn-phase-contract.js';

export interface AgentTurnRunRecordLike {
  processStatus: ProcessStatus;
  phase: AgentTurnPhase;
  controlState?: AgentTurnControlState;
  result?: TurnResult;
  error?: ProcessErrorEvent;
}

export interface AgentTurnDerivedRunRecord extends AgentTurnRunRecordLike {
  runId: string;
  agentId: string;
  threadKey: string;
  createdAt: number;
  updatedAt: number;
  controlState: AgentTurnControlState;
  sessionKey?: string;
}

export interface AgentTurnLifecycleState {
  processStatus: ProcessStatus;
  phase: AgentTurnProcessState['phase'];
  controlState: AgentTurnControlState;
}

type AgentTurnRunStateLike = Pick<
  AgentTurnProcessState,
  'agentId' | 'threadKey' | 'phase' | 'controlState' | 'result' | 'error'
>;

export type AgentTurnCompletionOutcome =
  | { ok: true; result: TurnResult }
  | { ok: false; message: string };

export function deriveAgentTurnControlState(
  record: Pick<AgentTurnRunRecordLike, 'processStatus' | 'phase' | 'controlState'>,
): AgentTurnControlState {
  if (record.processStatus === 'error') {
    return 'error';
  }
  if (record.processStatus === 'done') {
    return 'done';
  }
  if (record.processStatus === 'ready') {
    return 'ready';
  }
  if (record.processStatus === 'suspended') {
    return 'suspended';
  }
  if (record.processStatus === 'waiting' && record.phase === 'pending') {
    return 'queued';
  }
  if (record.phase === 'error') {
    return 'error';
  }
  if (record.phase === 'done') {
    return 'done';
  }
  if (record.phase === 'suspended') {
    return 'suspended';
  }
  if (record.controlState) {
    return record.controlState;
  }
  return 'active';
}

export function deriveAgentTurnLifecycleState(
  record: Pick<AgentTurnRunRecordLike, 'processStatus' | 'phase' | 'controlState'>,
): AgentTurnLifecycleState {
  return {
    processStatus: record.processStatus,
    phase: record.phase,
    controlState: deriveAgentTurnControlState(record),
  };
}

export function deriveAgentTurnRunRecord(
  snapshot: Pick<
    KernelProcessSnapshot,
    'pid' | 'status' | 'createdAt' | 'updatedAt' | 'lastError' | 'metadata'
  >,
  state: AgentTurnRunStateLike | null,
): AgentTurnDerivedRunRecord {
  const lifecycle = deriveAgentTurnLifecycleState({
    processStatus: snapshot.status,
    phase: state?.phase ?? fallbackAgentTurnPhaseForProcessStatus(snapshot.status),
    controlState: state?.controlState,
  });
  return {
    runId: String(snapshot.pid),
    agentId: state?.agentId ?? snapshot.metadata.agentId ?? '',
    threadKey: state?.threadKey ?? '',
    processStatus: lifecycle.processStatus,
    phase: lifecycle.phase,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    controlState: lifecycle.controlState,
    result: state?.result,
    sessionKey: state?.result?.sessionKey,
    error: state?.error ?? snapshot.lastError,
  };
}

export function isSuspendedAgentTurnRun(
  record: Pick<AgentTurnRunRecordLike, 'processStatus' | 'phase' | 'controlState'>,
): boolean {
  return deriveAgentTurnControlState(record) === 'suspended';
}

export function isTerminalAgentTurnRun(
  record: Pick<AgentTurnRunRecordLike, 'processStatus' | 'phase' | 'controlState'>,
): boolean {
  const controlState = deriveAgentTurnControlState(record);
  return controlState === 'done' || controlState === 'error';
}

export function shouldRetainAgentTurnRunRecord(
  record: Pick<AgentTurnRunRecordLike, 'processStatus' | 'phase' | 'controlState'>,
): boolean {
  const controlState = deriveAgentTurnControlState(record);
  return controlState === 'done' || controlState === 'error' || controlState === 'suspended';
}

export function getAgentTurnCompletionOutcome(
  record: AgentTurnRunRecordLike,
): AgentTurnCompletionOutcome | null {
  const lifecycle = deriveAgentTurnLifecycleState(record);
  if (lifecycle.controlState === 'done' && record.result) {
    return { ok: true, result: record.result };
  }
  if (lifecycle.controlState === 'error' || lifecycle.controlState === 'suspended') {
    return {
      ok: false,
      message: record.error?.message ?? 'Agent turn failed',
    };
  }
  return null;
}
