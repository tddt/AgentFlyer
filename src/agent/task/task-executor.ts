import {
  decideTaskContinuation,
  recordTaskEvidence,
  transitionTaskRun,
  type TaskContinuationDecision,
  type TaskEvidence,
  type TaskRunState,
} from './task-run-state.js';

export interface TaskTurnOutcome {
  status: 'done' | 'error' | 'suspended';
  hasProgress: boolean;
  acceptanceCriteriaSatisfied: boolean;
  evidence?: TaskEvidence[];
}

export interface TaskExecutorDependencies {
  runTurn(state: TaskRunState): Promise<TaskTurnOutcome>;
  save(state: TaskRunState): Promise<void>;
  maxRetries?: number;
}

export interface TaskExecutionResult {
  state: TaskRunState;
  decision: TaskContinuationDecision;
}

export class TaskExecutor {
  constructor(private readonly dependencies: TaskExecutorDependencies) {}

  async runUntilTerminal(
    state: TaskRunState,
    now: number,
    maxSteps = 32,
  ): Promise<TaskExecutionResult> {
    let current = state;
    for (let step = 0; step < maxSteps; step += 1) {
      const result = await this.run(current, now);
      if (result.decision.action !== 'continue' && result.decision.action !== 'retry') {
        return result;
      }
      current = result.state;
    }
    const exhausted = transitionTaskRun(
      current,
      { action: 'fail', reason: `Task step budget exhausted after ${maxSteps} turns` },
      now,
    );
    await this.dependencies.save(exhausted);
    return {
      state: exhausted,
      decision: {
        action: 'fail',
        reason: `Task step budget exhausted after ${maxSteps} turns`,
      },
    };
  }

  async run(state: TaskRunState, now: number): Promise<TaskExecutionResult> {
    let nextState = transitionTaskRun(state, { action: 'start' }, now);
    await this.dependencies.save(nextState);

    const outcome = await this.dependencies.runTurn(nextState);
    for (const evidence of outcome.evidence ?? []) {
      nextState = recordTaskEvidence(nextState, evidence);
    }

    const decision = decideTaskContinuation({
      turnStatus: outcome.status,
      acceptanceCriteriaSatisfied: outcome.acceptanceCriteriaSatisfied,
      hasProgress: outcome.hasProgress,
      retryCount: nextState.retryCount,
      maxRetries: this.dependencies.maxRetries ?? 2,
    });
    nextState = transitionTaskRun(
      nextState,
      decision.action === 'complete'
        ? { action: 'complete' }
        : decision.action === 'continue'
          ? { action: 'continue', phase: 'verifying' }
          : decision.action === 'retry'
            ? { action: 'retry', reason: decision.reason }
            : decision.action === 'suspend'
              ? { action: 'suspend', reason: decision.reason }
              : { action: 'fail', reason: decision.reason },
      now,
    );
    await this.dependencies.save(nextState);
    return { state: nextState, decision };
  }
}