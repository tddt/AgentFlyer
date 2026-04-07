import { useCallback, useEffect, useState } from 'react';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { StatCard } from '../components/StatCard.js';
import { useLocale } from '../context/i18n.js';
import { rpc, useQuery } from '../hooks/useRpc.js';
import { useToast } from '../hooks/useToast.js';
import { useUptime } from '../hooks/useUptime.js';
import { formatProblemCode, isSuspendedProblemCode, problemCodeBadgeVariant } from '../problem-code-display.js';
import { getRecoveryHint } from '../recovery-hints.js';
import type {
  AgentInfo,
  AgentListResult,
  ErrorStatsSummary,
  GatewayStatus,
  SessionClearResult,
  SessionListResult,
  SessionMetaInfo,
  StatsResult,
} from '../types.js';

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatTrendLabel(date: string): string {
  return date.slice(5).replace('-', '/');
}

function problemPanelTone(errorCode: string): string {
  return isSuspendedProblemCode(errorCode)
    ? 'hover:ring-amber-500/30'
    : 'hover:ring-red-500/30';
}

function AgentTrendMini({
  trend,
  summary,
  windowDays,
  accent,
}: {
  trend: Array<{ date: string; count: number }>;
  summary: string;
  windowDays: number;
  accent: 'amber' | 'red';
}) {
  if (trend.length === 0) return null;

  const peakCount = Math.max(...trend.map((point) => point.count), 0);

  return (
    <div className="mt-2.5 rounded-md bg-black/20 ring-1 ring-white/[0.04] px-2.5 py-2">
      <div className="flex items-end gap-1 h-8">
        {trend.map((point) => (
          <div key={point.date} className="flex-1 h-full flex items-end" title={`${point.date}: ${point.count}`}>
            <div
              className={
                accent === 'amber'
                  ? 'w-full rounded-sm bg-gradient-to-t from-amber-500/70 to-yellow-200/80'
                  : 'w-full rounded-sm bg-gradient-to-t from-red-500/70 to-orange-300/75'
              }
              style={{ height: `${Math.max(8, peakCount > 0 ? (point.count / peakCount) * 100 : 8)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-slate-500">
        <span>{formatTrendLabel(trend[0]?.date ?? '')}</span>
        <span className="text-slate-400">{summary.replace('{n}', String(windowDays))}</span>
        <span>{formatTrendLabel(trend.at(-1)?.date ?? '')}</span>
      </div>
    </div>
  );
}

function AgentRecoveryHintMini({
  errorCode,
  t,
}: {
  errorCode: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const hint = getRecoveryHint(errorCode, (key) => t(key));

  return (
    <div className="mt-2 rounded-md bg-amber-950/15 ring-1 ring-amber-500/10 px-2.5 py-2 text-[10px] text-amber-100/80">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex rounded-full bg-amber-400/10 px-2 py-0.5 font-medium uppercase tracking-wide text-amber-300/90">
          {hint.actionLabel}
        </span>
        <span className="font-medium text-amber-200">{hint.title}</span>
      </div>
      <div className="mt-1 leading-5 text-amber-100/70">{hint.description}</div>
    </div>
  );
}

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function statusBadgeVariant(status: string): 'yellow' | 'red' {
  return status === 'suspended' ? 'yellow' : 'red';
}

function buildOverviewClearResultMessage(
  t: (key: string, vars?: Record<string, string | number>) => string,
  result: SessionClearResult,
  agentId: string,
  errorCode: string,
): string {
  const clearedCount = result.clearedSessions ?? 0;
  const remainingForAgent = result.remainingFailedSessionsForAgent ?? 0;

  if (remainingForAgent > 0) {
    return t('overview.clearTopErrorResultRemaining')
      .replace('{count}', String(clearedCount))
      .replace('{errorCode}', formatProblemCode(errorCode, t))
      .replace('{agentId}', agentId)
      .replace('{remaining}', String(remainingForAgent));
  }

  return t('overview.clearTopErrorResultClean')
    .replace('{count}', String(clearedCount))
    .replace('{errorCode}', formatProblemCode(errorCode, t))
    .replace('{agentId}', agentId);
}

function PingWidget() {
  const { t } = useLocale();
  const [latency, setLatency] = useState<number | null>(null);
  const [status, setStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');

  const ping = useCallback(async () => {
    setStatus('checking');
    const start = performance.now();
    try {
      await rpc('gateway.ping', {});
      setLatency(Math.round(performance.now() - start));
      setStatus('ok');
    } catch {
      setStatus('error');
      setLatency(null);
    }
  }, []);

  useEffect(() => {
    void ping();
  }, [ping]);

  return (
    <div className="flex items-center gap-2">
      <span
        className={`w-2 h-2 rounded-full ${status === 'ok' ? 'bg-emerald-400' : status === 'error' ? 'bg-red-400' : 'bg-yellow-400 animate-pulse'}`}
      />
      <span className="text-xs text-slate-400">
        {status === 'checking'
          ? t('overview.pinging')
          : status === 'ok'
            ? `${latency}ms`
            : status === 'error'
              ? t('overview.noResponse')
              : '—'}
      </span>
      <button
        onClick={() => void ping()}
        className="text-[10px] text-slate-600 hover:text-slate-400"
      >
        ↺
      </button>
    </div>
  );
}

interface AgentSessionBar {
  agentId: string;
  name?: string;
  count: number;
  msgs: number;
}

export function OverviewTab({
  onNavigate,
}: {
  onNavigate?: (tab: string, options?: { sessionAgentId?: string; sessionErrorCode?: string }) => void;
}) {
  const { t } = useLocale();
  const { toast } = useToast();
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const {
    data: status,
    loading,
    error,
    refetch,
  } = useQuery<GatewayStatus>(() => {
    const at = Date.now();
    return rpc<GatewayStatus>('gateway.status').then((d) => {
      setFetchedAt(at);
      return d;
    });
  }, []);

  const { data: agentListResult, refetch: refetchAgents } = useQuery<AgentListResult>(
    () => rpc<AgentListResult>('agent.list'),
    [],
  );

  const { data: sessionsData, refetch: refetchSessions } = useQuery<SessionListResult>(
    () => rpc<SessionListResult>('session.list'),
    [],
  );

  const { data: statsData, refetch: refetchStats } = useQuery<StatsResult>(
    () => rpc<StatsResult>('stats.get', { days: 14 }),
    [],
  );

  const uptime = useUptime(status?.uptime ?? null, fetchedAt);

  // Auto-refresh every 30s
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      refetch();
      refetchAgents();
      refetchSessions();
      refetchStats();
    }, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, refetch, refetchAgents, refetchSessions, refetchStats]);

  const handleReload = async () => {
    try {
      await rpc('agent.reload', {});
      toast('All agents reloaded', 'success');
      refetch();
      refetchAgents();
      refetchStats();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Reload failed', 'error');
    }
  };

  const handleClearTopError = async (agentId: string, errorCode: string) => {
    try {
      const result = await rpc<SessionClearResult>('session.clear', {
        agentId,
        failedOnly: true,
        errorCode,
      });
      toast(buildOverviewClearResultMessage(t, result, agentId, errorCode), 'success');
      refetchSessions();
      refetchStats();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Clear failed', 'error');
    }
  };

  if (loading && !status) return <div className="text-slate-400 text-sm p-8">{t('common.loading')}</div>;
  if (error) return <div className="text-red-400 text-sm p-8">{t('common.error')}{error}</div>;

  const agents: AgentInfo[] = Array.isArray(agentListResult?.agents) ? agentListResult.agents : [];
  const sessions: SessionMetaInfo[] = sessionsData?.sessions ?? [];
  const errorStats: ErrorStatsSummary | null = statsData?.errors ?? null;
  const agentCount = typeof status?.agents === 'number' ? status.agents : agents.length;

  // Aggregate stats
  const totalMsgs = sessions.reduce((s, x) => s + x.messageCount, 0);
  const totalTokens = sessions.reduce((s, x) => s + (x.totalTokens ?? 0), 0);
  const problemSessions =
    errorStats?.totalErrorSessions ??
    sessions.filter((s) => s.status === 'error' || s.status === 'suspended').length;
  const errorBreakdown = errorStats?.breakdown ?? [];
  const errorTrend = errorStats?.trend ?? [];
  const hotAgents = errorStats?.byAgent.slice(0, 5) ?? [];
  const maxTrendCount = Math.max(...errorTrend.map((point) => point.count), 1);
  const hasApprovalRequiredProblems = errorBreakdown.some((entry) => entry.code === 'approval_required');

  // Per-agent session bars
  const agentBars: AgentSessionBar[] = agents
    .map((a) => {
      const agentSessions = sessions.filter((s) => s.agentId === a.agentId);
      return {
        agentId: a.agentId,
        name: a.name,
        count: agentSessions.length,
        msgs: agentSessions.reduce((acc, s) => acc + s.messageCount, 0),
      };
    })
    .filter((b) => b.count > 0)
    .sort((a, b) => b.count - a.count);

  const maxSessionCount = Math.max(...agentBars.map((b) => b.count), 1);

  // Recent sessions feed
  const recentSessions = [...sessions].sort((a, b) => b.lastActivity - a.lastActivity).slice(0, 8);

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-[17px] font-semibold text-slate-100 tracking-tight">{t('overview.title')}</h1>
          <p className="text-xs text-slate-500 mt-0.5">{t('overview.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 cursor-pointer text-xs text-slate-400">
            <input
              type="checkbox"
              className="rounded"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            {t('overview.autoRefresh')}
          </label>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              refetch();
              refetchAgents();
              refetchSessions();
              refetchStats();
            }}
          >
            {t('overview.refresh')}
          </Button>
          <Button size="sm" variant="primary" onClick={() => void handleReload()}>
            {t('overview.reloadAgents')}
          </Button>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-7">
        <StatCard label={t('overview.version')} value={status?.version ?? '—'} accent="text-slate-300" />
        <StatCard label={t('overview.uptime')} value={uptime} accent="text-emerald-400" />
        <StatCard label={t('overview.agents')} value={agentCount} accent="text-indigo-400" />
        <StatCard label={t('overview.sessions')} value={sessions.length} accent="text-blue-400" />
        <StatCard label={t('overview.messages')} value={totalMsgs} accent="text-violet-400" />
        <StatCard label={t('overview.errorSessions')} value={problemSessions} accent="text-red-400" />
        <StatCard
          label={t('overview.tokens')}
          value={totalTokens > 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens}
          accent="text-amber-400"
        />
      </div>

      {/* Health row */}
      <div
        className="rounded-xl px-5 py-3 flex items-center gap-6 flex-wrap ring-1 ring-white/[0.06]"
        style={{ background: 'rgba(14,17,28,0.8)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400 font-medium">{t('overview.gateway')}</span>
          <Badge variant="green">{t('overview.online')}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">{t('overview.rpcLatency')}</span>
          <PingWidget />
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-xs text-slate-500">v{status?.version}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Active Agents */}
        <div
          className="rounded-xl ring-1 ring-white/[0.07] overflow-hidden"
          style={{ background: 'rgba(14,17,28,0.85)' }}
        >
          <div
            className="px-5 py-3.5 flex items-center justify-between"
            style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
          >
            <h2 className="text-[13px] font-semibold text-slate-300 tracking-tight">
              {t('overview.activeAgents')}
            </h2>
            <div className="flex items-center gap-2">
              <Badge variant="blue">{agents.length}</Badge>
              {onNavigate && (
                <button
                  onClick={() => onNavigate('agents')}
                  className="text-xs text-slate-500 hover:text-indigo-400"
                >
                  →
                </button>
              )}
            </div>
          </div>
          {agents.length === 0 ? (
            <p className="text-slate-500 text-sm px-5 py-4">{t('overview.noAgentsRunning')}</p>
          ) : (
            <ul className="divide-y divide-slate-700/40">
              {agents.map((a) => (
                <li
                  key={a.agentId}
                  className="px-5 py-3 flex items-center gap-3 hover:bg-white/[0.02] transition-colors"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                  <span className="text-[13px] font-medium text-slate-200 truncate">
                    {a.name ?? a.agentId}
                  </span>
                  <span className="text-[11px] text-slate-500 ml-auto font-mono shrink-0">
                    {a.agentId}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Recent Sessions */}
        <div
          className="rounded-xl ring-1 ring-white/[0.07] overflow-hidden"
          style={{ background: 'rgba(14,17,28,0.85)' }}
        >
          <div
            className="px-5 py-3.5 flex items-center justify-between"
            style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
          >
            <h2 className="text-[13px] font-semibold text-slate-300 tracking-tight">
              {t('overview.recentSessions')}
            </h2>
            <div className="flex items-center gap-2">
              <Badge variant="gray">{sessions.length}</Badge>
              {onNavigate && (
                <button
                  onClick={() => onNavigate('sessions')}
                  className="text-xs text-slate-500 hover:text-indigo-400"
                >
                  →
                </button>
              )}
            </div>
          </div>
          {recentSessions.length === 0 ? (
            <p className="text-slate-500 text-sm px-5 py-4">{t('overview.noSessionsYet')}</p>
          ) : (
            <ul className="divide-y divide-slate-700/40">
              {recentSessions.map((s) => (
                <li
                  key={s.sessionKey}
                  className="px-5 py-2.5 flex items-center gap-3 hover:bg-white/[0.02] transition-colors"
                >
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-[11.5px] font-mono text-slate-300 truncate">
                      {s.threadKey}
                    </span>
                    <div className="flex items-center gap-2 flex-wrap mt-0.5">
                      <span className="text-[10px] text-slate-500">
                        {s.agentId} · {s.messageCount} msgs · {timeAgo(s.lastActivity)}
                      </span>
                      {s.errorCode ? (
                        <button
                          type="button"
                          onClick={() =>
                            onNavigate?.('sessions', {
                              sessionAgentId: s.agentId,
                              sessionErrorCode: s.errorCode,
                            })
                          }
                          className="inline-flex"
                        >
                          <Badge variant={statusBadgeVariant(s.status)}>{formatProblemCode(s.errorCode, t)}</Badge>
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {s.totalTokens && s.totalTokens > 0 && (
                    <span className="text-[10px] text-amber-500/80 shrink-0 font-mono">
                      {(s.totalTokens / 1000).toFixed(1)}k tk
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Session distribution per agent */}
      {agentBars.length > 0 && (
        <div
          className="rounded-xl ring-1 ring-white/[0.07] p-5"
          style={{ background: 'rgba(14,17,28,0.85)' }}
        >
          <h2 className="text-[13px] font-semibold text-slate-300 tracking-tight mb-4">
            {t('overview.sessionDistribution')}
          </h2>
          <div className="flex flex-col gap-3">
            {agentBars.map((b) => (
              <div key={b.agentId} className="flex items-center gap-3">
                <span className="text-[11.5px] text-slate-400 w-28 shrink-0 truncate">
                  {b.name ?? b.agentId}
                </span>
                <div
                  className="flex-1 rounded-full h-1.5 overflow-hidden"
                  style={{ background: 'rgba(255,255,255,0.07)' }}
                >
                  <div
                    className="bg-indigo-500 h-1.5 rounded-full transition-all duration-500"
                    style={{ width: `${(b.count / maxSessionCount) * 100}%` }}
                  />
                </div>
                <span className="text-[11px] text-slate-500 w-20 text-right shrink-0">
                  {b.count} sess · {b.msgs} msgs
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div
        className="rounded-xl ring-1 ring-white/[0.07] p-5"
        style={{ background: 'rgba(14,17,28,0.85)' }}
      >
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <h2 className="text-[13px] font-semibold text-slate-300 tracking-tight">
            {t('overview.errorBreakdown')}
          </h2>
          {errorStats ? (
            <span className="text-[11px] text-slate-500">
              {t('overview.errorTrendWindow')
                .replace('{count}', String(errorStats.recentErrorSessions))
                .replace('{n}', String(errorStats.windowDays))}
            </span>
          ) : null}
        </div>
        {errorTrend.length > 0 ? (
          <div className="mb-4 grid grid-cols-7 gap-2">
            {errorTrend.map((point) => (
              <div key={point.date} className="flex flex-col items-center gap-1.5">
                <div
                  className="w-full rounded-md overflow-hidden flex items-end"
                  style={{ background: 'rgba(255,255,255,0.05)', height: 56 }}
                >
                  <div
                    className={
                      hasApprovalRequiredProblems
                        ? 'w-full bg-amber-500/70 rounded-md transition-all duration-500'
                        : 'w-full bg-red-500/70 rounded-md transition-all duration-500'
                    }
                    style={{ height: `${Math.max(10, (point.count / maxTrendCount) * 100)}%` }}
                    title={`${point.date}: ${point.count}`}
                  />
                </div>
                <span className="text-[10px] text-slate-500">{formatTrendLabel(point.date)}</span>
                <span className="text-[10px] text-slate-400 font-mono">{point.count}</span>
              </div>
            ))}
          </div>
        ) : null}
        {errorBreakdown.length === 0 ? (
          <p className="text-slate-500 text-sm">{t('overview.noErrors')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {errorBreakdown.map(({ code, count }) => (
              <button
                key={code}
                type="button"
                onClick={() => onNavigate?.('sessions', { sessionErrorCode: code })}
                className="inline-flex"
                title={t('overview.openFilteredSessions')}
              >
                <Badge variant={problemCodeBadgeVariant(code)}>
                  {formatProblemCode(code, t)} · {count}
                </Badge>
              </button>
            ))}
          </div>
        )}
      </div>

      <div
        className="rounded-xl ring-1 ring-white/[0.07] p-5"
        style={{ background: 'rgba(14,17,28,0.85)' }}
      >
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <h2 className="text-[13px] font-semibold text-slate-300 tracking-tight">
            {t('overview.agentErrors')}
          </h2>
          {errorStats ? (
            <span className="text-[11px] text-slate-500">
              {t('overview.agentErrorsHint').replace('{n}', String(errorStats.windowDays))}
            </span>
          ) : null}
        </div>
        {hotAgents.length === 0 ? (
          <p className="text-slate-500 text-sm">{t('overview.noErrors')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {hotAgents.map((entry) => {
              const agent = agents.find((item) => item.agentId === entry.agentId);
              const label = agent?.name ?? entry.agentId;
              const topProblemVariant = problemCodeBadgeVariant(entry.topErrorCode);
              const topProblemAccent = isSuspendedProblemCode(entry.topErrorCode) ? 'amber' : 'red';
              const trendPeak = Math.max(...entry.trend.map((point) => point.count), 0);
              const trendToday = entry.trend.at(-1)?.count ?? 0;
              return (
                <div
                  key={entry.agentId}
                  className={`flex items-start gap-3 rounded-lg bg-white/[0.02] ring-1 ring-white/[0.05] px-3 py-2.5 text-left transition-colors ${problemPanelTone(entry.topErrorCode)}`}
                >
                  <button
                    type="button"
                    onClick={() =>
                      onNavigate?.('sessions', {
                        sessionAgentId: entry.agentId,
                        sessionErrorCode: entry.topErrorCode,
                      })
                    }
                    title={t('overview.openAgentSessions')}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[12px] font-medium text-slate-200 truncate">{label}</span>
                      <span className="text-[10px] text-slate-500 font-mono">{entry.agentId}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px] text-slate-500">
                      <span>
                        {entry.recentErrorSessions} / {entry.totalErrorSessions} {t('overview.errorSessions')}
                      </span>
                      <span>·</span>
                      <span>{formatDateTime(entry.latestErrorAt)}</span>
                    </div>
                    <AgentRecoveryHintMini errorCode={entry.topErrorCode} t={t} />
                    <AgentTrendMini
                      trend={entry.trend}
                      windowDays={errorStats?.windowDays ?? 14}
                      accent={topProblemAccent}
                      summary={
                        trendPeak > 0
                          ? t('overview.agentTrendActive')
                              .replace('{peak}', String(trendPeak))
                              .replace('{today}', String(trendToday))
                          : t('overview.agentTrendQuiet')
                      }
                    />
                  </button>
                  <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end pt-0.5">
                    <Badge variant={topProblemVariant}>{formatProblemCode(entry.topErrorCode, t)}</Badge>
                    <Badge variant="gray">{entry.recentErrorSessions}</Badge>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => void handleClearTopError(entry.agentId, entry.topErrorCode)}
                    >
                      {t('overview.clearTopError')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div
        className="rounded-xl ring-1 ring-white/[0.06] p-5"
        style={{ background: 'rgba(14,17,28,0.6)' }}
      >
        <h2 className="text-[13px] font-semibold text-slate-400 tracking-tight mb-3">
          {t('overview.quickActions')}
        </h2>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => onNavigate?.('chat')}>
            {t('overview.openChat')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onNavigate?.('sessions')}>
            {t('overview.browseSessions')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onNavigate?.('agents')}>
            {t('overview.manageAgents')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onNavigate?.('workflow')}>
            {t('overview.workflows')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void handleReload()}>
            {t('overview.reloadAllAgents')}
          </Button>
        </div>
      </div>
    </div>
  );
}
