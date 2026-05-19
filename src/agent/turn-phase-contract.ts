import type { ProcessStatus } from '../core/kernel/types.js';
import type { RunnerLeaseSyncMode } from './runner.js';

export type AgentTurnPhase =
  | 'pending'
  | 'running'
  | 'waiting_llm'
  | 'waiting_approval'
  | 'waiting_tool'
  | 'suspended'
  | 'done'
  | 'error';

export type AgentTurnControlState = 'queued' | 'ready' | 'active' | 'suspended' | 'done' | 'error';

export interface AgentTurnPhaseContract {
  controlState: AgentTurnControlState;
  leaseMode: RunnerLeaseSyncMode;
}

const AGENT_TURN_PHASE_CONTRACTS: Record<AgentTurnPhase, AgentTurnPhaseContract> = {
  pending: {
    controlState: 'queued',
    leaseMode: 'idle',
  },
  running: {
    controlState: 'active',
    leaseMode: 'kernel',
  },
  waiting_llm: {
    controlState: 'active',
    leaseMode: 'kernel',
  },
  waiting_approval: {
    controlState: 'active',
    leaseMode: 'kernel',
  },
  waiting_tool: {
    controlState: 'active',
    leaseMode: 'kernel',
  },
  suspended: {
    controlState: 'suspended',
    leaseMode: 'kernel',
  },
  done: {
    controlState: 'done',
    leaseMode: 'idle',
  },
  error: {
    controlState: 'error',
    leaseMode: 'idle',
  },
};

export function getAgentTurnPhaseContract(phase: AgentTurnPhase): AgentTurnPhaseContract {
  return AGENT_TURN_PHASE_CONTRACTS[phase];
}

export function deriveAgentTurnControlStateForPhase(phase: AgentTurnPhase): AgentTurnControlState {
  return getAgentTurnPhaseContract(phase).controlState;
}

export function deriveRunnerLeaseModeForAgentTurnPhase(phase: AgentTurnPhase): RunnerLeaseSyncMode {
  return getAgentTurnPhaseContract(phase).leaseMode;
}

export function fallbackAgentTurnPhaseForProcessStatus(status: ProcessStatus): AgentTurnPhase {
  switch (status) {
    case 'ready':
      return 'pending';
    case 'running':
    case 'waiting':
      return 'running';
    case 'suspended':
      return 'suspended';
    case 'done':
      return 'done';
    case 'error':
      return 'error';
  }
}
