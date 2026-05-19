import type { RunningTaskInfo } from './types.js';

export function buildSchedulerRunningTaskSignature(tasks: RunningTaskInfo[]): string {
  return [...tasks]
    .sort((left, right) => left.taskId.localeCompare(right.taskId))
    .map((task) => {
      return [
        task.taskId,
        String(task.startedAt),
        task.agentRunId ?? '',
        task.status,
        task.resumable ? '1' : '0',
      ].join(':');
    })
    .join('|');
}

export function shouldRefreshSchedulerHistory(
  taskId: string | undefined,
  previousTasks: RunningTaskInfo[],
  nextTasks: RunningTaskInfo[],
): boolean {
  if (!taskId) {
    return false;
  }
  return previousTasks.some((task) => task.taskId === taskId) || nextTasks.some((task) => task.taskId === taskId);
}