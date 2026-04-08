export interface ScheduledTaskRecord {
  id: string;
  name: string;
  agentId?: string;
  workflowId?: string;
  message: string;
  cronExpr: string;
  reportTo?: string;
  outputChannel?: 'logs' | 'cli' | 'web';
  publicationTargets?: Array<{
    channelId: string;
    threadKey: string;
    agentId?: string;
  }>;
  publicationChannels?: string[];
  enabled?: boolean;
  createdAt: number;
  runCount: number;
}

export interface ScheduledTaskExecutionSummary {
  lastRunAt?: number;
  lastResult?: string;
  latestDeliverableId?: string;
}

export type ScheduledTaskView = ScheduledTaskRecord & ScheduledTaskExecutionSummary;

export function stripTaskExecutionSummary(
  task: ScheduledTaskRecord | ScheduledTaskView,
): ScheduledTaskRecord {
  const normalized = task as ScheduledTaskRecord & Partial<ScheduledTaskExecutionSummary>;
  const {
    lastRunAt: _lastRunAt,
    lastResult: _lastResult,
    latestDeliverableId: _latestDeliverableId,
    ...rest
  } = normalized;
  return rest;
}
