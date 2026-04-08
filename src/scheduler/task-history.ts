import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ScheduledTaskRunRecord {
  taskId: string;
  taskName: string;
  runKey: string;
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  result: string;
  agentId?: string;
  workflowId?: string;
  workflowRunId?: string;
  deliverableId?: string;
}

export interface ScheduledTaskExecutionSummaryData {
  lastRunAt: number;
  lastResult: string;
  latestDeliverableId?: string;
}

const HISTORY_MAX_PER_TASK = 50;
const HISTORY_MAX_TOTAL = 1000;

export async function readScheduledTaskHistory(dataDir: string): Promise<ScheduledTaskRunRecord[]> {
  const file = join(dataDir, 'task-run-history.json');
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as ScheduledTaskRunRecord[];
  } catch {
    return [];
  }
}

export async function appendScheduledTaskHistoryRecord(
  dataDir: string,
  record: ScheduledTaskRunRecord,
): Promise<void> {
  let history = await readScheduledTaskHistory(dataDir);
  history.unshift(record);
  const countByTask = new Map<string, number>();
  history = history.filter((entry) => {
    const nextCount = (countByTask.get(entry.taskId) ?? 0) + 1;
    countByTask.set(entry.taskId, nextCount);
    return nextCount <= HISTORY_MAX_PER_TASK;
  });
  if (history.length > HISTORY_MAX_TOTAL) {
    history = history.slice(0, HISTORY_MAX_TOTAL);
  }
  await writeFile(
    join(dataDir, 'task-run-history.json'),
    JSON.stringify(history, null, 2),
    'utf-8',
  );
}

export function buildScheduledTaskExecutionSummaryById(
  history: ScheduledTaskRunRecord[],
): Map<string, ScheduledTaskExecutionSummaryData> {
  const summaryByTaskId = new Map<string, ScheduledTaskExecutionSummaryData>();
  for (const record of history) {
    if (summaryByTaskId.has(record.taskId)) {
      continue;
    }
    summaryByTaskId.set(record.taskId, {
      lastRunAt: record.finishedAt,
      lastResult: record.result.slice(0, 500),
      latestDeliverableId: record.deliverableId,
    });
  }
  return summaryByTaskId;
}
