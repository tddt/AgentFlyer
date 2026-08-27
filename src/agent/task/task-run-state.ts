export type TaskPhase = 'planning' | 'executing' | 'verifying';

export type TaskRunStatus =
  | 'queued'
  | 'running'
  | 'suspended'
  | 'needs_input'
  | 'completed'
  | 'failed';

export type TaskContinuationAction =
  | 'complete'
  | 'continue'
  | 'retry'
  | 'suspend'
  | 'needs_input'
  | 'fail';

export interface TaskAcceptanceCriterion {
  description: string;
  completed: boolean;
}

export type TaskEvidenceKind = 'command' | 'test' | 'diff' | 'note';

export interface TaskEvidence {
  kind: TaskEvidenceKind;
  description: string;
  value: string;
  recordedAt: number;
}

export interface TaskRunState {
  taskId: string;
  goal: string;
  plan: string[];
  phase: TaskPhase;
  status: TaskRunStatus;
  acceptanceCriteria: TaskAcceptanceCriterion[];
  completedItems: string[];
  evidence: TaskEvidence[];
  retryCount: number;
  blockedReason?: string;
  currentRunId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateTaskRunInput {
  taskId: string;
  goal: string;
  plan?: string[];
  acceptanceCriteria: string[];
  currentRunId?: string;
}

export interface TaskContinuationInput {
  turnStatus: 'done' | 'error' | 'suspended';
  acceptanceCriteriaSatisfied: boolean;
  hasProgress: boolean;
  retryCount: number;
  maxRetries: number;
}

export interface TaskContinuationDecision {
  action: TaskContinuationAction;
  reason: string;
}

export type TaskTransition =
  | { action: 'start'; runId?: string }
  | { action: 'continue'; phase?: TaskPhase }
  | { action: 'complete' }
  | { action: 'retry'; reason: string }
  | { action: 'suspend'; reason: string }
  | { action: 'needs_input'; reason: string }
  | { action: 'fail'; reason: string };

function ensureNonBlank(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${label} cannot be empty`);
  }
  return value;
}

export function createTaskRunState(input: CreateTaskRunInput, now: number): TaskRunState {
  ensureNonBlank(input.taskId, 'Task ID');
  ensureNonBlank(input.goal, 'Task goal');
  if (input.acceptanceCriteria.length === 0) {
    throw new Error('Task acceptance criteria cannot be empty');
  }

  return {
    taskId: input.taskId,
    goal: input.goal,
    plan: [...(input.plan ?? [])],
    phase: 'planning',
    status: 'queued',
    acceptanceCriteria: input.acceptanceCriteria.map((description) => ({
      description: ensureNonBlank(description, 'Acceptance criterion'),
      completed: false,
    })),
    completedItems: [],
    evidence: [],
    retryCount: 0,
    currentRunId: input.currentRunId,
    createdAt: now,
    updatedAt: now,
  };
}

export function decideTaskContinuation(input: TaskContinuationInput): TaskContinuationDecision {
  if (input.turnStatus === 'suspended') {
    return { action: 'suspend', reason: 'The turn is suspended' };
  }
  if (input.turnStatus === 'error') {
    if (input.retryCount < input.maxRetries) {
      return { action: 'retry', reason: 'The turn failed and retries remain' };
    }
    return { action: 'fail', reason: 'The turn failed and retry budget is exhausted' };
  }
  if (input.acceptanceCriteriaSatisfied) {
    return { action: 'complete', reason: 'Acceptance criteria are satisfied' };
  }
  if (input.hasProgress) {
    return { action: 'continue', reason: 'Acceptance criteria are not satisfied' };
  }
  if (input.retryCount < input.maxRetries) {
    return { action: 'retry', reason: 'The turn stopped without measurable progress' };
  }
  return { action: 'fail', reason: 'No progress was made and retry budget is exhausted' };
}

export function recordTaskEvidence(state: TaskRunState, evidence: TaskEvidence): TaskRunState {
  ensureNonBlank(evidence.description, 'Evidence description');
  return {
    ...state,
    evidence: [...state.evidence, { ...evidence }],
    updatedAt: evidence.recordedAt,
  };
}

export function transitionTaskRun(
  state: TaskRunState,
  transition: TaskTransition,
  now: number,
): TaskRunState {
  switch (transition.action) {
    case 'start':
      return {
        ...state,
        phase: state.phase === 'planning' ? 'executing' : state.phase,
        status: 'running',
        currentRunId: transition.runId ?? state.currentRunId,
        blockedReason: undefined,
        updatedAt: now,
      };
    case 'continue':
      return {
        ...state,
        phase: transition.phase ?? state.phase,
        status: 'running',
        blockedReason: undefined,
        updatedAt: now,
      };
    case 'complete':
      return {
        ...state,
        status: 'completed',
        phase: 'verifying',
        blockedReason: undefined,
        updatedAt: now,
      };
    case 'retry':
      return {
        ...state,
        status: 'running',
        retryCount: state.retryCount + 1,
        blockedReason: transition.reason,
        updatedAt: now,
      };
    case 'suspend':
      return { ...state, status: 'suspended', blockedReason: transition.reason, updatedAt: now };
    case 'needs_input':
      return { ...state, status: 'needs_input', blockedReason: transition.reason, updatedAt: now };
    case 'fail':
      return { ...state, status: 'failed', blockedReason: transition.reason, updatedAt: now };
  }
}
