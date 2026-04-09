import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { DeliverableModal } from '../components/DeliverableModal.js';
import { useLocale } from '../context/i18n.js';
import { rpc, useQuery } from '../hooks/useRpc.js';
import { useToast } from '../hooks/useToast.js';
import type {
  AgentInfo,
  AgentListResult,
  ChannelInfo,
  ChannelListResult,
  PublicationTargetConfig,
  RunningTaskInfo,
  SchedulerListResult,
  TaskHistoryResult,
  TaskInfo,
  TaskRunRecord,
  WorkflowDef,
} from '../types.js';

type ScheduleMode = 'cron' | 'interval';

interface TaskForm {
  name: string;
  targetType: 'agent' | 'workflow';
  agentId: string;
  workflowId: string;
  message: string;
  scheduleMode: ScheduleMode;
  cronExpr: string;
  intervalMinutes: number;
  reportTo: string;
  outputChannel: 'logs' | 'cli' | 'web';
  publicationTargets: PublicationTargetConfig[];
  enabled: boolean;
}

interface TaskModalState {
  mode: 'add' | 'edit';
  taskId?: string;
  form: TaskForm;
}

interface SchedulePreview {
  valid: boolean;
  cronExpr: string;
  nextRunAt?: number | null;
  error?: string;
}

interface ConfirmState {
  title: string;
  message: string;
  onConfirm: () => Promise<void>;
}

function defaultTaskForm(agentId: string): TaskForm {
  return {
    name: '',
    targetType: 'agent',
    agentId,
    workflowId: '',
    message: '',
    scheduleMode: 'cron',
    cronExpr: '0 * * * *',
    intervalMinutes: 60,
    reportTo: '',
    outputChannel: 'logs',
    publicationTargets: [],
    enabled: true,
  };
}

function formatPublicationLabel(
  channel: ChannelInfo,
  t: (key: string, vars?: Record<string, string>) => string,
): string {
  return channel.supportsAttachment
    ? t('propagation.channelArtifactReady')
    : t('propagation.channelSummaryOnly');
}

interface ChannelsConfigResult {
  channels?: {
    defaults?: {
      output?: 'logs' | 'cli' | 'web';
      schedulerOutput?: 'logs' | 'cli' | 'web';
    };
  };
}

function guessScheduleMode(task: TaskInfo): ScheduleMode {
  return task.cronExpr.startsWith('*/') ? 'interval' : 'cron';
}

function preferredExecutionAgentId(agents: AgentInfo[]): string {
  return (
    agents.find((agent) => agent.sandboxProfile === 'readonly-output')?.agentId ??
    agents.find((agent) => !!agent.sandboxProfile)?.agentId ??
    agents[0]?.agentId ??
    ''
  );
}

function formatAgentLabel(agent: AgentInfo): string {
  const baseLabel = agent.name ?? agent.agentId;
  return agent.sandboxProfile ? `${baseLabel} [sandbox:${agent.sandboxProfile}]` : baseLabel;
}

function describeAgentTarget(agentId: string | undefined, agents: AgentInfo[]): string {
  if (!agentId) return '—';
  const agent = agents.find((item) => item.agentId === agentId);
  return agent ? formatAgentLabel(agent) : agentId;
}

function renderTaskAdvisory(task: TaskInfo) {
  if (!task.advisory) {
    return null;
  }

  const extraDetails = (task.advisory.details ?? []).filter(
    (detail) => detail !== task.advisory?.message,
  );

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-amber-300 leading-relaxed">{task.advisory.message}</span>
      {extraDetails.map((detail) => (
        <span key={detail} className="text-[11px] text-amber-200/75 leading-relaxed">
          {detail}
        </span>
      ))}
    </div>
  );
}

function buildSchedulerAgentAdvisory(agentId: string | undefined, agents: AgentInfo[]): string | null {
  if (!agentId) {
    return null;
  }

  const targetAgent = agents.find((agent) => agent.agentId === agentId);
  if (!targetAgent || targetAgent.sandboxProfile) {
    return null;
  }

  const recommended =
    agents.find((agent) => agent.sandboxProfile === 'readonly-output') ??
    agents.find((agent) => !!agent.sandboxProfile);
  if (recommended && recommended.agentId !== targetAgent.agentId) {
    return `当前定时任务目标未绑定 sandboxProfile，建议切换到 ${formatAgentLabel(recommended)}。`;
  }

  return '当前定时任务目标未绑定 sandboxProfile，建议在无人值守执行前绑定 readonly-output 或其他受限 profile。';
}

