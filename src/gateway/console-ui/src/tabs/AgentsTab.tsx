import { useCallback, useState } from 'react';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { useLocale } from '../context/i18n.js';
import { rpc, useQuery } from '../hooks/useRpc.js';
import { useToast } from '../hooks/useToast.js';
import { formatProblemCode, isSuspendedProblemCode, problemCodeBadgeVariant } from '../problem-code-display.js';
import { getRecoveryHint } from '../recovery-hints.js';
import type {
  AgentActivityInfo,
  AgentConfig,
  AgentInfo,
  AgentListResult,
  ErrorStatsByAgentEntry,
  ErrorStatsTrendPoint,
  SessionClearResult,
  SessionListResult,
  StatsResult,
} from '../types.js';

function formatElapsed(createdAt: number): string {
  const sec = Math.floor((Date.now() - createdAt) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function agentStateBadgeVariant(activity?: AgentActivityInfo): 'green' | 'yellow' | 'gray' {
  if (activity?.state === 'suspended') {
    return 'yellow';
  }
  if (activity?.state === 'running') {
    return 'green';
  }
  return 'gray';
}

function agentStateLabel(
  activity: AgentActivityInfo | undefined,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (!activity || activity.state === 'idle') {
    return t('agents.idleBadge');
  }
  if (activity.state === 'suspended') {
    return t('agents.suspendedBadge');
  }
  if (activity.pendingCount > 0) {
    return t('agents.runningQueuedBadge', { n: activity.pendingCount });
  }
  return t('agents.runningBadge');
}

function formatQueuedThreadList(activity: AgentActivityInfo | undefined): string {
  const threadKeys = activity?.queuedRuns.map((run) => run.threadKey).filter(Boolean) ?? [];
  return threadKeys.slice(0, 2).join(', ');
}

function formatQueuedRunLabel(
  threadKey: string | undefined,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  return threadKey ? t('agents.threadBadge', { thread: threadKey }) : t('agents.queuedRunFallback');
}

interface EditForm {
  name: string;
  model: string;
  personaLanguage: string;
  personaOutputDir: string;
  workspace: string;
}

// ─── Mesh topology ─────────────────────────────────────────────────────────

interface MeshAgentEntry {
  agentId: string;
  name: string;
  capabilities: string[];
  model: string;
  role: string;
  status: 'idle' | 'busy' | 'offline';
  registeredAt: number;
  lastSeenAt: number;
}

const MESH_STATUS_COLORS: Record<string, string> = {
  idle: 'text-emerald-400',
  busy: 'text-amber-400',
  offline: '',
};

const MESH_STATUS_STYLES: Record<string, React.CSSProperties> = {
  offline: { color: 'var(--af-text-faint)' },
};

function MeshTopologyPanel() {
  const { data, refetch } = useQuery<{ agents: MeshAgentEntry[] }>(
    () => rpc<{ agents: MeshAgentEntry[] }>('mesh.status'),
    10_000,
  );
  const agents = data?.agents ?? [];

  if (agents.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--af-text-heading)' }}>Mesh 节点</h2>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--af-text-faint)' }}>已注册到本地 mesh 的 agent 列表</p>
        </div>
        <button
          onClick={refetch}
          className="text-[11px] transition-colors"
          style={{ color: 'var(--af-text-faint)' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--af-text-muted)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--af-text-faint)'; }}
        >
          刷新
        </button>
      </div>
      <div
        className="rounded-xl overflow-hidden"
        style={{ border: '1px solid rgba(255,255,255,0.07)' }}
      >
        <table className="w-full text-[12px]">
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.03)' }}>
              {['Agent ID', '名称', '角色', '状态', '模型', '能力'].map((h) => (
                <th
                  key={h}
                  className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide"
                  style={{ color: 'var(--af-text-faint)' }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {agents.map((agent, i) => (
              <tr
                key={agent.agentId}
                style={{
                  borderTop: i > 0 ? '1px solid rgba(255,255,255,0.04)' : undefined,
                  background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                }}
              >
                <td className="px-3 py-2 font-mono" style={{ color: 'var(--af-accent)' }}>{agent.agentId}</td>
                <td className="px-3 py-2" style={{ color: 'var(--af-text-muted)' }}>{agent.name || '—'}</td>
                <td className="px-3 py-2" style={{ color: 'var(--af-text-faint)' }}>{agent.role}</td>
                <td className={`px-3 py-2 font-medium ${MESH_STATUS_COLORS[agent.status] ?? ''}`}
                  style={MESH_STATUS_STYLES[agent.status] ?? undefined}>
                  {agent.status}
                </td>
                <td className="px-3 py-2 font-mono text-[11px]" style={{ color: 'var(--af-text-faint)' }}>{agent.model}</td>
                <td className="px-3 py-2" style={{ color: 'var(--af-text-faint)' }}>
                  {agent.capabilities.length > 0 ? agent.capabilities.join(', ') : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Edit form ─────────────────────────────────────────────────────────────
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
      <label className="text-xs" style={{ color: 'var(--af-text-muted)' }}>{label}</label>
      <input
        className="rounded-lg px-3 py-2 text-sm focus:outline-none"
        style={{
          background: 'var(--af-input-bg)',
          boxShadow: '0 0 0 1px var(--af-input-ring)',
          color: 'var(--af-text-base)',
        }}
        value={form[key]}
        placeholder={placeholder}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
      />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="rounded-2xl shadow-2xl w-full max-w-md p-6 flex flex-col gap-5" style={{ background: 'var(--af-overlay-bg)', border: '1px solid var(--af-overlay-border)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold" style={{ color: 'var(--af-text-heading)' }}>{t('agents.editModal.title')}</h2>
          <span className="font-mono text-xs" style={{ color: 'var(--af-text-muted)' }}>{agentId}</span>
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

function formatTrendLabel(date: string): string {
  return date.slice(5).replace('-', '/');
}

function problemCardTone(params: { hasProblems: boolean; topErrorCode?: string }): string {
  if (!params.hasProblems) {
    return 'hover:ring-white/[0.14]';
  }
  return isSuspendedProblemCode(params.topErrorCode ?? '')
    ? 'ring-amber-500/30 hover:ring-amber-500/45'
    : 'ring-red-500/30 hover:ring-red-500/45';
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
        .replace('{errorCode}', formatProblemCode(errorCode, t))
        .replace('{agentId}', agentId)
        .replace('{remaining}', String(remainingForAgent));
    }

    return t('agents.clearTopErrorResultClean')
      .replace('{count}', String(clearedCount))
      .replace('{errorCode}', formatProblemCode(errorCode, t))
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
    <div className="rounded-lg ring-1 px-3 py-2.5" style={{ background: 'var(--af-card-bg)', boxShadow: '0 0 0 1px var(--af-card-ring)' }}>
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
      <div className="mt-2 flex items-center justify-between gap-2 text-[10px]" style={{ color: 'var(--af-text-faint)' }}>
        <span>{formatTrendLabel(trend[0]?.date ?? '')}</span>
        <span style={{ color: 'var(--af-text-muted)' }}>{summary.replace('{n}', String(windowDays))}</span>
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

  const handleCancelQueued = useCallback(
    async (agentId: string, runId: string, threadKey?: string) => {
      try {
        const result = await rpc<{ cancelled: boolean; reason?: string }>('agent.cancel', { runId });
        if (!result.cancelled) {
          toast(result.reason ?? t('agents.cancelQueuedUnavailable'), 'error');
          refetch();
          return;
        }
        toast(
          t('agents.cancelQueuedSuccess', {
            agentId,
            thread: threadKey ?? t('agents.queuedRunFallback'),
          }),
          'success',
        );
        refetch();
      } catch (e) {
        toast(e instanceof Error ? e.message : t('agents.cancelQueuedUnavailable'), 'error');
      }
    },
    [toast, refetch, t],
  );

  const handleForceKill = useCallback(
    async (agentId: string, runId: string) => {
      try {
        await rpc<{ killed: boolean }>('agent.forceKill', { runId });
        toast(`Agent ${agentId} run force-killed`, 'success');
        refetch();
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Force kill failed', 'error');
      }
    },
    [toast, refetch],
  );

  if (loading && !agentsResult) return <div className="text-sm p-8" style={{ color: 'var(--af-text-muted)' }}>{t('common.loading')}</div>;
  if (error) return <div className="text-red-400 text-sm p-8">{t('common.error')}{error}</div>;

  const list: AgentInfo[] = Array.isArray(agentsResult?.agents) ? agentsResult.agents : [];
  const activeCount = list.filter((agent) => (agent.activity?.state ?? 'idle') !== 'idle').length;

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
          <h1 className="text-lg font-semibold" style={{ color: 'var(--af-text-heading)' }}>{t('agents.title')}</h1>
          <p className="text-xs mt-0.5" style={{ color: 'var(--af-text-muted)' }}>{t('agents.running', { n: activeCount })}</p>
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
            <span className="text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--af-text-muted)' }}>
              {workspace}
            </span>
            <div className="flex-1 h-px" style={{ background: 'var(--af-border)' }} />
            <span className="text-xs" style={{ color: 'var(--af-text-faint)' }}>{agents.length}</span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {agents.map((a) => {
              const cfg = agentConfigs[a.agentId];
              const isSelected = selected === a.agentId;
              const sessCount = sessionCounts[a.agentId] ?? 0;
              const errorStats = errorStatsByAgent.get(a.agentId);
              const activity = a.activity;
              const queuedThreadList = formatQueuedThreadList(activity);
              const hasRecentProblems = (errorStats?.recentErrorSessions ?? 0) > 0;
              const topProblemCode = errorStats?.topErrorCode;
              const topProblemVariant = topProblemCode ? problemCodeBadgeVariant(topProblemCode) : 'red';
              const topProblemTone = topProblemCode && isSuspendedProblemCode(topProblemCode);
              const trendPeak = Math.max(...(errorStats?.trend ?? []).map((point) => point.count), 0);
              const trendToday = errorStats?.trend.at(-1)?.count ?? 0;
              return (
                <div key={a.agentId} className="flex flex-col">
                  <div
                    className={`rounded-xl ring-1 transition-all p-4 flex flex-col gap-3 cursor-pointer ${
                      isSelected
                        ? ''
                        : problemCardTone({ hasProblems: hasRecentProblems, topErrorCode: topProblemCode })
                    }`}
                    style={isSelected ? {
                      background: 'var(--af-accent-soft)',
                      boxShadow: '0 0 0 1px var(--af-accent)',
                    } : {
                      background: 'var(--af-card-bg)',
                      boxShadow: '0 0 0 1px var(--af-card-ring)',
                    }}
                    onClick={() => setSelected(isSelected ? null : a.agentId)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-sm font-semibold truncate" style={{ color: 'var(--af-text-heading)' }}>
                          {a.name ?? a.agentId}
                        </span>
                        <span className="text-xs font-mono truncate" style={{ color: 'var(--af-text-faint)' }}>
                          {a.agentId}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Badge variant={agentStateBadgeVariant(activity)}>
                          {agentStateLabel(activity, t)}
                        </Badge>
                        {hasRecentProblems ? (
                          <Badge variant={topProblemVariant}>
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
                      {activity?.activeRun?.threadKey ? (
                        <Badge variant="gray">{t('agents.threadBadge', { thread: activity.activeRun.threadKey })}</Badge>
                      ) : null}
                      {(activity?.queuedRuns.length ?? 0) > 0 ? (
                        <Badge variant="yellow">{t('agents.queuedRunsBadge', { n: activity?.queuedRuns.length ?? 0 })}</Badge>
                      ) : null}
                      {errorStats ? (
                        <Badge variant={topProblemVariant}>{formatProblemCode(errorStats.topErrorCode, t)}</Badge>
                      ) : null}
                    </div>

                    {queuedThreadList ? (
                      <div className="rounded-lg bg-amber-950/15 ring-1 ring-amber-500/10 px-3 py-2 text-[11px] text-amber-100/85">
                        <div>{t('agents.queuedThreadsLabel', { threads: queuedThreadList })}</div>
                        {(activity?.queuedRuns.length ?? 0) > 0 ? (
                          <div className="mt-2 flex flex-col gap-2">
                            {activity?.queuedRuns.map((run) => (
                              <div
                                key={run.runId}
                                className="flex items-center justify-between gap-2 rounded-md bg-black/10 px-2.5 py-1.5"
                              >
                                <div className="min-w-0 text-[10px] text-amber-100/80">
                                  <div className="truncate font-medium">
                                    {formatQueuedRunLabel(run.threadKey, t)}
                                  </div>
                                  <div className="truncate font-mono text-amber-200/55">{run.runId}</div>
                                </div>
                                <Button
                                  size="sm"
                                  variant="danger"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handleCancelQueued(a.agentId, run.runId, run.threadKey);
                                  }}
                                >
                                  {t('agents.cancelQueued')}
                                </Button>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {activity?.activeRun && activity.state === 'running' ? (
                      <div className="rounded-lg bg-emerald-950/15 ring-1 ring-emerald-500/20 px-3 py-2 text-[11px] text-emerald-100/80 flex items-center justify-between gap-2">
                        <div className="flex flex-col gap-0.5 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="inline-flex items-center gap-1 font-medium text-emerald-300">
                              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                              执行中
                            </span>
                            <span className="text-emerald-100/50 font-mono">{formatElapsed(activity.activeRun.createdAt)}</span>
                            {activity.activeRun.threadKey ? (
                              <span className="text-emerald-100/50">· {activity.activeRun.threadKey}</span>
                            ) : null}
                          </div>
                          <div className="truncate font-mono text-emerald-200/40 text-[10px]">{activity.activeRun.runId}</div>
                        </div>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleForceKill(a.agentId, activity.activeRun!.runId);
                          }}
                        >
                          强制终止
                        </Button>
                      </div>
                    ) : null}

                    {errorStats ? (
                      <div
                        className={
                          topProblemTone
                            ? 'rounded-lg bg-amber-950/20 ring-1 ring-amber-500/15 px-3 py-2 text-[11px] text-amber-100/85'
                            : 'rounded-lg bg-red-950/20 ring-1 ring-red-500/15 px-3 py-2 text-[11px]'
                        }
                        style={topProblemTone ? undefined : { color: 'var(--af-text-muted)' }}
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <span>
                            {t('agents.errorSummary')
                              .replace('{recent}', String(errorStats.recentErrorSessions))
                              .replace('{total}', String(errorStats.totalErrorSessions))}
                          </span>
                          <span style={{ color: 'var(--af-text-faint)' }}>·</span>
                          <Badge variant={topProblemVariant}>{formatProblemCode(errorStats.topErrorCode, t)}</Badge>
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
                    <div className="rounded-b-xl ring-1 ring-t-0 px-4 py-3 -mt-1" style={{ background: 'var(--af-surface-2)', boxShadow: '0 0 0 1px var(--af-border)' }}>
                      <pre className="text-xs font-mono overflow-x-auto whitespace-pre-wrap" style={{ color: 'var(--af-text-muted)' }}>
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

      {list.length === 0 && <p className="text-sm py-4" style={{ color: 'var(--af-text-faint)' }}>{t('agents.noAgents')}</p>}

      {/* Mesh topology — only rendered when mesh agents are registered */}
      <MeshTopologyPanel />
    </div>
  );
}
