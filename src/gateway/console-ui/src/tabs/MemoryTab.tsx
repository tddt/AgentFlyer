import { useCallback, useState } from 'react';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { useLocale } from '../context/i18n.js';
import { rpc, useQuery } from '../hooks/useRpc.js';
import { useToast } from '../hooks/useToast.js';
import type { MemoryEntry, MemorySearchResult } from '../types.js';

function relDate(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function MemoryTab() {
  const { toast } = useToast();
  const { t } = useLocale();
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [partition, setPartition] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  const { data, loading, error, refetch } = useQuery<MemorySearchResult>(
    () =>
      rpc<MemorySearchResult>('memory.search', {
        query: submitted || '*',
        partition: partition || undefined,
        limit: 50,
      }),
    [submitted, partition],
  );

  const handleSearch = useCallback(() => {
    setSubmitted(query);
  }, [query]);

  const handleDelete = useCallback(
    async (entryId: string) => {
      setDeleting(entryId);
      try {
        await rpc('memory.delete', { entryId });
        toast('Entry deleted', 'success');
        refetch();
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Delete failed', 'error');
      } finally {
        setDeleting(null);
      }
    },
    [toast, refetch],
  );

  const results: MemoryEntry[] = data?.results ?? [];

  return (
    <div className="flex flex-col gap-5">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold" style={{ color: 'var(--af-text-heading)' }}>{t('memory.title')}</h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--af-text-faint)' }}>
            {t('memory.subtitle')}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={refetch}>
          {t('memory.refresh')}
        </Button>
      </div>

      {/* ── Search bar ────────────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-3 p-4 rounded-2xl"
        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
      >
        <input
        className="flex-1 rounded-lg px-3 py-2 text-sm focus:outline-none"
          style={{ background: 'var(--af-input-bg)', boxShadow: '0 0 0 1px var(--af-input-ring)', color: 'var(--af-text-base)' }}
          placeholder={t('memory.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <input
        className="w-40 rounded-lg px-3 py-2 text-sm focus:outline-none"
          style={{ background: 'var(--af-input-bg)', boxShadow: '0 0 0 1px var(--af-input-ring)', color: 'var(--af-text-base)' }}
          placeholder={t('memory.partitionPlaceholder')}
          value={partition}
          onChange={(e) => setPartition(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <Button size="sm" variant="primary" onClick={handleSearch}>
          {t('memory.search')}
        </Button>
      </div>

      {/* ── Results ───────────────────────────────────────────────────────── */}
      {error && (
        <div className="rounded-xl bg-red-500/10 ring-1 ring-red-500/30 px-4 py-3 text-sm text-red-400">
          {error.message}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center gap-2 text-sm px-1" style={{ color: 'var(--af-text-muted)' }}>
          <div className="w-3.5 h-3.5 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: 'var(--af-accent)', borderTopColor: 'transparent' }} />
          {t('memory.loading')}
        </div>
      )}

      {!loading && !error && results.length === 0 && (
        <div className="text-sm px-1" style={{ color: 'var(--af-text-faint)' }}>{t('memory.noEntries')}</div>
      )}

      {results.length > 0 && (
        <div
          className="rounded-2xl overflow-hidden"
          style={{ border: '1px solid rgba(255,255,255,0.07)' }}
        >
          {/* Table header */}
          <div
            className="grid grid-cols-[1fr_100px_80px_80px_80px] gap-4 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider"
            style={{ borderBottom: '1px solid var(--af-border)', background: 'var(--af-surface-2)', color: 'var(--af-text-faint)' }}
          >
            <span>{t('memory.content')}</span>
            <span>{t('memory.partition')}</span>
            <span>{t('memory.importance')}</span>
            <span>{t('memory.created')}</span>
            <span />
          </div>

          {results.map((entry, i) => (
            <div
              key={entry.id}
              className="grid grid-cols-[1fr_100px_80px_80px_80px] gap-4 px-4 py-3 items-start hover:bg-white/[0.02] transition-colors"
              style={{ borderTop: i > 0 ? '1px solid rgba(255,255,255,0.05)' : undefined }}
            >
              {/* Content */}
              <div className="flex flex-col gap-1 min-w-0">
                <p className="text-sm line-clamp-2 leading-snug" style={{ color: 'var(--af-text-muted)' }}>{entry.content}</p>
                {entry.score != null && (
                  <span className="text-[11px]" style={{ color: 'var(--af-text-faint)' }}>
                    score: {entry.score.toFixed(3)}
                  </span>
                )}
                {entry.superseded && <Badge color="red">{t('memory.superseded')}</Badge>}
              </div>

              {/* Partition */}
              <div>
                {entry.partition ? (
                  <Badge color="indigo">{entry.partition}</Badge>
                ) : (
                  <span className="text-[12px]" style={{ color: 'var(--af-text-faint)' }}>—</span>
                )}
              </div>

              {/* Importance */}
              <div className="text-[12px]" style={{ color: 'var(--af-text-muted)' }}>
                {entry.importance != null ? entry.importance.toFixed(2) : '—'}
              </div>

              {/* Created */}
              <div className="text-[12px]" style={{ color: 'var(--af-text-faint)' }}>{relDate(entry.createdAt)}</div>

              {/* Delete */}
              <div className="flex justify-end">
                <button
                  disabled={deleting === entry.id}
                  onClick={() => void handleDelete(entry.id)}
                  className="text-[11px] text-red-400/60 hover:text-red-400 transition-colors disabled:opacity-50"
                >
                  {deleting === entry.id ? '…' : t('memory.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
