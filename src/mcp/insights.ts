import type {
  McpServerHistorySummary,
  McpServerOperatorAttention,
  McpServerRuntimeStatus,
} from './types.js';

function summarizeFailureCount(summary?: McpServerHistorySummary, fallback?: number): number {
  return summary?.consecutiveErrors ?? fallback ?? 1;
}

export function buildMcpServerOperatorAttention(
  statuses: McpServerRuntimeStatus[],
  summaries: McpServerHistorySummary[],
): McpServerOperatorAttention[] {
  const summaryByServerId = new Map(summaries.map((summary) => [summary.serverId, summary]));
  const attention: McpServerOperatorAttention[] = [];

  for (const status of statuses) {
    if (status.status !== 'error') {
      continue;
    }

    const summary = summaryByServerId.get(status.serverId);
    const recentFailureCount = summarizeFailureCount(summary, status.retryCount);

    if (status.autoRetryEligible === false) {
      attention.push({
        serverId: status.serverId,
        severity: 'critical',
        state: 'manual-fix',
        message: `MCP server '${status.serverId}' needs manual intervention after ${recentFailureCount} recent failure${recentFailureCount === 1 ? '' : 's'}.`,
        lastErrorCode: status.lastErrorCode,
        retryCount: status.retryCount,
        nextRetryAt: status.nextRetryAt,
      });
      continue;
    }

    attention.push({
      serverId: status.serverId,
      severity: 'warning',
      state: 'recovering',
      message: `MCP server '${status.serverId}' is still auto-retrying after ${recentFailureCount} recent failure${recentFailureCount === 1 ? '' : 's'}.`,
      lastErrorCode: status.lastErrorCode,
      retryCount: status.retryCount,
      nextRetryAt: status.nextRetryAt,
    });
  }

  return attention.sort((left, right) => {
    const severityDelta =
      Number(right.severity === 'critical') - Number(left.severity === 'critical');
    if (severityDelta !== 0) {
      return severityDelta;
    }
    return left.serverId.localeCompare(right.serverId);
  });
}

export function formatMcpAttentionSummary(
  attention: McpServerOperatorAttention[],
  maxItems = 2,
): string | null {
  if (attention.length === 0) {
    return null;
  }

  const visible = attention.slice(0, Math.max(1, maxItems));
  const segments = visible.map((item) => {
    if (item.state === 'manual-fix') {
      return item.lastErrorCode
        ? `${item.serverId} needs manual fix (${item.lastErrorCode})`
        : `${item.serverId} needs manual fix`;
    }

    return item.lastErrorCode
      ? `${item.serverId} is auto-retrying (${item.lastErrorCode})`
      : `${item.serverId} is auto-retrying`;
  });

  const overflow = attention.length - visible.length;
  if (overflow > 0) {
    segments.push(`+${overflow} more server${overflow === 1 ? '' : 's'}`);
  }

  return `MCP runtime is degraded: ${segments.join('; ')}. Automation that depends on MCP tools may stall or fail until recovery.`;
}