function FormModal({
  title,
  description,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  description: string;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}) {
  const { t } = useLocale();
  return createPortal(
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-3xl mx-4 max-h-[85vh] overflow-auto rounded-2xl bg-slate-900 ring-1 ring-slate-700 p-5 flex flex-col gap-4">
        <div>
          <h3 className="text-base font-semibold text-slate-100">{title}</h3>
          <p className="text-xs text-slate-400 mt-1">{description}</p>
        </div>
        <div className="flex flex-col gap-3">{children}</div>
        <div className="flex justify-end gap-2 pt-2 border-t border-slate-700/50">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={onSubmit}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ConfirmModal({ state, onClose }: { state: ConfirmState; onClose: () => void }) {
  const { t } = useLocale();
  return createPortal(
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md mx-4 rounded-2xl bg-slate-900 ring-1 ring-slate-700 p-5 flex flex-col gap-4">
        <h3 className="text-base font-semibold text-slate-100">{state.title}</h3>
        <p className="text-sm text-slate-400">{state.message}</p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="danger" onClick={() => void state.onConfirm()}>
            {t('common.confirm')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[200px_minmax(0,1fr)] gap-3 items-center">
      <span className="text-xs text-slate-400">{label}</span>
      {children}
    </label>
  );
}

// ── History record card (collapsible result) ────────────────────────────────
function HistoryRecordCard({
  r,
  durStr,
  index,
  total,
  onOpenDeliverable,
}: {
  r: TaskRunRecord;
  durStr: string;
  index: number;
  total: number;
  onOpenDeliverable: (deliverableId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useLocale();
  const isLong = (r.result ?? '').length > 300;

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.02)' }}
    >
      {/* meta row */}
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3"
        style={{ borderBottom: r.result ? '1px solid rgba(255,255,255,0.06)' : undefined }}
      >
        <span className="text-xs text-slate-500 font-medium">#{total - index}</span>
        <Badge variant={r.ok ? 'green' : 'red'}>{r.ok ? 'OK' : 'Error'}</Badge>
        <span className="text-xs text-slate-400">{new Date(r.startedAt).toLocaleString()}</span>
        <span className="text-xs text-slate-500 font-mono">{durStr}</span>
        {r.deliverableId && (
          <button
            className="text-xs text-cyan-300 hover:text-cyan-200"
            onClick={() => onOpenDeliverable(r.deliverableId ?? '')}
          >
            {t('deliverables.open')}
          </button>
        )}
        {(r.workflowId ?? r.agentId) && (
          <span className="text-xs text-slate-600 ml-auto truncate max-w-[200px]">
            {r.workflowId ? `⚡ ${r.workflowId}` : r.agentId}
          </span>
        )}
      </div>

      {/* result body */}
      {r.result ? (
        <div className="relative">
          <pre
            className="px-4 py-3 text-xs text-slate-300 font-mono whitespace-pre-wrap break-all leading-relaxed"
            style={{
              maxHeight: expanded ? '600px' : '120px',
              overflowY: expanded ? 'auto' : 'hidden',
              transition: 'max-height 0.2s ease',
            }}
          >
            {r.result}
          </pre>

          {/* fade + toggle — shown when content is long */}
          {isLong && !expanded && (
            <div
              className="absolute bottom-0 left-0 right-0 h-10 flex items-end justify-center pb-1"
              style={{ background: 'linear-gradient(to bottom, transparent, rgba(15,23,42,0.95))' }}
            >
              <button
                className="text-[11px] text-indigo-400 hover:text-indigo-300 font-medium transition-colors"
                onClick={() => setExpanded(true)}
              >
                {t('scheduler.showResult')}
              </button>
            </div>
          )}
          {isLong && expanded && (
            <div
              className="flex justify-center py-1.5"
              style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
            >
              <button
                className="text-[11px] text-slate-500 hover:text-slate-300 font-medium transition-colors"
                onClick={() => setExpanded(false)}
              >
                {t('scheduler.collapseResult')}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="px-4 py-3 text-xs text-slate-600 italic">{t('scheduler.historyModal.noOutput')}</div>
      )}
    </div>
  );
}

export function SchedulerTab() {
  const { toast } = useToast();
  const { t } = useLocale();
  const [taskModal, setTaskModal] = useState<TaskModalState | null>(null);
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [historyModal, setHistoryModal] = useState<{
    task: TaskInfo;
    records: TaskRunRecord[];
    loading: boolean;
  } | null>(null);
  const [runningTasks, setRunningTasks] = useState<RunningTaskInfo[]>([]);
  const [nowTs, setNowTs] = useState(Date.now());
  const [deliverableId, setDeliverableId] = useState<string | null>(null);

  const {
    data: schedulerResult,
    loading,
    error,
    refetch,
  } = useQuery<SchedulerListResult>(() => rpc<SchedulerListResult>('scheduler.list'), []);
  const { data: agentResult } = useQuery<AgentListResult>(
    () => rpc<AgentListResult>('agent.list'),
    [],
  );
  const { data: workflowResult } = useQuery<{ workflows: WorkflowDef[] }>(
    () => rpc<{ workflows: WorkflowDef[] }>('workflow.list'),
    [],
  );
  const { data: configResult } = useQuery<ChannelsConfigResult>(
    () => rpc<ChannelsConfigResult>('config.get'),
    [],
  );
  const { data: channelResult } = useQuery<ChannelListResult>(
    () => rpc<ChannelListResult>('channel.list'),
    [],
  );

  // Poll running tasks every 3 s
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await rpc<{ running: RunningTaskInfo[] }>('scheduler.running');
        if (!cancelled) setRunningTasks(res.running ?? []);
      } catch {
        /* ignore */
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Live elapsed-time ticker
  useEffect(() => {
    const ticker = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(ticker);
  }, []);

  const tasks: TaskInfo[] = Array.isArray(schedulerResult?.tasks) ? schedulerResult.tasks : [];
  const agents: AgentInfo[] = Array.isArray(agentResult?.agents) ? agentResult.agents : [];
  const workflows: WorkflowDef[] = workflowResult?.workflows ?? [];
  const channels: ChannelInfo[] = channelResult?.channels ?? [];
  const defaultAgentId = preferredExecutionAgentId(agents);
  const defaultOutputChannel =
    configResult?.channels?.defaults?.schedulerOutput ??
    configResult?.channels?.defaults?.output ??
    'logs';

  const sortedTasks = useMemo(
    () =>
      [...tasks].sort(
        (a, b) =>
          (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER),
      ),
    [tasks],
  );
  const taskModalAgentAdvisory = useMemo(() => {
    if (!taskModal || taskModal.form.targetType !== 'agent') {
      return null;
    }
    return buildSchedulerAgentAdvisory(taskModal.form.agentId, agents);
  }, [agents, taskModal]);

  const openHistory = async (task: TaskInfo) => {
    setHistoryModal({ task, records: [], loading: true });
    try {
      const res = await rpc<TaskHistoryResult>('scheduler.history', { taskId: task.id });
      setHistoryModal({ task, records: res.records, loading: false });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to load history', 'error');
      setHistoryModal(null);
    }
  };

  const openCreate = () => {
    const hasTargets = defaultAgentId || workflows.length > 0;
    if (!hasTargets) {
      toast('No available agent or workflow. Please create one first.', 'error');
      return;
    }
    const form = defaultTaskForm(defaultAgentId);
    form.outputChannel = defaultOutputChannel;
    if (!defaultAgentId && workflows.length > 0) {
      form.targetType = 'workflow';
      form.workflowId = workflows[0]?.id ?? '';
    }
    setTaskModal({ mode: 'add', form });
    setPreview(null);
  };

  const openEdit = (task: TaskInfo) => {
    setTaskModal({
      mode: 'edit',
      taskId: task.id,
      form: {
        name: task.name,
        targetType: task.workflowId ? 'workflow' : 'agent',
        agentId: task.agentId ?? '',
        workflowId: task.workflowId ?? '',
        message: task.message,
        scheduleMode: guessScheduleMode(task),
        cronExpr: task.cronExpr,
        intervalMinutes: 60,
        reportTo: task.reportTo ?? '',
        outputChannel: task.outputChannel ?? defaultOutputChannel,
        publicationTargets: task.publicationTargets ?? [],
        enabled: task.enabled !== false,
      },
    });
    setPreview(null);
  };

  useEffect(() => {
    if (!taskModal) {
      setPreview(null);
      return;
    }

    const timeout = setTimeout(() => {
      setPreviewLoading(true);
      void rpc<SchedulePreview>('scheduler.preview', {
        cronExpr: taskModal.form.scheduleMode === 'cron' ? taskModal.form.cronExpr : undefined,
        intervalMinutes:
          taskModal.form.scheduleMode === 'interval' ? taskModal.form.intervalMinutes : undefined,
      })
        .then((res) => setPreview(res))
        .catch((e) =>
          setPreview({
            valid: false,
            cronExpr:
              taskModal.form.scheduleMode === 'cron'
                ? taskModal.form.cronExpr
                : `every ${taskModal.form.intervalMinutes} min`,
            error: e instanceof Error ? e.message : String(e),
          }),
        )
        .finally(() => setPreviewLoading(false));
    }, 250);

    return () => clearTimeout(timeout);
  }, [taskModal]);

  const submitTask = async () => {
    if (!taskModal) return;
    const f = taskModal.form;
    if (!f.name.trim() || !f.message.trim()) {
      toast('name and message are required', 'error');
      return;
    }
    if (f.targetType === 'agent' && !f.agentId) {
      toast('Please select an agent', 'error');
      return;
    }
    if (f.targetType === 'workflow' && !f.workflowId) {
      toast('Please select a workflow', 'error');
      return;
    }
    if (!preview || !preview.valid) {
      toast('Schedule is invalid. Please fix cron/interval first.', 'error');
      return;
    }

    const targetParams =
      f.targetType === 'workflow'
        ? { workflowId: f.workflowId, agentId: undefined }
        : { agentId: f.agentId, workflowId: undefined };

    try {
      if (taskModal.mode === 'add') {
        await rpc('scheduler.create', {
          name: f.name.trim(),
          ...targetParams,
          message: f.message.trim(),
          cronExpr: f.scheduleMode === 'cron' ? f.cronExpr.trim() : undefined,
          intervalMinutes: f.scheduleMode === 'interval' ? f.intervalMinutes : undefined,
          reportTo: f.reportTo || undefined,
          outputChannel: f.outputChannel,
          publicationTargets: f.publicationTargets,
          enabled: f.enabled,
        });
        toast('Task created', 'success');
      } else {
        await rpc('scheduler.update', {
          taskId: taskModal.taskId,
          name: f.name.trim(),
          ...targetParams,
          message: f.message.trim(),
          cronExpr: f.scheduleMode === 'cron' ? f.cronExpr.trim() : undefined,
          intervalMinutes: f.scheduleMode === 'interval' ? f.intervalMinutes : undefined,
          reportTo: f.reportTo || undefined,
          outputChannel: f.outputChannel,
          publicationTargets: f.publicationTargets,
          enabled: f.enabled,
        });
        toast('Task updated', 'success');
      }
      setTaskModal(null);
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Save failed', 'error');
    }
  };

  const runNow = async (taskId: string) => {
    try {
      await rpc('scheduler.runNow', { taskId });
      toast('Task executed', 'success');
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Run failed', 'error');
    }
  };

  const removeTask = async (taskId: string) => {
    try {
      await rpc('scheduler.cancel', { taskId });
      toast('Task deleted', 'success');
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Delete failed', 'error');
    } finally {
      setConfirmState(null);
    }
  };

  const toggleEnabled = async (task: TaskInfo) => {
    try {
      await rpc('scheduler.update', {
        taskId: task.id,
        enabled: task.enabled === false,
      });
      toast(task.enabled === false ? 'Task enabled' : 'Task disabled', 'success');
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Update failed', 'error');
    }
  };

  if (loading && !schedulerResult)
    return <div className="text-slate-400 text-sm p-8">{t('common.loading')}</div>;
  if (error) return <div className="text-red-400 text-sm p-8">Error: {error}</div>;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">{t('scheduler.title')}</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {t('scheduler.subtitle')}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <Badge variant="blue">
            {t(tasks.length !== 1 ? 'scheduler.tasksPlural' : 'scheduler.tasks', { n: String(tasks.length) })}
          </Badge>
          <Button size="sm" variant="ghost" onClick={refetch}>
            {t('scheduler.refresh')}
          </Button>
          <Button size="sm" variant="primary" onClick={openCreate}>
            {t('scheduler.newTask')}
          </Button>
        </div>
      </div>

      {/* ── Running Now ─────────────────────────────────────────────────── */}
      {runningTasks.length > 0 && (
        <div
          className="rounded-xl overflow-hidden"
          style={{ border: '1px solid rgba(99,102,241,0.3)', background: 'rgba(99,102,241,0.05)' }}
        >
          <div
            className="px-4 py-2.5 flex items-center gap-2"
            style={{ borderBottom: '1px solid rgba(99,102,241,0.15)' }}
          >
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-[11px] font-semibold text-indigo-300 uppercase tracking-wider">
              {t('scheduler.runningNow')}
            </span>
            <span className="ml-auto text-xs text-indigo-400">{t('scheduler.active', { n: String(runningTasks.length) })}</span>
          </div>
          <div
            className="divide-y"
            style={
              {
                '--tw-divide-opacity': 1,
                borderColor: 'rgba(99,102,241,0.1)',
              } as React.CSSProperties
            }
          >
            {runningTasks.map((rt) => {
              const elapsedSec = Math.floor((nowTs - rt.startedAt) / 1000);
              const mins = Math.floor(elapsedSec / 60);
              const secs = elapsedSec % 60;
              return (
                <div
                  key={rt.taskId}
                  className="px-4 py-3 flex items-center gap-4"
                  style={{ borderTop: '1px solid rgba(99,102,241,0.1)' }}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium text-slate-200">{rt.taskName}</span>
                    <span className="ml-2 text-xs text-slate-500">
                      {rt.workflowId ? `⚡ ${rt.workflowId}` : describeAgentTarget(rt.agentId, agents)}
                    </span>
                  </div>
                  <span className="text-xs text-emerald-400 font-mono shrink-0">
                    {mins > 0 ? `${mins}m ` : ''}
                    {String(secs).padStart(2, '0')}s
                  </span>
                  <span className="text-xs text-slate-500 shrink-0">
                    started {new Date(rt.startedAt).toLocaleTimeString()}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {sortedTasks.length === 0 ? (
        <div className="text-slate-500 text-sm py-4">{t('scheduler.noTasks')}</div>
      ) : (
        <div className="rounded-xl bg-slate-800/60 ring-1 ring-slate-700/50 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-700/50">
              <tr className="text-left">
                <th className="px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">
                  {t('scheduler.col.task')}
                </th>
                <th className="px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">
                  {t('scheduler.col.target')}
                </th>
                <th className="px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">
                  {t('scheduler.col.schedule')}
                </th>
                <th className="px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">
                  {t('scheduler.col.output')}
                </th>
                <th className="px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">
                  {t('scheduler.col.status')}
                </th>
                <th className="px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">
                  {t('scheduler.col.next')}
                </th>
                <th className="px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">
                  {t('scheduler.col.lastResult')}
                </th>
                <th className="px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">
                  {t('scheduler.col.actions')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {sortedTasks.map((task) => (
                <tr key={task.id} className="hover:bg-slate-700/20 transition-colors align-top">
                  <td className="px-4 py-3 text-slate-200">
                    <div className="font-medium">{task.name}</div>
                    <div className="text-xs text-slate-500 mt-1 line-clamp-2">{task.message}</div>
                    {task.reportTo && (
                      <div className="text-xs text-slate-500 mt-1">report to: {task.reportTo}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-400 font-mono text-xs">
                    <div className="flex flex-col gap-1">
                      {task.workflowId ? (
                        <span className="text-purple-400">
                          ⚡ {workflows.find((w) => w.id === task.workflowId)?.name ?? task.workflowId}
                        </span>
                      ) : (
                        <span>{describeAgentTarget(task.agentId, agents)}</span>
                      )}
                      {renderTaskAdvisory(task)}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <code className="text-xs bg-slate-700/60 px-1.5 py-0.5 rounded text-slate-300 font-mono">
                      {task.cronExpr}
                    </code>
                    <div className="text-xs text-slate-500 mt-1">runs: {task.runCount}</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-300">
                    {task.outputChannel ?? defaultOutputChannel}
                    <div className="text-slate-500 mt-1">
                      {task.publicationChannels && task.publicationChannels.length > 0
                        ? t('scheduler.publicationCount', {
                            n: String(task.publicationTargets?.length ?? task.publicationChannels.length),
                          })
                        : task.publicationTargets && task.publicationTargets.length > 0
                        ? t('scheduler.publicationCount', {
                            n: String(task.publicationTargets.length),
                          })
                        : t('scheduler.publicationAuto')}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={task.enabled === false ? 'yellow' : 'green'}>
                      {task.enabled === false ? 'disabled' : 'enabled'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-slate-400 text-xs">
                    {task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400 max-w-[360px]">
                    <div className="line-clamp-3">{task.lastResult ?? '—'}</div>
                    <div className="text-slate-500 mt-1">
                      {task.lastRunAt ? new Date(task.lastRunAt).toLocaleString() : ''}
                    </div>
                    {task.latestDeliverableId && (
                      <button
                        className="mt-2 text-xs text-cyan-300 hover:text-cyan-200"
                        onClick={() => setDeliverableId(task.latestDeliverableId ?? null)}
                      >
                        {t('deliverables.open')}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(task)}>
                        {t('scheduler.edit')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void runNow(task.id)}>
                        {t('scheduler.runNow')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void openHistory(task)}>
                        {t('scheduler.history')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void toggleEnabled(task)}>
                        {task.enabled === false ? t('scheduler.enable') : t('scheduler.disable')}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() =>
                          setConfirmState({
                            title: t('scheduler.confirm.deleteTitle'),
                            message: t('scheduler.confirm.deleteMsg', { name: task.name }),
                            onConfirm: () => removeTask(task.id),
                          })
                        }
                      >
                        {t('scheduler.delete')}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {taskModal && (
        <FormModal
          title={taskModal.mode === 'add' ? t('scheduler.modal.createTitle') : t('scheduler.modal.editTitle')}
          description={t('scheduler.modal.description')}
          onClose={() => setTaskModal(null)}
          onSubmit={() => void submitTask()}
        >
          <Field label="Task Name">
            <input
              value={taskModal.form.name}
              onChange={(e) =>
                setTaskModal({ ...taskModal, form: { ...taskModal.form, name: e.target.value } })
              }
              className="bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-lg px-2.5 py-2"
            />
          </Field>

          <Field label={t('scheduler.modal.targetType')}>
            <div className="flex gap-3">
              <label className="text-xs text-slate-300 inline-flex items-center gap-2">
                <input
                  type="radio"
                  checked={taskModal.form.targetType === 'agent'}
                  onChange={() =>
                    setTaskModal({ ...taskModal, form: { ...taskModal.form, targetType: 'agent' } })
                  }
                  className="accent-indigo-500"
                />
                Agent
              </label>
              <label className="text-xs text-slate-300 inline-flex items-center gap-2">
                <input
                  type="radio"
                  checked={taskModal.form.targetType === 'workflow'}
                  onChange={() =>
                    setTaskModal({
                      ...taskModal,
                      form: { ...taskModal.form, targetType: 'workflow' },
                    })
                  }
                  className="accent-indigo-500"
                />
                Workflow
              </label>
            </div>
          </Field>

          {taskModal.form.targetType === 'agent' && (
            <Field label="Agent">
              <div className="flex flex-col gap-2">
                <select
                  value={taskModal.form.agentId}
                  onChange={(e) =>
                    setTaskModal({
                      ...taskModal,
                      form: { ...taskModal.form, agentId: e.target.value },
                    })
                  }
                  className="bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-lg px-2.5 py-2"
                >
                  {agents.map((a) => (
                    <option key={a.agentId} value={a.agentId}>
                      {formatAgentLabel(a)}
                    </option>
                  ))}
                </select>
                {taskModalAgentAdvisory && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 leading-relaxed">
                    {taskModalAgentAdvisory}
                  </div>
                )}
              </div>
            </Field>
          )}

          {taskModal.form.targetType === 'workflow' && (
            <Field label="Workflow">
              <select
                value={taskModal.form.workflowId}
                onChange={(e) =>
                  setTaskModal({
                    ...taskModal,
                    form: { ...taskModal.form, workflowId: e.target.value },
                  })
                }
                className="bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-lg px-2.5 py-2"
              >
                <option value="">{t('scheduler.modal.selectWorkflow')}</option>
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Schedule Mode">
            <div className="flex gap-3">
              <label className="text-xs text-slate-300 inline-flex items-center gap-2">
                <input
                  type="radio"
                  checked={taskModal.form.scheduleMode === 'cron'}
                  onChange={() =>
                    setTaskModal({
                      ...taskModal,
                      form: { ...taskModal.form, scheduleMode: 'cron' },
                    })
                  }
                  className="accent-indigo-500"
                />
                Cron
              </label>
              <label className="text-xs text-slate-300 inline-flex items-center gap-2">
                <input
                  type="radio"
                  checked={taskModal.form.scheduleMode === 'interval'}
                  onChange={() =>
                    setTaskModal({
                      ...taskModal,
                      form: { ...taskModal.form, scheduleMode: 'interval' },
                    })
                  }
                  className="accent-indigo-500"
                />
                Interval Minutes
              </label>
            </div>
          </Field>

          {taskModal.form.scheduleMode === 'cron' ? (
            <Field label="Cron Expression">
              <input
                value={taskModal.form.cronExpr}
                onChange={(e) =>
                  setTaskModal({
                    ...taskModal,
                    form: { ...taskModal.form, cronExpr: e.target.value },
                  })
                }
                className="bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-lg px-2.5 py-2 font-mono"
              />
            </Field>
          ) : (
            <Field label="Interval Minutes">
              <input
                type="number"
                min={1}
                value={taskModal.form.intervalMinutes}
                onChange={(e) =>
                  setTaskModal({
                    ...taskModal,
                    form: { ...taskModal.form, intervalMinutes: Number(e.target.value) },
                  })
                }
                className="bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-lg px-2.5 py-2"
              />
            </Field>
          )}

          <Field label="Validation / Next Run">
            <div className="text-xs">
              {previewLoading && <span className="text-slate-400">Validating schedule…</span>}
              {!previewLoading && preview?.valid && (
                <div className="text-emerald-300">
                  Valid schedule: <span className="font-mono">{preview.cronExpr}</span>
                  <div className="text-slate-400 mt-1">
                    Next run:{' '}
                    {preview.nextRunAt ? new Date(preview.nextRunAt).toLocaleString() : 'n/a'}
                  </div>
                </div>
              )}
              {!previewLoading && preview && !preview.valid && (
                <div className="text-red-300">
                  Invalid schedule
                  {preview.error ? <div className="text-red-400 mt-1">{preview.error}</div> : null}
                </div>
              )}
            </div>
          </Field>

          <Field label="Report To (Optional)">
            <select
              value={taskModal.form.reportTo}
              onChange={(e) =>
                setTaskModal({
                  ...taskModal,
                  form: { ...taskModal.form, reportTo: e.target.value },
                })
              }
              className="bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-lg px-2.5 py-2"
            >
              <option value="">(none)</option>
              {agents.map((a) => (
                <option key={a.agentId} value={a.agentId}>
                  {formatAgentLabel(a)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Output Channel">
            <select
              value={taskModal.form.outputChannel}
              onChange={(e) =>
                setTaskModal({
                  ...taskModal,
                  form: {
                    ...taskModal.form,
                    outputChannel: e.target.value as 'logs' | 'cli' | 'web',
                  },
                })
              }
              className="bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-lg px-2.5 py-2"
            >
              <option value="logs">logs (default)</option>
              <option value="cli">cli</option>
              <option value="web">web</option>
            </select>
          </Field>

          <Field label={t('scheduler.modal.publicationChannels')}>
            <div className="rounded-xl bg-slate-800/50 border border-slate-700/60 p-3 flex flex-col gap-2">
              <p className="text-xs text-slate-400">{t('scheduler.modal.publicationHint')}</p>
              {channels.length === 0 ? (
                <span className="text-xs text-slate-500">{t('scheduler.modal.noChannels')}</span>
              ) : (
                <>
                  {taskModal.form.publicationTargets.map((target, index) => (
                    <div
                      key={`${target.channelId}:${target.threadKey}:${index}`}
                      className="grid grid-cols-[minmax(0,150px)_minmax(0,1fr)_minmax(0,160px)_auto] gap-2 items-center"
                    >
                      <select
                        value={target.channelId}
                        onChange={(e) =>
                          setTaskModal({
                            ...taskModal,
                            form: {
                              ...taskModal.form,
                              publicationTargets: taskModal.form.publicationTargets.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, channelId: e.target.value } : item,
                              ),
                            },
                          })
                        }
                        className="bg-slate-900/50 border border-slate-700 text-slate-200 text-xs rounded-lg px-2.5 py-2"
                      >
                        {channels.map((channel) => (
                          <option key={channel.id} value={channel.id}>
                            {channel.name}
                          </option>
                        ))}
                      </select>
                      <input
                        value={target.threadKey}
                        onChange={(e) =>
                          setTaskModal({
                            ...taskModal,
                            form: {
                              ...taskModal.form,
                              publicationTargets: taskModal.form.publicationTargets.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, threadKey: e.target.value } : item,
                              ),
                            },
                          })
                        }
                        placeholder="threadKey"
                        className="bg-slate-900/50 border border-slate-700 text-slate-200 text-xs rounded-lg px-2.5 py-2 font-mono"
                      />
                      <input
                        value={target.agentId ?? ''}
                        onChange={(e) =>
                          setTaskModal({
                            ...taskModal,
                            form: {
                              ...taskModal.form,
                              publicationTargets: taskModal.form.publicationTargets.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, agentId: e.target.value || undefined }
                                  : item,
                              ),
                            },
                          })
                        }
                        placeholder="agentId (optional)"
                        className="bg-slate-900/50 border border-slate-700 text-slate-200 text-xs rounded-lg px-2.5 py-2"
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setTaskModal({
                            ...taskModal,
                            form: {
                              ...taskModal.form,
                              publicationTargets: taskModal.form.publicationTargets.filter(
                                (_, itemIndex) => itemIndex !== index,
                              ),
                            },
                          })
                        }
                      >
                        {t('common.delete')}
                      </Button>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setTaskModal({
                        ...taskModal,
                        form: {
                          ...taskModal.form,
                          publicationTargets: [
                            ...taskModal.form.publicationTargets,
                            {
                              channelId: channels[0]?.id ?? '',
                              threadKey: '',
                            },
                          ],
                        },
                      })
                    }
                  >
                    + Add Target
                  </Button>
                  {taskModal.form.publicationTargets.map((target) => {
                    const channel = channels.find((item) => item.id === target.channelId);
                    if (!channel) return null;
                    return (
                      <div
                        key={`${target.channelId}:${target.threadKey}:hint`}
                        className="text-[11px] text-slate-500"
                      >
                        {channel.name} · {formatPublicationLabel(channel, t)}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </Field>

          <Field label="Enabled">
            <label className="text-xs text-slate-300 inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={taskModal.form.enabled}
                onChange={(e) =>
                  setTaskModal({
                    ...taskModal,
                    form: { ...taskModal.form, enabled: e.target.checked },
                  })
                }
                className="accent-indigo-500"
              />
              Active after save
            </label>
          </Field>

          <Field label="Task Message">
            <textarea
              value={taskModal.form.message}
              onChange={(e) =>
                setTaskModal({ ...taskModal, form: { ...taskModal.form, message: e.target.value } })
              }
              rows={6}
              className="bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded-lg px-2.5 py-2 font-mono"
            />
          </Field>
        </FormModal>
      )}

      {confirmState && <ConfirmModal state={confirmState} onClose={() => setConfirmState(null)} />}

      {/* ── History Modal ──────────────────────────────────────────── */}
      {historyModal &&
        createPortal(
          <div
            className="fixed inset-0 z-[220] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={(e) => {
              if (e.target === e.currentTarget) setHistoryModal(null);
            }}
          >
            <div className="w-full max-w-4xl max-h-[88vh] flex flex-col rounded-2xl bg-slate-900 ring-1 ring-slate-700">
              {/* header — fixed */}
              <div
                className="flex items-start justify-between shrink-0 px-5 pt-5 pb-4"
                style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}
              >
                <div>
                  <h3 className="text-base font-semibold text-slate-100">{t('scheduler.historyModal.title')}</h3>
                  <p className="text-xs text-slate-400 mt-0.5">{historyModal.task.name}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setHistoryModal(null)}>
                  {t('common.close')}
                </Button>
              </div>

              {/* scrollable body */}
              <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
                {historyModal.loading && (
                  <div className="flex items-center gap-2 text-sm text-slate-400 py-6">
                    <div className="w-3.5 h-3.5 rounded-full border-2 border-indigo-500/30 border-t-indigo-400 animate-spin" />
                    {t('scheduler.historyModal.loading')}
                  </div>
                )}

                {!historyModal.loading && historyModal.records.length === 0 && (
                  <div className="text-slate-500 text-sm py-6">
                    {t('scheduler.historyModal.noRecords')}
                  </div>
                )}

                {!historyModal.loading &&
                  historyModal.records.map((r, i) => {
                    const durMs = r.finishedAt - r.startedAt;
                    const durStr =
                      durMs >= 60000
                        ? `${Math.floor(durMs / 60000)}m ${Math.floor((durMs % 60000) / 1000)}s`
                        : `${Math.floor(durMs / 1000)}s`;
                    return (
                      <HistoryRecordCard
                        key={i}
                        r={r}
                        durStr={durStr}
                        index={i}
                        total={historyModal.records.length}
                        onOpenDeliverable={setDeliverableId}
                      />
                    );
                  })}
              </div>
            </div>
          </div>,
          document.body,
        )}

      {deliverableId && (
        <DeliverableModal deliverableId={deliverableId} onClose={() => setDeliverableId(null)} />
      )}
    </div>
  );
}
