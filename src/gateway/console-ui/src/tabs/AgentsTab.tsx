import { useCallback, useState } from 'react';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { useLocale } from '../context/i18n.js';
import { rpc, useQuery } from '../hooks/useRpc.js';
import { useToast } from '../hooks/useToast.js';
import { getRecoveryHint } from '../recovery-hints.js';
import type {
  AgentConfig,
  AgentInfo,
  AgentListResult,
  ErrorStatsByAgentEntry,
  ErrorStatsTrendPoint,
  SessionClearResult,
  SessionListResult,
  StatsResult,
} from '../types.js';

interface EditForm {
  name: string;
  model: string;
  personaLanguage: string;
  personaOutputDir: string;
  workspace: string;
}

function EditModal({
  agentId,
  current,
  onClose,
  onSaved,
}: {
  agentId: string;
  current: AgentConfig;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const { t } = useLocale();
  const [form, setForm] = useState<EditForm>({
    name: current.name ?? '',
    model: current.model ?? '',
    personaLanguage: current.persona?.language ?? '',
    personaOutputDir: current.persona?.outputDir ?? '',
    workspace: current.workspace ?? '',
  });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const fullConfig = await rpc<Record<string, unknown>>('config.get');
      const agents = fullConfig.agents as Record<string, AgentConfig> | AgentConfig[] | undefined;
      const nextAgent: AgentConfig = {
        ...(current ?? { id: agentId }),
        id: agentId,
        name: form.name || undefined,
        model: form.model || undefined,
        workspace: form.workspace || undefined,
        persona:
          form.personaLanguage || form.personaOutputDir
            ? {
                language: form.personaLanguage || undefined,
                outputDir: form.personaOutputDir || undefined,
              }
            : undefined,
      };

      let updated: Record<string, AgentConfig> | AgentConfig[] = {};
      if (Array.isArray(agents)) {
        let found = false;
        updated = agents.map((agent) => {
          if (agent.id !== agentId) return agent;
          found = true;
          return nextAgent;
        });
        if (!found) updated.push(nextAgent);
      } else if (agents) {
        updated = { ...agents, [agentId]: nextAgent };
      } else {
        updated = { [agentId]: nextAgent };
      }

      await rpc('config.save', { ...fullConfig, agents: updated });
      toast(`Agent ${agentId} saved`, 'success');
      onSaved();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const field = (label: string, key: keyof EditForm, placeholder?: string) => (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-slate-400">{label}</label>
      <input
        className="rounded-lg bg-slate-900/70 ring-1 ring-slate-700 px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-indigo-500"
        value={form[key]}
        placeholder={placeholder}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
      />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-900 ring-1 ring-slate-700 rounded-2xl shadow-2xl w-full max-w-md p-6 flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-100">{t('agents.editModal.title')}</h2>
          <span className="font-mono text-xs text-slate-500">{agentId}</span>
        </div>
        <div className="flex flex-col gap-4">
          {field(t('agents.editModal.name'), 'name', t('agents.editModal.namePlaceholder'))}
          {field(t('agents.editModal.model'), 'model', t('agents.editModal.modelPlaceholder'))}
          {field(t('agents.editModal.workspace'), 'workspace', t('agents.editModal.workspacePlaceholder'))}
          {field(
            t('agents.editModal.personaLanguage'),
            'personaLanguage',
            t('agents.editModal.personaLanguagePlaceholder'),
          )}
          {field(
            t('agents.editModal.personaOutputDir'),
            'personaOutputDir',
            t('agents.editModal.personaOutputDirPlaceholder'),
          )}
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" onClick={() => void handleSave()}>
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function formatErrorCode(errorCode: string): string {
  return errorCode.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function formatTrendLabel(date: string): string {
  return date.slice(5).replace('-', '/');
}

function buildClearResultMessage(
  t: (key: string, vars?: Record<string, string | number>) => string,
  result: SessionClearResult,
  agentId: string,
  errorCode?: string,
): string {
  const clearedCount = result.clearedSessions ?? 0;
  const remainingForAgent = result.remainingFailedSessionsForAgent ?? 0;

  if (errorCode) {
    if (remainingForAgent > 0) {
      return t('agents.clearTopErrorResultRemaining')
        .replace('{count}', String(clearedCount))
        .replace('{errorCode}', formatErrorCode(errorCode))
        .replace('{agentId}', agentId)
        .replace('{remaining}', String(remainingForAgent));
    }

    return t('agents.clearTopErrorResultClean')
      .replace('{count}', String(clearedCount))
      .replace('{errorCode}', formatErrorCode(errorCode))
      .replace('{agentId}', agentId);
  }

  if (remainingForAgent > 0) {
    return t('agents.clearFailedResultRemaining')
      .replace('{count}', String(clearedCount))
      .replace('{agentId}', agentId)
      .replace('{remaining}', String(remainingForAgent));
  }

  return t('agents.clearFailedResultClean')
    .replace('{count}', String(clearedCount))
    .replace('{agentId}', agentId);
}

function AgentErrorTrend({
  trend,
  windowDays,
  summary,
}: {
  trend: ErrorStatsTrendPoint[];
  windowDays: number;
  summary: string;
}) {
  if (trend.length === 0) return null;

  const peakCount = Math.max(...trend.map((point) => point.count), 0);

  return (
    <div className="rounded-lg bg-slate-950/40 ring-1 ring-white/5 px-3 py-2.5">
      <div className="flex items-end gap-1 h-10">
        {trend.map((point) => (
          <div key={point.date} className="flex-1 h-full flex items-end" title={`${point.date}: ${point.count}`}>
            <div
              className="w-full rounded-sm bg-gradient-to-t from-red-500/75 to-amber-300/80"
              style={{ height: `${Math.max(10, peakCount > 0 ? (point.count / peakCount) * 100 : 10)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-slate-500">
        <span>{formatTrendLabel(trend[0]?.date ?? '')}</span>
        <span className="text-slate-400">{summary.replace('{n}', String(windowDays))}</span>
        <span>{formatTrendLabel(trend.at(-1)?.date ?? '')}</span>
      </div>
    </div>
  );
}

function AgentRecoveryTip({
  errorCode,
  t,
}: {
  errorCode: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const hint = getRecoveryHint(errorCode, (key) => t(key));

  return (
    <div className="rounded-lg bg-amber-950/15 ring-1 ring-amber-500/10 px-3 py-2 text-[11px] text-amber-100/85">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex rounded-full bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300/90">
          {hint.actionLabel}
        </span>
        <span className="font-medium text-amber-200">{hint.title}</span>
      </div>
      <div className="mt-1 leading-5 text-amber-100/75">{hint.description}</div>
    </div>
  );
}

export function AgentsTab({
  onNavigate,
}: {
  onNavigate?: (tab: string, options?: { sessionAgentId?: string; sessionErrorCode?: string }) => void;
}) {
  const { toast } = useToast();
  const { t } = useLocale();
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const {
    data: agentsResult,
    loading,
    error,
    refetch,
  } = useQuery<AgentListResult>(() => rpc<AgentListResult>('agent.list'), []);

  const { data: config, refetch: refetchConfig } = useQuery<{
    agents?: AgentConfig[] | Record<string, AgentConfig>;
  }>(() => rpc<{ agents?: AgentConfig[] | Record<string, AgentConfig> }>('config.get'), []);

  const { data: sessionsData, refetch: refetchSessions } = useQuery<SessionListResult>(
    () => rpc<SessionListResult>('session.list'),
    [],
  );

  const { data: statsData, refetch: refetchStats } = useQuery<StatsResult>(
    () => rpc<StatsResult>('stats.get', { days: 14 }),
    [],
  );

  // Build agent config map
  const agentConfigs: Record<string, AgentConfig> = {};
  if (Array.isArray(config?.agents)) {
    for (const a of config.agents) agentConfigs[a.id] = a;
  } else if (config?.agents && typeof config.agents === 'object') {
    for (const [id, cfg] of Object.entries(config.agents)) agentConfigs[id] = { id, ...cfg };
  }

  // Session counts per agent
  const sessionCounts: Record<string, number> = {};
  for (const s of sessionsData?.sessions ?? []) {
    sessionCounts[s.agentId] = (sessionCounts[s.agentId] ?? 0) + 1;
  }

  const errorStatsByAgent = new Map<string, ErrorStatsByAgentEntry>(
    (statsData?.errors.byAgent ?? []).map((entry) => [entry.agentId, entry]),
  );
  const errorWindowDays = statsData?.errors.windowDays ?? 14;

  const handleReload = useCallback(
    async (agentId: string) => {
      try {
        await rpc('agent.reload', { agentId });
        toast(`Agent ${agentId} reloaded`, 'success');
        refetch();
        refetchConfig();
        refetchStats();
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Reload failed', 'error');
      }
    },
    [toast, refetch, refetchConfig, refetchStats],
  );

  const handleClear = useCallback(
    async (agentId: string) => {
      try {
        await rpc('session.clear', { agentId });
        toast(`Sessions cleared for ${agentId}`, 'success');
        refetchSessions();
        refetchStats();
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Clear failed', 'error');
      }
    },
    [toast, refetchSessions, refetchStats],
  );

  const handleClearFailed = useCallback(
    async (agentId: string) => {
      try {
        const result = await rpc<SessionClearResult>('session.clear', {
          agentId,
          failedOnly: true,
        });
        toast(buildClearResultMessage(t, result, agentId), 'success');
        refetchSessions();
        refetchStats();
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Clear failed', 'error');
      }
    },
    [toast, refetchSessions, refetchStats, t],
  );

  const handleClearTopError = useCallback(
    async (agentId: string, errorCode: string) => {
      try {
        const result = await rpc<SessionClearResult>('session.clear', {
          agentId,
          failedOnly: true,
          errorCode,
        });
        toast(buildClearResultMessage(t, result, agentId, errorCode), 'success');
        refetchSessions();
        refetchStats();
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Clear failed', 'error');
      }
    },
    [toast, refetchSessions, refetchStats, t],
  );

  if (loading && !agentsResult) return <div className="text-slate-400 text-sm p-8">{t('common.loading')}</div>;
  if (error) return <div className="text-red-400 text-sm p-8">{t('common.error')}{error}</div>;

  const list: AgentInfo[] = Array.isArray(agentsResult?.agents) ? agentsResult.agents : [];

  // Group by workspace
  const groups: Record<string, AgentInfo[]> = {};
  for (const a of list) {
    const grp = agentConfigs[a.agentId]?.workspace ?? 'Default';
    (groups[grp] ??= []).push(a);
  }
  const groupEntries = Object.entries(groups).sort(([a], [b]) =>
    a === 'Default' ? 1 : b === 'Default' ? -1 : a.localeCompare(b),
  );

  const editingCfg = editing ? agentConfigs[editing] : null;

  return (
    <div className="flex flex-col gap-6">
      {editing && editingCfg && (
        <EditModal
          agentId={editing}
          current={editingCfg}
          onClose={() => setEditing(null)}
          onSaved={() => {
            refetch();
            refetchConfig();
          }}
        />
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">{t('agents.title')}</h1>
          <p className="text-xs text-slate-500 mt-0.5">{t('agents.running', { n: list.length })}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            refetch();
            refetchConfig();
            refetchSessions();
            refetchStats();
          }}
        >
          {t('agents.refresh')}
        </Button>
      </div>

      {groupEntries.map(([workspace, agents]) => (
        <div key={workspace} className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
              {workspace}
            </span>
            <div className="flex-1 h-px bg-slate-700/50" />
            <span className="text-xs text-slate-600">{agents.length}</span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {agents.map((a) => {
              const cfg = agentConfigs[a.agentId];
              const isSelected = selected === a.agentId;
              const sessCount = sessionCounts[a.agentId] ?? 0;
              const errorStats = errorStatsByAgent.get(a.agentId);
              const hasRecentErrors = (errorStats?.recentErrorSessions ?? 0) > 0;
              const trendPeak = Math.max(...(errorStats?.trend ?? []).map((point) => point.count), 0);
              const trendToday = errorStats?.trend.at(-1)?.count ?? 0;
              return (
                <div key={a.agentId} className="flex flex-col">
                  <div
                    className={`rounded-xl bg-slate-800/60 ring-1 transition-all p-4 flex flex-col gap-3 cursor-pointer ${
                      isSelected
                        ? 'ring-indigo-500/60 bg-slate-800'
                        : hasRecentErrors
                          ? 'ring-red-500/30 hover:ring-red-500/45'
                          : 'ring-slate-700/50 hover:ring-indigo-500/30'
                    }`}
                    onClick={() => setSelected(isSelected ? null : a.agentId)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-sm font-semibold text-slate-100 truncate">
                          {a.name ?? a.agentId}
                        </span>
                        <span className="text-xs font-mono text-slate-500 truncate">
                          {a.agentId}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Badge variant="green">{t('agents.runningBadge')}</Badge>
                        {hasRecentErrors ? (
                          <Badge variant="red">
                            {t('agents.recentErrorsBadge').replace(
                              '{n}',
                              String(errorStats?.recentErrorSessions ?? 0),
                            )}
                          </Badge>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {cfg?.model && <Badge variant="blue">{cfg.model}</Badge>}
                      {cfg?.persona && <Badge variant="purple">{t('agents.personaBadge')}</Badge>}
                      {sessCount > 0 && <Badge variant="gray">{t('agents.sessionsBadge', { n: sessCount })}</Badge>}
                      {errorStats ? (
                        <Badge variant="red">{formatErrorCode(errorStats.topErrorCode)}</Badge>
                      ) : null}
                    </div>

                    {errorStats ? (
                      <div className="rounded-lg bg-red-950/20 ring-1 ring-red-500/15 px-3 py-2 text-[11px] text-slate-300">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span>
                            {t('agents.errorSummary')
                              .replace('{recent}', String(errorStats.recentErrorSessions))
                              .replace('{total}', String(errorStats.totalErrorSessions))}
                          </span>
                          <span className="text-slate-500">·</span>
                          <span className="text-slate-400">{formatErrorCode(errorStats.topErrorCode)}</span>
                        </div>
                      </div>
                    ) : null}

                    {errorStats ? <AgentRecoveryTip errorCode={errorStats.topErrorCode} t={t} /> : null}

                    {errorStats ? (
                      <AgentErrorTrend
                        trend={errorStats.trend}
                        windowDays={errorWindowDays}
                        summary={
                          trendPeak > 0
                            ? t('agents.errorTrendActive')
                                .replace('{peak}', String(trendPeak))
                                .replace('{today}', String(trendToday))
                            : t('agents.errorTrendQuiet')
                        }
                      />
                    ) : null}

                    <div className="flex gap-2 mt-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(a.agentId);
                        }}
                      >
                        {t('agents.edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleReload(a.agentId);
                        }}
                      >
                        {t('agents.reload')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleClear(a.agentId);
                        }}
                      >
                        {t('agents.clearSessions')}
                      </Button>
                      {errorStats ? (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleClearFailed(a.agentId);
                          }}
                        >
                          {t('agents.clearFailed')}
                        </Button>
                      ) : null}
                      {errorStats ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleClearTopError(a.agentId, errorStats.topErrorCode);
                          }}
                        >
                          {t('agents.clearTopError')}
                        </Button>
                      ) : null}
                      {errorStats ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            onNavigate?.('sessions', {
                              sessionAgentId: a.agentId,
                              sessionErrorCode: errorStats.topErrorCode,
                            });
                          }}
                        >
                          {t('agents.viewFailures')}
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {/* Expanded config detail */}
                  {isSelected && cfg && (
                    <div className="rounded-b-xl bg-slate-900/70 ring-1 ring-t-0 ring-slate-700/50 px-4 py-3 -mt-1">
                      <pre className="text-xs font-mono text-slate-400 overflow-x-auto whitespace-pre-wrap">
                        {JSON.stringify(cfg, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {list.length === 0 && <p className="text-slate-500 text-sm py-4">{t('agents.noAgents')}</p>}
    </div>
  );
}
