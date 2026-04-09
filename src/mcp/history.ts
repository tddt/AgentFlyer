import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServerHistoryRecord, McpServerHistorySummary } from './types.js';

const HISTORY_MAX_PER_SERVER = 100;
const HISTORY_MAX_TOTAL = 2_000;
const RECENT_HISTORY_WINDOW = 10;

function getMcpHistoryFile(dataDir: string): string {
  return join(dataDir, 'mcp-server-history.json');
}

export async function readMcpServerHistory(dataDir: string): Promise<McpServerHistoryRecord[]> {
  const file = getMcpHistoryFile(dataDir);
  if (!existsSync(file)) {
    return [];
  }

  try {
    return JSON.parse(await readFile(file, 'utf-8')) as McpServerHistoryRecord[];
  } catch {
    return [];
  }
}

export async function appendMcpServerHistoryRecord(
  dataDir: string,
  record: McpServerHistoryRecord,
): Promise<void> {
  let history = await readMcpServerHistory(dataDir);
  history.unshift(record);

  const countByServer = new Map<string, number>();
  history = history.filter((entry) => {
    const nextCount = (countByServer.get(entry.serverId) ?? 0) + 1;
    countByServer.set(entry.serverId, nextCount);
    return nextCount <= HISTORY_MAX_PER_SERVER;
  });

  if (history.length > HISTORY_MAX_TOTAL) {
    history = history.slice(0, HISTORY_MAX_TOTAL);
  }

  await writeFile(getMcpHistoryFile(dataDir), JSON.stringify(history, null, 2), 'utf-8');
}

export function summarizeMcpServerHistory(
  records: McpServerHistoryRecord[],
  recentWindow = RECENT_HISTORY_WINDOW,
): McpServerHistorySummary[] {
  const grouped = new Map<string, McpServerHistoryRecord[]>();
  for (const record of records) {
    const bucket = grouped.get(record.serverId);
    if (bucket) {
      bucket.push(record);
      continue;
    }
    grouped.set(record.serverId, [record]);
  }

  const summaries: McpServerHistorySummary[] = [];
  for (const serverRecords of grouped.values()) {
    const latest = serverRecords[0];
    if (!latest) {
      continue;
    }

    const recentRecords = serverRecords.slice(0, Math.max(1, recentWindow));
    let connectedEvents = 0;
    let errorEvents = 0;
    let disabledEvents = 0;
    let recentConnectedEvents = 0;
    let autoRetryRecoveryCount = 0;
    let manualFixErrorCount = 0;
    let consecutiveErrors = 0;
    let lastRecoveryAt: number | undefined;
    let lastFailureAt: number | undefined;

    for (const [index, record] of serverRecords.entries()) {
      if (record.outcome === 'connected') {
        connectedEvents += 1;
        autoRetryRecoveryCount += Number(record.trigger === 'auto-retry');
        lastRecoveryAt ??= record.timestamp;
      } else if (record.outcome === 'error') {
        errorEvents += 1;
        manualFixErrorCount += Number(record.autoRetryEligible === false);
        lastFailureAt ??= record.timestamp;
      } else {
        disabledEvents += 1;
      }

      if (index < recentRecords.length && record.outcome === 'connected') {
        recentConnectedEvents += 1;
      }
      if (index === consecutiveErrors && record.outcome === 'error') {
        consecutiveErrors += 1;
      }
    }

    summaries.push({
      serverId: latest.serverId,
      transport: latest.transport,
      totalEvents: serverRecords.length,
      connectedEvents,
      errorEvents,
      disabledEvents,
      recentAttempts: recentRecords.length,
      recentConnectedEvents,
      recentSuccessRate:
        recentRecords.length > 0 ? recentConnectedEvents / recentRecords.length : 0,
      consecutiveErrors,
      autoRetryRecoveryCount,
      manualFixErrorCount,
      lastOutcome: latest.outcome,
      lastTrigger: latest.trigger,
      lastEventAt: latest.timestamp,
      lastRecoveryAt,
      lastFailureAt,
      lastErrorCode: latest.lastErrorCode,
    });
  }

  return summaries.sort((left, right) => {
    const timeDelta = (right.lastEventAt ?? 0) - (left.lastEventAt ?? 0);
    if (timeDelta !== 0) {
      return timeDelta;
    }
    return left.serverId.localeCompare(right.serverId);
  });
}
