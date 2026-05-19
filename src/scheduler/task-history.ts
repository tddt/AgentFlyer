import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ScheduledAgentRunStatus = 'done' | 'error' | 'suspended';

export type ScheduledAgentActiveRunStatus = 'running' | 'suspended';

interface ScheduledTaskHistoryState {
  loadPromise: Promise<void> | null;
  history: ScheduledTaskRunRecord[];
  summaryByTaskId: Map<string, ScheduledTaskExecutionSummaryData>;
}

const sharedScheduledTaskHistoryStates = new Map<string, ScheduledTaskHistoryState>();

export interface ScheduledTaskRunRecord {
  taskId: string;
  taskName: string;
  runKey: string;
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  result: string;
  agentId?: string;
  agentRunId?: string;
  agentRunStatus?: ScheduledAgentRunStatus;
  workflowId?: string;
  workflowRunId?: string;
  deliverableId?: string;
}

export interface ScheduledTaskExecutionSummaryData {
  lastRunAt: number;
  lastResult: string;
  lastAgentRunId?: string;
  lastAgentRunStatus?: ScheduledAgentRunStatus;
  latestDeliverableId?: string;
}

const HISTORY_MAX_PER_TASK = 50;
const HISTORY_MAX_TOTAL = 1000;

function historyFilePath(dataDir: string): string {
  return join(dataDir, 'task-run-history.json');
}

function getScheduledTaskHistoryState(dataDir: string): ScheduledTaskHistoryState {
  const existing = sharedScheduledTaskHistoryStates.get(dataDir);
  if (existing) {
    return existing;
  }
  const created: ScheduledTaskHistoryState = {
    loadPromise: null,
    history: [],
    summaryByTaskId: new Map(),
  };
  sharedScheduledTaskHistoryStates.set(dataDir, created);
  return created;
}

async function ensureScheduledTaskHistoryState(
  dataDir: string,
): Promise<ScheduledTaskHistoryState> {
  const state = getScheduledTaskHistoryState(dataDir);
  if (!state.loadPromise) {
    state.loadPromise = (async () => {
      const file = historyFilePath(dataDir);
      if (!existsSync(file)) {
        state.history = [];
        state.summaryByTaskId = new Map();
        return;
      }
      try {
        state.history = JSON.parse(await readFile(file, 'utf-8')) as ScheduledTaskRunRecord[];
      } catch {
        state.history = [];
      }
      state.summaryByTaskId = buildScheduledTaskExecutionSummaryById(state.history);
    })();
  }
  await state.loadPromise;
  return state;
}

export async function readScheduledTaskHistory(dataDir: string): Promise<ScheduledTaskRunRecord[]> {
  const state = await ensureScheduledTaskHistoryState(dataDir);
  return state.history.map((entry) => ({ ...entry }));
}

export async function appendScheduledTaskHistoryRecord(
  dataDir: string,
  record: ScheduledTaskRunRecord,
): Promise<void> {
  const state = await ensureScheduledTaskHistoryState(dataDir);
  let history = [{ ...record }, ...state.history];
  const countByTask = new Map<string, number>();
  history = history.filter((entry) => {
    const nextCount = (countByTask.get(entry.taskId) ?? 0) + 1;
    countByTask.set(entry.taskId, nextCount);
    return nextCount <= HISTORY_MAX_PER_TASK;
  });
  if (history.length > HISTORY_MAX_TOTAL) {
    history = history.slice(0, HISTORY_MAX_TOTAL);
  }
  state.history = history;
  state.summaryByTaskId = buildScheduledTaskExecutionSummaryById(history);
  await writeFile(historyFilePath(dataDir), JSON.stringify(history, null, 2), 'utf-8');
}

export async function getScheduledTaskExecutionSummaryById(
  dataDir: string,
): Promise<Map<string, ScheduledTaskExecutionSummaryData>> {
  const state = await ensureScheduledTaskHistoryState(dataDir);
  return new Map(state.summaryByTaskId);
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
      lastAgentRunId: record.agentRunId,
      lastAgentRunStatus: record.agentRunStatus,
      latestDeliverableId: record.deliverableId,
    });
  }
  return summaryByTaskId;
}
