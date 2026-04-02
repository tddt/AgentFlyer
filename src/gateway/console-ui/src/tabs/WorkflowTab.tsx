/**
 * WorkflowTab — workflow list view and view-switcher.
 *
 * Delegates editing to WorkflowEditor, execution to WorkflowRunPanel,
 * and history to WorkflowHistoryPanel. Workflows are server-side persisted.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { useLocale } from '../context/i18n.js';
import { rpc, useQuery } from '../hooks/useRpc.js';
import { useToast } from '../hooks/useToast.js';
import type {
  AgentListResult,
  ChannelInfo,
  ChannelListResult,
  SchedulerListResult,
  TaskInfo,
  WorkflowDef,
  WorkflowRunRecord,
} from '../types.js';
import { WorkflowEditor } from './WorkflowEditor.js';
import { WorkflowHistoryPanel } from './WorkflowHistoryPanel.js';
import { WorkflowRunPanel } from './WorkflowRunPanel.js';

type ViewMode = 'list' | 'edit' | 'run' | 'history';

export function WorkflowTab() {
  const { toast } = useToast();
  const { t } = useLocale();

  const [view, setView] = useState<ViewMode>('list');
  const [editTarget, setEditTarget] = useState<WorkflowDef | null>(null);
  const [runTarget, setRunTarget] = useState<WorkflowDef | null>(null);
  const [initialRunId, setInitialRunId] = useState<string | undefined>(undefined);
  // Polled from server — drives "running" badges on cards and the top banner
  const [runningRuns, setRunningRuns] = useState<Map<string, WorkflowRunRecord>>(new Map());
  const autoRestoredRef = useRef(false);

  const { data: workflowsData, refetch: refetchWorkflows } = useQuery<{
    workflows: WorkflowDef[];
  }>(() => rpc<{ workflows: WorkflowDef[] }>('workflow.list'), []);
  const workflows = workflowsData?.workflows ?? [];

  const { data: agentsData } = useQuery<AgentListResult>(
    () => rpc<AgentListResult>('agent.list'),
    [],
  );
  const agents = agentsData?.agents ?? [];

  const { data: schedulerData } = useQuery<SchedulerListResult>(
    () => rpc<SchedulerListResult>('scheduler.list'),
    [],
  );
  const { data: channelData } = useQuery<ChannelListResult>(
    () => rpc<ChannelListResult>('channel.list'),
    [],
  );
  const scheduledTasks: TaskInfo[] = schedulerData?.tasks ?? [];
  const channels: ChannelInfo[] = channelData?.channels ?? [];

  // First currently-running workflow + its def — drives the top banner
  const activeRunBanner = useMemo(() => {
    const firstRun = Array.from(runningRuns.values())[0];
    if (!firstRun) return null;
    const wf = (workflowsData?.workflows ?? []).find((w) => w.id === firstRun.workflowId);
    return wf ? { run: firstRun, wf } : null;
  }, [runningRuns, workflowsData]);

  // Poll workflow.history every 3s while in list view to keep runningRuns in sync.
  // This enables page-refresh recovery: active runs appear as badges/banner immediately.
  useEffect(() => {
    if (view !== 'list') return;
    let cancelled = false;

    const fetchRunning = async () => {
      try {
        const result = await rpc<{ runs: WorkflowRunRecord[] }>('workflow.history');
        if (cancelled) return;
        const map = new Map<string, WorkflowRunRecord>();
        for (const run of result.runs) {
          if (run.status === 'running' && !map.has(run.workflowId)) {
            map.set(run.workflowId, run);
          }
        }
        setRunningRuns(map);
      } catch {
        // Ignore transient network errors
      }
    };

    void fetchRunning();
    const tid = setInterval(() => {
      void fetchRunning();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(tid);
    };
  }, [view]);

  // Auto-restore run panel after page refresh if a workflow was actively running
  useEffect(() => {
    if (autoRestoredRef.current || view !== 'list' || runningRuns.size === 0) return;
    const wfs = workflowsData?.workflows ?? [];
    if (!wfs.length) return;
    autoRestoredRef.current = true;
    const firstRun = Array.from(runningRuns.values())[0];
    if (!firstRun) return;
    const wf = wfs.find((w) => w.id === firstRun.workflowId);
    if (wf) {
      setInitialRunId(firstRun.runId);
      setRunTarget(wf);
      setView('run');
    }
  }, [runningRuns, workflowsData, view]);

  const handleSave = async (w: WorkflowDef) => {
    try {
      await rpc('workflow.save', w);
      refetchWorkflows();
      setView('list');
      toast(`Workflow "${w.name}" saved`, 'success');
    } catch (e) {
      toast(`Save failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await rpc('workflow.delete', { workflowId: id });
      refetchWorkflows();
      toast('Workflow deleted', 'success');
    } catch (e) {
      toast(`Delete failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  if (view === 'edit') {
    return (
      <WorkflowEditor
        workflow={editTarget}
        agents={agents}
        channels={channels}
        onSave={(w) => void handleSave(w)}
        onCancel={() => setView('list')}
      />
    );
  }

  if (view === 'run' && runTarget) {
    return (
      <WorkflowRunPanel
        workflow={runTarget}
        agents={agents}
        initialRunId={initialRunId}
        onClose={() => {
          setInitialRunId(undefined);
          setView('list');
        }}
      />
    );
  }

  if (view === 'history') {
    return (
      <WorkflowHistoryPanel workflows={workflows} agents={agents} onClose={() => setView('list')} />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">{t('workflow.title')}</h1>
          <p className="text-xs text-slate-500 mt-0.5">{t('workflow.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setView('history')}>
            {t('workflow.history')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setEditTarget(null);
              setView('edit');
            }}
          >
            {t('workflow.newWorkflow')}
          </Button>
        </div>
      </div>

      {activeRunBanner && (
        <div className="rounded-xl bg-yellow-600/10 ring-1 ring-yellow-500/30 px-4 py-3 flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-sm text-yellow-300 font-medium">{activeRunBanner.wf.name}</span>
            <span className="text-xs text-slate-500 ml-2 font-mono truncate">
              {activeRunBanner.run.runId}
            </span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setInitialRunId(activeRunBanner.run.runId);
              setRunTarget(activeRunBanner.wf);
              setView('run');
            }}
          >
            {t('workflow.viewArrow')}
          </Button>
        </div>
      )}

      {workflows.length === 0 && (
        <div className="rounded-xl bg-slate-800/40 ring-1 ring-slate-700/50 p-10 flex flex-col items-center gap-3">
          <span className="text-4xl">⚡</span>
          <p className="text-slate-400 text-sm">{t('workflow.noWorkflows')}</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditTarget(null);
              setView('edit');
            }}
          >
            {t('workflow.createFirst')}
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {workflows.map((w) => {
          const schedCount = scheduledTasks.filter((t) => t.workflowId === w.id).length;
          return (
            <div
              key={w.id}
              className="rounded-xl bg-slate-800/60 ring-1 ring-slate-700/50 p-4 flex flex-col gap-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-semibold text-slate-100">{w.name}</span>
                  {w.description && <span className="text-xs text-slate-500">{w.description}</span>}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {runningRuns.has(w.id) && (
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-yellow-600/20 ring-1 ring-yellow-500/40 text-yellow-300 animate-pulse">
                      {t('workflow.running')}
                    </span>
                  )}
                  {schedCount > 0 && (
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-purple-600/20 ring-1 ring-purple-500/40 text-purple-300">
                      ⏰ {schedCount}
                    </span>
                  )}
                  {(w.publicationTargets?.length || w.publicationChannels?.length) && (
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-cyan-600/20 ring-1 ring-cyan-500/40 text-cyan-300">
                      ↗ {w.publicationTargets?.length ?? w.publicationChannels?.length}
                    </span>
                  )}
                  <Badge variant="gray">{t('workflow.steps', { n: String(w.steps.length) })}</Badge>
                </div>
              </div>

              <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                {w.steps.map((s, i) => (
                  <div key={s.id} className="flex items-center gap-1.5 shrink-0">
                    <div className="rounded-md px-2 py-1 text-[11px] bg-indigo-600/15 ring-1 ring-indigo-500/30 text-indigo-300">
                      {(s.label ??
                        agents.find((a) => a.agentId === s.agentId)?.name ??
                        s.agentId) ||
                        `${t('workflow.run.step', { n: String(i + 1) })}`}
                    </div>
                    {i < w.steps.length - 1 && <span className="text-slate-700 text-xs">→</span>}
                  </div>
                ))}
              </div>

              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    const existing = runningRuns.get(w.id);
                    setInitialRunId(existing?.runId);
                    setRunTarget(w);
                    setView('run');
                  }}
                >
                  {runningRuns.has(w.id) ? t('workflow.viewRun') : t('workflow.run')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditTarget(w);
                    setView('edit');
                  }}
                >
                  {t('workflow.edit')}
                </Button>
                <Button size="sm" variant="danger" onClick={() => void handleDelete(w.id)}>
                  {t('workflow.delete')}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
