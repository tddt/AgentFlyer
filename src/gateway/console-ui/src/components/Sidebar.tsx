import type { ReactNode } from 'react';
type TabId =
  | 'overview'
  | 'agents'
  | 'chat'
  | 'logs'
  | 'config'
  | 'scheduler'
  | 'sessions'
  | 'workflow'
  | 'memory'
  | 'federation'
  | 'guide'
  | 'about';
import { useWorkflowRun } from '../context/workflow-run.js';

// ─── SVG icon set (Lucide-style) ─────────────────────────────────────────────
const Ico: Record<string, ReactNode> = {
  overview: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  agents: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="9" width="8" height="6" rx="1.5" />
      <rect x="13" y="9" width="8" height="6" rx="1.5" />
      <rect x="7" y="2" width="10" height="6" rx="1.5" />
      <line x1="10" y1="8" x2="10" y2="9" />
      <line x1="14" y1="8" x2="14" y2="9" />
      <line x1="7" y1="15" x2="7" y2="22" />
      <line x1="17" y1="15" x2="17" y2="22" />
    </svg>
  ),
  chat: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  ),
  logs: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14,2 14,8 20,8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  ),
  config: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="4" y1="6" x2="20" y2="6" />
      <circle cx="16" cy="6" r="2.5" fill="currentColor" stroke="none" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="8" cy="12" r="2.5" fill="currentColor" stroke="none" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="14" cy="18" r="2.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  scheduler: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <polyline points="9,14 11,16 15,12" />
    </svg>
  ),
  sessions: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="12,2 2,7 12,12 22,7" />
      <polyline points="2,17 12,22 22,17" />
      <polyline points="2,12 12,17 22,12" />
    </svg>
  ),
  workflow: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 012 2v7" />
      <line x1="6" y1="9" x2="6" y2="21" />
    </svg>
  ),
  memory: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4.03 3-9 3S3 13.66 3 12" />
      <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
    </svg>
  ),
  federation: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="5" r="2" />
      <circle cx="4" cy="19" r="2" />
      <circle cx="20" cy="19" r="2" />
      <line x1="12" y1="7" x2="4" y2="17" />
      <line x1="12" y1="7" x2="20" y2="17" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  ),
  guide: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
    </svg>
  ),
  about: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="8.5" />
      <line x1="12" y1="11" x2="12" y2="16" />
    </svg>
  ),
};

const NAV_ITEMS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'agents', label: 'Agents' },
  { id: 'chat', label: 'Chat' },
  { id: 'logs', label: 'Logs' },
  { id: 'config', label: 'Config' },
  { id: 'scheduler', label: 'Scheduler' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'memory', label: 'Memory' },
  { id: 'federation', label: 'Federation' },
  { id: 'guide', label: 'Guide' },
  { id: 'about', label: 'About' },
];

interface Props {
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
}

export function Sidebar({ activeTab, setActiveTab }: Props) {
  const { activeRun, cancel } = useWorkflowRun();
  const isRunning = activeRun?.run.status === 'running';
  return (
    <aside
      className="flex flex-col w-52 shrink-0 h-screen sticky top-0"
      style={{
        background: 'linear-gradient(180deg, #0c0f1a 0%, #07090f 100%)',
        borderRight: '1px solid rgba(255,255,255,0.055)',
      }}
    >
      {/* ── Logo ─────────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-3 px-5 py-[18px]"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.055)' }}
      >
        <div
          className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
            boxShadow: '0 4px 16px rgba(99,102,241,0.38)',
          }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
        </div>
        <div className="flex flex-col leading-none gap-0.5">
          <span className="text-[13px] font-semibold text-slate-100 tracking-tight">
            AgentFlyer
          </span>
          <span className="text-[10px] text-slate-600">Control Console</span>
        </div>
      </div>

      {/* ── Nav ──────────────────────────────────────────────────── */}
      <nav className="flex flex-col gap-px px-2 py-3 flex-1">
        {NAV_ITEMS.map(({ id, label }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`
                relative flex items-center gap-3 px-3 py-[9px] rounded-lg text-[13px] font-medium
                w-full text-left transition-colors duration-150
                ${
                  active
                    ? 'text-indigo-300 bg-indigo-500/10'
                    : 'text-slate-500 hover:text-slate-200 hover:bg-white/[0.04]'
                }
              `}
            >
              {active && (
                <span className="absolute left-0 top-[7px] bottom-[7px] w-[2px] rounded-r-full bg-indigo-400" />
              )}
              <span className={`shrink-0 ${active ? 'text-indigo-400' : ''}`}>{Ico[id]}</span>
              {label}
              {id === 'workflow' && isRunning && (
                <span className="ml-auto w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
              )}
            </button>
          );
        })}
      </nav>

      {/* ── Workflow progress ─────────────────────────────────────── */}
      {isRunning && activeRun && (
        <div
          className="mx-2 mb-2 px-3 py-2.5 rounded-xl flex flex-col gap-2"
          style={{ background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.15)' }}
        >
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
            <span className="text-[11px] text-amber-300 font-medium truncate flex-1">
              {activeRun.workflowDef.name}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="flex-1 h-1 rounded-full overflow-hidden bg-white/[0.07]">
              <div
                className="h-full bg-amber-400 rounded-full transition-all duration-500"
                style={{
                  width: `${
                    activeRun.workflowDef.steps.length > 0
                      ? Math.round(
                          (activeRun.run.stepResults.length / activeRun.workflowDef.steps.length) *
                            100,
                        )
                      : 0
                  }%`,
                }}
              />
            </div>
            <span className="text-[10px] text-slate-500 shrink-0 font-mono">
              {activeRun.run.stepResults.length}/{activeRun.workflowDef.steps.length}
            </span>
          </div>
          <button
            onClick={cancel}
            className="text-[11px] text-red-400/80 hover:text-red-300 text-left transition-colors"
          >
            ✕ Cancel workflow
          </button>
        </div>
      )}

      {/* ── Gateway status ────────────────────────────────────────── */}
      <div
        className="px-5 py-4 flex items-center gap-2.5"
        style={{ borderTop: '1px solid rgba(255,255,255,0.055)' }}
      >
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-50" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
        <span className="text-[11px] text-slate-600">Gateway connected</span>
      </div>
    </aside>
  );
}
