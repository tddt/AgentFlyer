import type { SessionErrorCode, SessionMeta } from './meta.js';
import { normalizeSessionErrorCode } from './recovery.js';

export interface SessionErrorBreakdownEntry {
  code: SessionErrorCode;
  count: number;
  lastSeenAt: number;
}

export interface SessionErrorTrendPoint {
  date: string;
  count: number;
}

export interface SessionErrorByAgentEntry {
  agentId: string;
  totalErrorSessions: number;
  recentErrorSessions: number;
  latestErrorAt: number;
  topErrorCode: SessionErrorCode;
  trend: SessionErrorTrendPoint[];
}

export interface SessionErrorStats {
  totalErrorSessions: number;
  recentErrorSessions: number;
  latestErrorAt: number | null;
  breakdown: SessionErrorBreakdownEntry[];
  trend: SessionErrorTrendPoint[];
  byAgent: SessionErrorByAgentEntry[];
  windowDays: number;
}

function toDateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function createWindowTrendMap(windowDays: number, now: number): Map<string, number> {
  const trendMap = new Map<string, number>();
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const date = new Date(now - offset * 86_400_000).toISOString().slice(0, 10);
    trendMap.set(date, 0);
  }
  return trendMap;
}

function normalizeErrorCode(session: SessionMeta): SessionErrorCode | null {
  return normalizeSessionErrorCode(session) ?? null;
}

export function summarizeSessionErrors(
  sessions: SessionMeta[],
  windowDays = 7,
  now = Date.now(),
): SessionErrorStats {
  const safeWindowDays = Math.max(1, Math.floor(windowDays));
  const windowStart = now - (safeWindowDays - 1) * 86_400_000;
  const breakdownMap = new Map<SessionErrorCode, SessionErrorBreakdownEntry>();
  const trendMap = createWindowTrendMap(safeWindowDays, now);
  const byAgentMap = new Map<
    string,
    {
      totalErrorSessions: number;
      recentErrorSessions: number;
      latestErrorAt: number;
      codeCounts: Map<SessionErrorCode, number>;
      trendMap: Map<string, number>;
    }
  >();

  let totalErrorSessions = 0;
  let recentErrorSessions = 0;
  let latestErrorAt: number | null = null;

  for (const session of sessions) {
    const code = normalizeErrorCode(session);
    if (!code) continue;

    totalErrorSessions += 1;
    if (latestErrorAt === null || session.lastActivity > latestErrorAt) {
      latestErrorAt = session.lastActivity;
    }

    const existing = breakdownMap.get(code);
    if (existing) {
      existing.count += 1;
      existing.lastSeenAt = Math.max(existing.lastSeenAt, session.lastActivity);
    } else {
      breakdownMap.set(code, {
        code,
        count: 1,
        lastSeenAt: session.lastActivity,
      });
    }

    const byAgent = byAgentMap.get(session.agentId);
    if (byAgent) {
      byAgent.totalErrorSessions += 1;
      byAgent.latestErrorAt = Math.max(byAgent.latestErrorAt, session.lastActivity);
      byAgent.codeCounts.set(code, (byAgent.codeCounts.get(code) ?? 0) + 1);
    } else {
      byAgentMap.set(session.agentId, {
        totalErrorSessions: 1,
        recentErrorSessions: 0,
        latestErrorAt: session.lastActivity,
        codeCounts: new Map([[code, 1]]),
        trendMap: createWindowTrendMap(safeWindowDays, now),
      });
    }

    if (session.lastActivity >= windowStart) {
      recentErrorSessions += 1;
      const dateKey = toDateKey(session.lastActivity);
      trendMap.set(dateKey, (trendMap.get(dateKey) ?? 0) + 1);
      const byAgentRecent = byAgentMap.get(session.agentId);
      if (byAgentRecent) {
        byAgentRecent.recentErrorSessions += 1;
        byAgentRecent.trendMap.set(dateKey, (byAgentRecent.trendMap.get(dateKey) ?? 0) + 1);
      }
    }
  }

  const byAgent = Array.from(byAgentMap.entries())
    .map(([agentId, value]) => {
      const topErrorCode =
        Array.from(value.codeCounts.entries()).sort((a, b) => {
          if (b[1] !== a[1]) return b[1] - a[1];
          return a[0].localeCompare(b[0]);
        })[0]?.[0] ?? 'generic';
      return {
        agentId,
        totalErrorSessions: value.totalErrorSessions,
        recentErrorSessions: value.recentErrorSessions,
        latestErrorAt: value.latestErrorAt,
        topErrorCode,
        trend: Array.from(value.trendMap.entries()).map(([date, count]) => ({ date, count })),
      };
    })
    .sort((a, b) => {
      if (b.recentErrorSessions !== a.recentErrorSessions) {
        return b.recentErrorSessions - a.recentErrorSessions;
      }
      if (b.totalErrorSessions !== a.totalErrorSessions) {
        return b.totalErrorSessions - a.totalErrorSessions;
      }
      return b.latestErrorAt - a.latestErrorAt;
    });

  return {
    totalErrorSessions,
    recentErrorSessions,
    latestErrorAt,
    breakdown: Array.from(breakdownMap.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.lastSeenAt - a.lastSeenAt;
    }),
    trend: Array.from(trendMap.entries()).map(([date, count]) => ({ date, count })),
    byAgent,
    windowDays: safeWindowDays,
  };
}
