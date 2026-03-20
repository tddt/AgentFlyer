import { useEffect, useRef } from 'react'
import { rpc, useQuery } from '../hooks/useRpc.js'
import { Badge } from '../components/Badge.js'
import { Button } from '../components/Button.js'
import type { FederationPeer, FederationStatusResult } from '../types.js'

function relDate(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function statusColor(status: string): 'green' | 'yellow' | 'red' | 'slate' {
  if (status === 'connected') return 'green'
  if (status === 'discovered') return 'yellow'
  if (status === 'disconnected') return 'red'
  return 'slate'
}

export function FederationTab() {
  const REFRESH_MS = 10_000

  const { data, loading, error, refetch } = useQuery<FederationStatusResult>(
    () => rpc<FederationStatusResult>('federation.peers'),
    [],
  )

  // Auto-refresh every 10s
  const refetchRef = useRef(refetch)
  refetchRef.current = refetch
  useEffect(() => {
    const id = setInterval(() => { refetchRef.current() }, REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  const peers: FederationPeer[] = data?.peers ?? []
  const enabled = data?.enabled ?? false

  return (
    <div className="flex flex-col gap-5">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold text-slate-100">Federation</h1>
          <p className="text-[13px] text-slate-500 mt-0.5">Connected peers in the AgentFlyer mesh</p>
        </div>
        <div className="flex items-center gap-2">
          {data && (
            <Badge color={enabled ? 'green' : 'slate'}>{enabled ? 'Enabled' : 'Disabled'}</Badge>
          )}
          <Button size="sm" variant="ghost" onClick={refetch}>Refresh</Button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl bg-red-500/10 ring-1 ring-red-500/30 px-4 py-3 text-sm text-red-400">
          {error.message}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center gap-2 text-sm text-slate-500 px-1">
          <div className="w-3.5 h-3.5 rounded-full border-2 border-indigo-500/30 border-t-indigo-400 animate-spin" />
          Loading…
        </div>
      )}

      {/* ── Disabled banner ───────────────────────────────────────────────── */}
      {data && !enabled && (
        <div
          className="rounded-2xl px-5 py-4 flex items-start gap-4"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          <svg className="text-slate-600 shrink-0 mt-0.5" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <div className="flex flex-col gap-1">
            <p className="text-sm text-slate-300 font-medium">Federation is not enabled</p>
            <p className="text-[13px] text-slate-500">
              Enable it in <span className="text-indigo-400">Config → federation.enabled</span> and restart the gateway to connect with peer nodes.
            </p>
          </div>
        </div>
      )}

      {/* ── Peer list ─────────────────────────────────────────────────────── */}
      {enabled && !loading && peers.length === 0 && (
        <div className="text-sm text-slate-600 px-1">No peers discovered yet.</div>
      )}

      {enabled && peers.length > 0 && (
        <div
          className="rounded-2xl overflow-hidden"
          style={{ border: '1px solid rgba(255,255,255,0.07)' }}
        >
          {/* Table header */}
          <div
            className="grid grid-cols-[1fr_160px_100px_80px_80px] gap-4 px-4 py-2.5 text-[11px] font-medium text-slate-500 uppercase tracking-wider"
            style={{ borderBottom: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.02)' }}
          >
            <span>Node ID</span>
            <span>Address</span>
            <span>Status</span>
            <span>Latency</span>
            <span>Last seen</span>
          </div>

          {peers.map((peer, i) => (
            <div
              key={peer.nodeId}
              className="grid grid-cols-[1fr_160px_100px_80px_80px] gap-4 px-4 py-3 items-center hover:bg-white/[0.02] transition-colors"
              style={{ borderTop: i > 0 ? '1px solid rgba(255,255,255,0.05)' : undefined }}
            >
              <span className="font-mono text-[12px] text-slate-300 truncate" title={peer.nodeId}>
                {peer.nodeId.substring(0, 12)}…
              </span>
              <span className="font-mono text-[12px] text-slate-400">
                {peer.host}:{peer.port}
              </span>
              <Badge color={statusColor(peer.status)}>{peer.status}</Badge>
              <span className="text-[12px] text-slate-400">
                {peer.latencyMs != null ? `${peer.latencyMs}ms` : '—'}
              </span>
              <span className="text-[12px] text-slate-500">
                {peer.lastSeen != null ? relDate(peer.lastSeen) : '—'}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── Auto-refresh note ─────────────────────────────────────────────── */}
      {data && (
        <p className="text-[11px] text-slate-700 px-1">Auto-refreshes every 10 s</p>
      )}
    </div>
  )
}
