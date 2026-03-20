/**
 * WorkflowHistoryPanel — displays the last 100 workflow run records.
 * Fetches from workflow.history RPC; collapsible per-run cards.
 */
import { useState } from 'react'
import { rpc, useQuery } from '../hooks/useRpc.js'
import { Badge } from '../components/Badge.js'
import { Button } from '../components/Button.js'
import type { WorkflowDef, WorkflowRunRecord } from '../types.js'

function diffSnapshot(
  current: Record<string, string> | undefined,
  prev: Record<string, string> | undefined,
): Record<string, string> {
  if (!current || Object.keys(current).length === 0) return {}
  if (!prev) return { ...current }
  const delta: Record<string, string> = {}
  for (const [k, v] of Object.entries(current)) {
    if (!(k in prev) || prev[k] !== v) delta[k] = v
  }
  return delta
}

export function WorkflowHistoryPanel({
  workflows,
  agents,
  onClose,
}: {
  workflows: WorkflowDef[]
  agents: { agentId: string; name?: string }[]
  onClose: () => void
}) {
  const { data, loading } = useQuery<{ runs: WorkflowRunRecord[] }>(
    () => rpc<{ runs: WorkflowRunRecord[] }>('workflow.history'),
    [],
  )
  const [expanded, setExpanded] = useState<string | null>(null)

  const runs = data?.runs ?? []

  const workflowName = (wid: string) =>
    workflows.find((w) => w.id === wid)?.name ?? wid

  const agentName = (agentId: string) =>
    agents.find((a) => a.agentId === agentId)?.name ?? agentId

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-100">Run History</h2>
        <Button size="sm" variant="ghost" onClick={onClose}>← Back</Button>
      </div>

      {loading && <p className="text-xs text-slate-500">Loading…</p>}

      {!loading && runs.length === 0 && (
        <div className="rounded-xl bg-slate-800/40 ring-1 ring-slate-700/50 p-8 flex flex-col items-center gap-2">
          <span className="text-3xl">📋</span>
          <p className="text-slate-500 text-sm">No runs yet.</p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {runs.map((r) => {
          const isOpen = expanded === r.runId
          const wfDef = workflows.find((w) => w.id === r.workflowId)
          const duration =
            r.finishedAt
              ? `${((r.finishedAt - r.startedAt) / 1000).toFixed(1)}s`
              : null

          return (
            <div
              key={r.runId}
              className="rounded-xl bg-slate-800/60 ring-1 ring-slate-700/50 overflow-hidden"
            >
              <button
                className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-slate-700/30 transition-colors"
                onClick={() => setExpanded(isOpen ? null : r.runId)}
              >
                <Badge
                  variant={
                    r.status === 'done'
                      ? 'green'
                      : r.status === 'error'
                        ? 'red'
                        : r.status === 'cancelled'
                          ? 'gray'
                          : 'blue'
                  }
                >
                  {r.status}
                </Badge>
                <span className="text-sm text-slate-200 font-medium flex-1 truncate">
                  {r.workflowName || workflowName(r.workflowId)}
                </span>
                <span className="text-xs text-slate-500 shrink-0">
                  {new Date(r.startedAt).toLocaleString()}
                  {duration && ` · ${duration}`}
                </span>
                <span className="text-slate-600 text-xs">{isOpen ? '▲' : '▼'}</span>
              </button>

              {isOpen && (
                <div className="px-4 pb-4 flex flex-col gap-3">
                  {r.input && (
                    <div className="rounded-lg bg-slate-900/60 ring-1 ring-slate-700/40 px-3 py-2">
                      <span className="text-xs text-slate-500 block mb-1">Input</span>
                      <p className="text-xs text-slate-300 whitespace-pre-wrap line-clamp-3">
                        {r.input}
                      </p>
                    </div>
                  )}
                  {r.stepResults.map((sr, si) => {
                    const step = wfDef?.steps.find((s) => s.id === sr.stepId)
                    const prevSnap = si > 0 ? r.stepResults[si - 1]?.varsSnapshot : undefined
                    const newVars = diffSnapshot(sr.varsSnapshot, prevSnap)
                    return (
                      <div
                        key={sr.stepId}
                        className="rounded-lg bg-slate-900/40 ring-1 ring-slate-700/30 p-3 flex flex-col gap-1.5"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono text-slate-600">Step {si + 1}</span>
                          <span className="text-xs text-slate-400">
                            {step?.label ?? agentName(step?.agentId ?? '')}
                          </span>
                          <Badge variant={sr.error ? 'red' : 'green'}>
                            {sr.error ? 'error' : 'ok'}
                          </Badge>
                        </div>
                        {(sr.output !== undefined || sr.error) && (
                          <p
                            className={`text-xs whitespace-pre-wrap line-clamp-4 ${
                              sr.error ? 'text-red-400' : 'text-slate-300'
                            }`}
                          >
                            {sr.error ?? sr.output}
                          </p>
                        )}
                        {Object.keys(newVars).length > 0 && (
                          <div className="rounded-md bg-emerald-950/40 ring-1 ring-emerald-800/40 px-2.5 py-2 flex flex-col gap-1">
                            <span className="text-[10px] text-emerald-500 font-medium uppercase tracking-wider mb-0.5">本步赋值变量</span>
                            {Object.entries(newVars).map(([k, v]) => (
                              <div key={k} className="grid grid-cols-[auto_1fr] gap-2 items-start font-mono text-[11px]">
                                <span className="text-emerald-400 shrink-0 whitespace-nowrap">{k}</span>
                                <span className="text-slate-300 break-all">{v}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}

                  {/* Global variables summary for this run */}
                  {(() => {
                    const latestSnap = [...r.stepResults].reverse().find((s) => s.varsSnapshot && Object.keys(s.varsSnapshot).length > 0)?.varsSnapshot
                    if (!latestSnap || Object.keys(latestSnap).length === 0) return null
                    return (
                      <div className="rounded-lg bg-slate-800/50 ring-1 ring-slate-700/40 px-3 py-2 flex flex-col gap-1.5">
                        <span className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">📦 全部变量 ({Object.keys(latestSnap).length})</span>
                        <div className="flex flex-col gap-1 font-mono">
                          {Object.entries(latestSnap).map(([k, v]) => (
                            <div key={k} className="grid grid-cols-[auto_1fr] gap-2 items-start text-[11px]">
                              <span className="text-indigo-400 shrink-0 whitespace-nowrap">{k}</span>
                              <span className="text-slate-300 break-all">{v}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })()}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
