import { useCallback, useEffect, useState } from 'react';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { StatCard } from '../components/StatCard.js';
import { useLocale } from '../context/i18n.js';
import { rpc, useQuery } from '../hooks/useRpc.js';
import { useToast } from '../hooks/useToast.js';
import { useUptime } from '../hooks/useUptime.js';
import type {
  AgentInfo,
  AgentListResult,
  GatewayStatus,
  SessionListResult,
  SessionMetaInfo,
} from '../types.js';

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
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

export function OverviewTab({ onNavigate }: { onNavigate?: (tab: string) => void }) {
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

  const uptime = useUptime(status?.uptime ?? null, fetchedAt);

  // Auto-refresh every 30s
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      refetch();
      refetchAgents();
      refetchSessions();
    }, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, refetch, refetchAgents, refetchSessions]);

  const handleReload = async () => {
    try {
      await rpc('agent.reload', {});
      toast('All agents reloaded', 'success');
      refetch();
      refetchAgents();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Reload failed', 'error');
    }
  };

  if (loading && !status) return <div className="text-slate-400 text-sm p-8">{t('common.loading')}</div>;
  if (error) return <div className="text-red-400 text-sm p-8">{t('common.error')}{error}</div>;

  const agents: AgentInfo[] = Array.isArray(agentListResult?.agents) ? agentListResult.agents : [];
  const sessions: SessionMetaInfo[] = sessionsData?.sessions ?? [];
  const agentCount = typeof status?.agents === 'number' ? status.agents : agents.length;

  // Aggregate stats
  const totalMsgs = sessions.reduce((s, x) => s + x.messageCount, 0);
  const totalTokens = sessions.reduce((s, x) => s + (x.totalTokens ?? 0), 0);

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
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label={t('overview.version')} value={status?.version ?? '—'} accent="text-slate-300" />
        <StatCard label={t('overview.uptime')} value={uptime} accent="text-emerald-400" />
        <StatCard label={t('overview.agents')} value={agentCount} accent="text-indigo-400" />
        <StatCard label={t('overview.sessions')} value={sessions.length} accent="text-blue-400" />
        <StatCard label={t('overview.messages')} value={totalMsgs} accent="text-violet-400" />
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
                    <span className="text-[10px] text-slate-500 mt-0.5">
                      {s.agentId} · {s.messageCount} msgs · {timeAgo(s.lastActivity)}
                    </span>
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
