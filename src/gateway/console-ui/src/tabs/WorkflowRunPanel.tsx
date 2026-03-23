/**
 * WorkflowRunPanel — panel that starts a server-side workflow run and polls
 * workflow.runStatus every 500ms for live step output.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { MarkdownView } from '../components/MarkdownView.js';
import { useWorkflowRun } from '../context/workflow-run.js';
import { rpc } from '../hooks/useRpc.js';
import { useToast } from '../hooks/useToast.js';
import type { WorkflowDef, WorkflowRunRecord } from '../types.js';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Returns vars that are new or changed compared to the previous snapshot */
function diffSnapshot(
  current: Record<string, string> | undefined,
  prev: Record<string, string> | undefined,
): Record<string, string> {
  if (!current || Object.keys(current).length === 0) return {};
  if (!prev) return { ...current };
  const delta: Record<string, string> = {};
  for (const [k, v] of Object.entries(current)) {
    if (!(k in prev) || prev[k] !== v) delta[k] = v;
  }
  return delta;
}

export function WorkflowRunPanel({
  workflow,
  agents,
  onClose,
  initialRunId,
}: {
  workflow: WorkflowDef;
  agents: { agentId: string; name?: string }[];
  onClose: () => void;
  /** If provided, skip the input form and resume polling an existing server-side run. */
  initialRunId?: string;
}) {
  const { toast } = useToast();
  const { setActiveRunRef } = useWorkflowRun();

  const [input, setInput] = useState('');
  const [runId, setRunId] = useState<string | null>(initialRunId ?? null);
  const [run, setRun] = useState<WorkflowRunRecord | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const running = run?.status === 'running';

  // Poll runStatus every 500ms while a run is active
  useEffect(() => {
    if (!runId) return;
    if (run && run.status !== 'running') return;

    const tick = async () => {
      try {
        const status = await rpc<WorkflowRunRecord | null>('workflow.runStatus', { runId });
        if (status) {
          setRun(status);
          if (status.status !== 'running') {
            if (pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
            setActiveRunRef(null);
            if (status.status === 'done') toast('Workflow completed!', 'success');
            else if (status.status === 'cancelled') toast('Workflow cancelled', 'info');
            else if (status.status === 'error') toast('Workflow stopped with error', 'error');
          }
        }
      } catch {
        // Silently ignore transient network errors during polling
      }
    };

    void tick();
    pollRef.current = setInterval(() => {
      void tick();
    }, 500);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const startRun = async () => {
    if (running) return;
    // Allow empty input when workflow doesn't require it
    if (workflow.inputRequired !== false && !input.trim()) return;
    try {
      const result = await rpc<{ runId: string }>('workflow.run', {
        workflowId: workflow.id,
        input: input.trim(),
      });
      setRunId(result.runId);
      setRun(null);
      setActiveRunRef({ runId: result.runId, workflowDef: workflow });
    } catch (e) {
      toast(`Failed to start: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const cancelRun = async () => {
    if (!runId) return;
    try {
      await rpc('workflow.cancel', { runId });
    } catch {
      // Status will update via next poll tick
    }
  };

  const agentName = useCallback(
    (agentId: string) => agents.find((a) => a.agentId === agentId)?.name ?? agentId,
    [agents],
  );

  const stepStatus = (
    stepId: string,
    stepIdx: number,
  ): 'pending' | 'running' | 'success' | 'error' => {
    if (!run) return 'pending';
    const sr = run.stepResults.find((r) => r.stepId === stepId);
    if (!sr) {
      return stepIdx === run.stepResults.length && run.status === 'running' ? 'running' : 'pending';
    }
    if (sr.error) return 'error';
    if (sr.output !== undefined) return 'success';
    return 'running';
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Run: {workflow.name}</h2>
          {workflow.description && (
            <p className="text-xs text-slate-500 mt-0.5">{workflow.description}</p>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          ✕ Close
        </Button>
      </div>

      {/* Pipeline step status bar */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {workflow.steps.map((s, i) => {
          const st = stepStatus(s.id, i);
          const color =
            st === 'pending'
              ? 'bg-slate-800 ring-slate-700 text-slate-500'
              : st === 'running'
                ? 'bg-yellow-600/20 ring-yellow-500/40 text-yellow-300 animate-pulse'
                : st === 'success'
                  ? 'bg-emerald-600/20 ring-emerald-500/40 text-emerald-300'
                  : 'bg-red-600/20 ring-red-500/40 text-red-300';
          return (
            <div key={s.id} className="flex items-center gap-1.5 shrink-0">
              <div className={`rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ${color}`}>
                {s.label ?? agentName(s.agentId)}
              </div>
              {i < workflow.steps.length - 1 && <span className="text-slate-600">→</span>}
            </div>
          );
        })}
      </div>

      {/* Input — only shown before first run */}
      {!runId && workflow.inputRequired !== false && (
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-slate-400">初始输入</label>
          <textarea
            rows={3}
            className="rounded-xl bg-slate-900/70 ring-1 ring-slate-700 px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-indigo-500 resize-none"
            placeholder="Enter the initial message / prompt…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>
      )}

      {!runId && workflow.inputRequired === false && (
        <div className="rounded-lg bg-indigo-600/10 ring-1 ring-indigo-500/20 px-3 py-2 text-xs text-indigo-300">
          ℹ️ 此工作流无需初始输入，点击即可直接运行。
        </div>
      )}

      {/* Run ID badge */}
      {runId && (
        <div className="rounded-lg bg-slate-900/50 ring-1 ring-slate-700/50 px-3 py-2 text-xs text-slate-500 font-mono break-all">
          Run ID: {runId}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 items-center">
        {!runId ? (
          <Button size="sm" variant="primary" onClick={() => void startRun()}>
            ▶ Run Workflow
          </Button>
        ) : running ? (
          <>
            <span className="text-xs text-yellow-400 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse inline-block" />
              Running…
            </span>
            <Button size="sm" variant="danger" onClick={() => void cancelRun()}>
              ✕ Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setRunId(null);
              setRun(null);
            }}
          >
            ↩ Run Again
          </Button>
        )}
      </div>

      {/* Step results with live streaming output + variable panel */}
      {run && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
              Results
            </span>
            <Badge
              variant={
                run.status === 'done'
                  ? 'green'
                  : run.status === 'error'
                    ? 'red'
                    : run.status === 'cancelled'
                      ? 'gray'
                      : 'blue'
              }
            >
              {run.status}
            </Badge>
            {run.finishedAt && (
              <span className="text-xs text-slate-600">
                {((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s
              </span>
            )}
          </div>

          {run.stepResults.map((sr, i) => {
            const step = workflow.steps.find((s) => s.id === sr.stepId);
            const stStatus: 'running' | 'success' | 'error' = sr.error
              ? 'error'
              : sr.output !== undefined
                ? 'success'
                : 'running';
            const prevSnap = i > 0 ? run.stepResults[i - 1]?.varsSnapshot : undefined;
            const newVars = diffSnapshot(sr.varsSnapshot, prevSnap);
            return (
              <div
                key={sr.stepId}
                className="rounded-xl bg-slate-900/60 ring-1 ring-slate-700/50 p-4 flex flex-col gap-2"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-slate-500">Step {i + 1}</span>
                  <span className="text-xs text-slate-300">
                    {step?.label ?? agentName(step?.agentId ?? '')}
                  </span>
                  <Badge
                    variant={
                      stStatus === 'success' ? 'green' : stStatus === 'error' ? 'red' : 'blue'
                    }
                  >
                    {stStatus === 'running' ? '⏳' : stStatus === 'success' ? '✓' : '✗'} {stStatus}
                  </Badge>
                </div>
                {(sr.output !== undefined || sr.error) && (
                  <div className="text-sm text-slate-300 max-h-64 overflow-y-auto">
                    {sr.error ? (
                      <p className="text-red-400 font-mono text-xs">{sr.error}</p>
                    ) : (
                      <MarkdownView content={sr.output ?? ''} />
                    )}
                  </div>
                )}
                {/* New vars introduced by this step — always visible */}
                {Object.keys(newVars).length > 0 && (
                  <div className="rounded-lg bg-emerald-950/40 ring-1 ring-emerald-800/40 px-3 py-2 flex flex-col gap-1">
                    <span className="text-[10px] text-emerald-500 font-medium uppercase tracking-wider mb-0.5">
                      本步赋值变量
                    </span>
                    {Object.entries(newVars).map(([k, v]) => (
                      <div
                        key={k}
                        className="grid grid-cols-[auto_1fr] gap-2 items-start font-mono text-[11px]"
                      >
                        <span className="text-emerald-400 shrink-0 whitespace-nowrap">{k}</span>
                        <span className="text-slate-300 break-all">
                          {v || <span className="text-slate-600 italic">(empty)</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {/* Global variables panel — latest snapshot of all named vars */}
          {(() => {
            const latestSnap = [...run.stepResults]
              .reverse()
              .find((s) => s.varsSnapshot && Object.keys(s.varsSnapshot).length > 0)?.varsSnapshot;
            if (!latestSnap || Object.keys(latestSnap).length === 0) return null;
            return (
              <div className="rounded-xl bg-slate-800/50 ring-1 ring-slate-700/40 p-4 flex flex-col gap-2">
                <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                  📦 所有变量 ({Object.keys(latestSnap).length})
                </span>
                <div className="grid grid-cols-1 gap-1 font-mono">
                  {Object.entries(latestSnap).map(([k, v]) => (
                    <div
                      key={k}
                      className="grid grid-cols-[minmax(0,auto)_1fr] gap-3 items-start text-[11px]"
                    >
                      <span className="text-indigo-400 shrink-0 whitespace-nowrap">{k}</span>
                      <span className="text-slate-300 break-all">
                        {v || <span className="text-slate-600 italic">(empty)</span>}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
