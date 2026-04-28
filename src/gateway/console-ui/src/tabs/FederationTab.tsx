import { useEffect, useRef } from 'react';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { useLocale } from '../context/i18n.js';
import { rpc, useQuery } from '../hooks/useRpc.js';
import type { FederationPeer, FederationStatusResult } from '../types.js';

function relDate(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function statusColor(status: string): 'green' | 'yellow' | 'red' | 'slate' {
  if (status === 'connected') return 'green';
  if (status === 'discovered') return 'yellow';
  if (status === 'disconnected') return 'red';
  return 'slate';
}

export function FederationTab() {
  const { t } = useLocale();
  const REFRESH_MS = 10_000;

  const { data, loading, error, refetch } = useQuery<FederationStatusResult>(
    () => rpc<FederationStatusResult>('federation.peers'),
    [],
  );

  // Auto-refresh every 10s
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  useEffect(() => {
    const id = setInterval(() => {
      refetchRef.current();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const peers: FederationPeer[] = data?.peers ?? [];
  const enabled = data?.enabled ?? false;

  return (
    <div className="flex flex-col gap-5">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold" style={{ color: 'var(--af-text-heading)' }}>{t('federation.title')}</h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--af-text-faint)' }}>
            {t('federation.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data && (
            <Badge color={enabled ? 'green' : 'slate'}>{enabled ? t('federation.enabled') : t('federation.disabled')}</Badge>
          )}
          <Button size="sm" variant="ghost" onClick={refetch}>
            {t('federation.refresh')}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl bg-red-500/10 ring-1 ring-red-500/30 px-4 py-3 text-sm text-red-400">
          {error.message}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center gap-2 text-sm px-1" style={{ color: 'var(--af-text-muted)' }}>
          <div className="w-3.5 h-3.5 rounded-full border-2 animate-spin" style={{ borderColor: 'var(--af-card-ring)', borderTopColor: 'var(--af-accent)' }} />
          {t('federation.loading')}
        </div>
      )}

      {data && !enabled && (
        <div
          className="rounded-2xl px-5 py-4 flex items-start gap-4"
          style={{
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.07)',
          }}
        >
          <svg
            className="text-slate-600 shrink-0 mt-0.5"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium" style={{ color: 'var(--af-text-base)' }}>{t('federation.notEnabled')}</p>
            <p className="text-[13px]" style={{ color: 'var(--af-text-faint)' }}>
              {t('federation.notEnabledDesc')}
            </p>
          </div>
        </div>
      )}

      {/* ── Peer list ─────────────────────────────────────────────────────── */}
      {enabled && !loading && peers.length === 0 && (
        <div className="text-sm px-1" style={{ color: 'var(--af-text-faint)' }}>{t('federation.noPeers')}</div>
      )}

      {enabled && peers.length > 0 && (
        <div
          className="rounded-2xl overflow-hidden"
          style={{ border: '1px solid var(--af-border)', background: 'var(--af-card-bg)' }}
        >
          {/* Table header */}
          <div
            className="grid grid-cols-[1fr_160px_100px_80px_80px] gap-4 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider"
            style={{
              borderBottom: '1px solid var(--af-border)',
              background: 'var(--af-surface-2)',
              color: 'var(--af-text-faint)',
            }}
          >
            <span>{t('federation.nodeId')}</span>
            <span>{t('federation.address')}</span>
            <span>{t('federation.status')}</span>
            <span>{t('federation.latency')}</span>
            <span>{t('federation.lastSeen')}</span>
          </div>

          {peers.map((peer, i) => (
            <div
              key={peer.nodeId}
              className="grid grid-cols-[1fr_160px_100px_80px_80px] gap-4 px-4 py-3 items-center hover:bg-white/[0.02] transition-colors"
              style={{ borderTop: i > 0 ? '1px solid var(--af-border)' : undefined }}
            >
              <span className="font-mono text-[12px] truncate" style={{ color: 'var(--af-text-base)' }} title={peer.nodeId}>
                {peer.nodeId.substring(0, 12)}…
              </span>
              <span className="font-mono text-[12px]" style={{ color: 'var(--af-text-muted)' }}>
                {peer.host}:{peer.port}
              </span>
              <Badge color={statusColor(peer.status)}>{peer.status}</Badge>
              <span className="text-[12px]" style={{ color: 'var(--af-text-muted)' }}>
                {peer.latencyMs != null ? `${peer.latencyMs}ms` : '—'}
              </span>
              <span className="text-[12px]" style={{ color: 'var(--af-text-faint)' }}>
                {peer.lastSeen != null ? relDate(peer.lastSeen) : '—'}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── Auto-refresh note ─────────────────────────────────────────────── */}
      {data && <p className="text-[11px] px-1" style={{ color: 'var(--af-text-faint)' }}>{t('federation.autoRefresh')}</p>}
    </div>
  );
}
