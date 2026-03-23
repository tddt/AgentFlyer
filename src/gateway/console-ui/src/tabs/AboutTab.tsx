import { useQuery } from '../hooks/useRpc.js';
import { rpc } from '../hooks/useRpc.js';
import type { GatewayStatus } from '../types.js';

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="flex items-start gap-4 py-2.5"
      style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}
    >
      <span className="w-36 shrink-0 text-[13px] text-slate-500">{label}</span>
      <span className="text-[13px] text-slate-200 font-mono break-all">{value}</span>
    </div>
  );
}

export function AboutTab() {
  const { data } = useQuery<GatewayStatus>(() => rpc<GatewayStatus>('gateway.status'), []);

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      {/* ── Brand ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-4">
        <div
          className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0"
          style={{
            background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
            boxShadow: '0 6px 24px rgba(99,102,241,0.35)',
          }}
        >
          <svg
            width="20"
            height="20"
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
        <div>
          <h1 className="text-lg font-semibold text-slate-100 tracking-tight">AgentFlyer</h1>
          <p className="text-[13px] text-slate-500">
            Decentralized, cross-platform, multi-host federated AI Agent framework
          </p>
        </div>
      </div>

      {/* ── Runtime info ──────────────────────────────────────────────────── */}
      <div
        className="rounded-2xl px-5 pb-1 pt-0.5"
        style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.02)' }}
      >
        <div className="pt-2.5 pb-1">
          <h2 className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">
            Runtime
          </h2>
        </div>
        {data ? (
          <>
            <InfoRow label="Version" value={data.version ?? '—'} />
            <InfoRow
              label="Uptime"
              value={
                data.uptime != null
                  ? (() => {
                      const s = Math.floor(data.uptime);
                      const h = Math.floor(s / 3600);
                      const m = Math.floor((s % 3600) / 60);
                      const sec = s % 60;
                      return h > 0 ? `${h}h ${m}m ${sec}s` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
                    })()
                  : '—'
              }
            />
            <InfoRow label="Active agents" value={String(data.activeAgents ?? '—')} />
            <InfoRow label="Running tasks" value={String(data.runningTasks ?? '—')} />
          </>
        ) : (
          <div className="py-3 text-[13px] text-slate-600">Fetching status…</div>
        )}
      </div>

      {/* ── Links ─────────────────────────────────────────────────────────── */}
      {/* <div
        className="rounded-2xl px-5 pb-3 pt-0.5"
        style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.02)' }}
      >
        <div className="pt-2.5 pb-1">
          <h2 className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Resources</h2>
        </div>
        <div className="flex flex-col gap-1.5 pt-2">
          {[
            ['Architecture Overview', 'docs/01-openclaw-architecture.md'],
            ['Baseline Features',     'docs/02-baseline-features.md'    ],
            ['Enhanced Features',     'docs/03-enhanced-features.md'    ],
            ['Technical Architecture','docs/04-technical-architecture.md'],
          ].map(([label, path]) => (
            <div key={path} className="flex items-center gap-2 text-[13px]">
              <svg className="text-slate-600 shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                <polyline points="14,2 14,8 20,8"/>
              </svg>
              <span className="text-slate-400">{label}</span>
              <span className="text-slate-700 font-mono text-[11px] ml-auto">{path}</span>
            </div>
          ))}
        </div>
      </div> */}

      {/* ── License ───────────────────────────────────────────────────────── */}
      <div
        className="rounded-2xl px-5 py-4"
        style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.02)' }}
      >
        <h2 className="text-[11px] font-medium text-slate-500 uppercase tracking-wider mb-2">
          License
        </h2>
        <p className="text-[13px] text-slate-400 leading-relaxed">
          MIT License — Copyright © AgentFlyer contributors
        </p>
      </div>
    </div>
  );
}
