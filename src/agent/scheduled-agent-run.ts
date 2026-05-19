import { type AgentTurnRunRecordLike, isSuspendedAgentTurnRun } from './turn-run-state.js';

export type DelegatedAgentRunStatus = 'done' | 'error' | 'suspended';

export interface DelegatedAgentRunOutcome {
  text: string;
  runId: string;
  runStatus: DelegatedAgentRunStatus;
}

interface DelegatedAgentRunSuccessLike {
  text?: string | null;
}

type DelegatedAgentRunRecordLike = Pick<
  AgentTurnRunRecordLike,
  'processStatus' | 'phase' | 'controlState' | 'error'
>;

export interface ExecuteDelegatedAgentRunOptions<
  TResult extends DelegatedAgentRunSuccessLike = DelegatedAgentRunSuccessLike,
> {
  resolveRunId: () => Promise<string>;
  waitForResult: (runId: string) => Promise<TResult>;
  readRun: (
    runId: string,
  ) => Promise<DelegatedAgentRunRecordLike | null> | DelegatedAgentRunRecordLike | null;
  beforeWait?: (runId: string) => Promise<void>;
  onRunState?: (patch: { agentRunId: string }) => void;
}

function errorText(error: unknown): string {
  return String(error);
}

export async function executeDelegatedAgentRun<
  TResult extends DelegatedAgentRunSuccessLike = DelegatedAgentRunSuccessLike,
>(options: ExecuteDelegatedAgentRunOptions<TResult>): Promise<DelegatedAgentRunOutcome> {
  const runId = await options.resolveRunId();
  await options.beforeWait?.(runId);
  options.onRunState?.({ agentRunId: runId });
  try {
    const result = await options.waitForResult(runId);
    return {
      text: result.text || '(no output)',
      runId,
      runStatus: 'done',
    };
  } catch (error) {
    const current = await options.readRun(runId);
    if (current && isSuspendedAgentTurnRun(current)) {
      return {
        text: current.error?.message ?? errorText(error),
        runId,
        runStatus: 'suspended',
      };
    }
    return {
      text: `Error: ${errorText(error)}`,
      runId,
      runStatus: 'error',
    };
  }
}
