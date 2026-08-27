import type { ProcessStatus } from '../core/kernel/types.js';
import type { AgentTurnProcessState } from './process-runtime.js';
import type { TurnResult } from './runner.js';
import type { TaskRunState } from './task/task-run-state.js';
import type { AgentTurnControlState } from './turn-run-state.js';

export interface AgentRunRecord {
  runId: string;
  agentId: string;
  threadKey: string;
  processStatus: ProcessStatus;
  phase: AgentTurnProcessState['phase'];
  controlState?: AgentTurnControlState;
  createdAt: number;
  updatedAt: number;
  result?: TurnResult;
  sessionKey?: string;
  taskState?: TaskRunState;
  error?: AgentTurnProcessState['error'];
}

export interface AgentCancelRunResult {
  cancelled: boolean;
  runId: string;
  mode: 'queued' | 'ready' | 'active' | 'noop';
  run?: AgentRunRecord | null;
  reason?: string;
}
