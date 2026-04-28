import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { DeliverableDetailView } from '../components/DeliverableDetailView.js';
import { useLocale } from '../context/i18n.js';
import { rpc } from '../hooks/useRpc.js';
import { useToast } from '../hooks/useToast.js';
import type {
  DeliverableListResult,
  DeliverableRecord,
  DeliverableSource,
  DeliverableStatus,
} from '../types.js';

type SourceFilter = 'all' | DeliverableSource['kind'];
type StatusFilter = 'all' | DeliverableStatus;
type TimeRange = 'all' | '24h' | '7d' | '30d';
type HighlightFilter = 'all' | 'media' | 'problem';

function groupLabel(
  kind: DeliverableSource['kind'],
  t: (key: string, vars?: Record<string, string>) => string,
): string {
  if (kind === 'workflow_run') {
    return t('deliverables.group.workflow');
  }
  if (kind === 'scheduler_task_run') {
    return t('deliverables.group.scheduler');
  }
  return t('deliverables.group.chat');
}

function metricTone(index: number): string {
  return [
    'border-cyan-400/15 bg-cyan-500/10 text-cyan-100',
    'border-emerald-400/15 bg-emerald-500/10 text-emerald-100',
    'border-fuchsia-400/15 bg-fuchsia-500/10 text-fuchsia-100',
    'border-amber-400/15 bg-amber-500/10 text-amber-100',
  ][index % 4];
}

function sourceBadgeVariant(kind: DeliverableSource['kind']): 'blue' | 'purple' | 'green' {
  return kind === 'workflow_run' ? 'blue' : kind === 'scheduler_task_run' ? 'purple' : 'green';
}

function sourceKeyLabel(kind: DeliverableSource['kind']): string {
  return kind === 'workflow_run'
    ? 'workflow_run'
    : kind === 'scheduler_task_run'
      ? 'scheduler_task_run'
      : 'chat_turn';
}

function hasMediaArtifacts(item: DeliverableRecord): boolean {
  return item.artifacts.some(
    (artifact) =>
      artifact.role === 'file' &&
      (artifact.format === 'image' || artifact.format === 'video' || artifact.format === 'audio'),
  );
}

function mediaArtifactCount(item: DeliverableRecord): number {
  return item.artifacts.filter(
    (artifact) =>
      artifact.role === 'file' &&
      (artifact.format === 'image' || artifact.format === 'video' || artifact.format === 'audio'),
  ).length;
}

function inTimeRange(createdAt: number, range: TimeRange): boolean {
  if (range === 'all') return true;
  const created = Number(createdAt);
  if (!Number.isFinite(created)) return false;
  const now = Date.now();
  const windowMs =
    range === '24h'
      ? 24 * 60 * 60 * 1000
      : range === '7d'
        ? 7 * 24 * 60 * 60 * 1000
        : 30 * 24 * 60 * 60 * 1000;
  return now - created <= windowMs;
}

export function DeliverablesTab() {
  const { t } = useLocale();
  const { toast } = useToast();
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [highlightFilter, setHighlightFilter] = useState<HighlightFilter>('all');
  const [data, setData] = useState<DeliverableListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const result = await rpc<DeliverableListResult>('deliverable.list', {
          sourceKind: sourceFilter === 'all' ? undefined : sourceFilter,
          status: statusFilter === 'all' ? undefined : statusFilter,
          query: query.trim() || undefined,
          limit: 200,
        });
        if (cancelled) return;
        setData(result);
        setSelectedId((current) => current ?? result.items[0]?.id ?? null);
      } catch (error) {
        if (!cancelled) {
          toast(error instanceof Error ? error.message : 'Failed to load deliverables', 'error');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const timer = setInterval(() => {
      void load();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [query, sourceFilter, statusFilter, toast]);

  const filteredItems = useMemo(() => {
    const items = data?.items ?? [];
    return items.filter((item) => {
      if (!inTimeRange(item.createdAt, timeRange)) return false;
      if (highlightFilter === 'media' && !hasMediaArtifacts(item)) return false;
      if (
        highlightFilter === 'problem' &&
        item.status !== 'error' &&
        item.status !== 'cancelled'
      ) {
        return false;
      }
      return true;
    });
  }, [data?.items, highlightFilter, timeRange]);

  const selected = useMemo<DeliverableRecord | null>(() => {
    const items = filteredItems;
    if (items.length === 0) return null;
    return items.find((item) => item.id === selectedId) ?? items[0] ?? null;
  }, [filteredItems, selectedId]);

  const spotlight = useMemo(
    () => ({
      media: filteredItems.filter((item) => hasMediaArtifacts(item)).length,
      problems: filteredItems.filter((item) => item.status !== 'ready').length,
    }),
    [filteredItems],
  );

  const metrics = [
    { label: t('deliverables.metrics.total'), value: String(data?.stats.total ?? 0) },
    { label: t('deliverables.metrics.recent24h'), value: String(data?.stats.recent24h ?? 0) },
    {
      label: t('deliverables.metrics.workflowRuns'),
      value: String(data?.stats.workflowRuns ?? 0),
    },
    {
      label: t('deliverables.metrics.schedulerRuns'),
      value: String(data?.stats.schedulerRuns ?? 0),
    },
    {
      label: t('deliverables.metrics.chatTurns'),
      value: String(data?.stats.chatTurns ?? 0),
    },
    {
      label: t('deliverables.metrics.totalArtifacts'),
      value: String(data?.stats.totalArtifacts ?? 0),
    },
    {
      label: t('deliverables.metrics.fileArtifacts'),
      value: String(data?.stats.fileArtifacts ?? 0),
    },
  ];

  const grouped = useMemo(() => {
    const items = filteredItems;
    return [
      {
        kind: 'workflow_run' as const,
        label: groupLabel('workflow_run', t),
        items: items.filter((item) => item.source.kind === 'workflow_run'),
      },
      {
        kind: 'scheduler_task_run' as const,
        label: groupLabel('scheduler_task_run', t),
        items: items.filter((item) => item.source.kind === 'scheduler_task_run'),
      },
      {
        kind: 'chat_turn' as const,
        label: groupLabel('chat_turn', t),
        items: items.filter((item) => item.source.kind === 'chat_turn'),
      },
    ].filter((group) => group.items.length > 0);
  }, [filteredItems, t]);

  const problemItems = useMemo(
    () => filteredItems.filter((item) => item.status === 'error' || item.status === 'cancelled').slice(0, 6),
    [filteredItems],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.18),transparent_28%),radial-gradient(circle_at_top_right,rgba(168,85,247,0.16),transparent_24%),linear-gradient(135deg,rgba(15,23,42,0.96),rgba(2,6,23,0.96))] p-4 shadow-[0_40px_120px_rgba(2,6,23,0.45)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.28em] text-cyan-300/70">
              {t('deliverables.kicker')}
            </div>
            <h1 className="mt-1 text-xl font-semibold tracking-tight" style={{ color: 'var(--af-text-heading)' }}>
              {t('deliverables.title')}
            </h1>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setQuery('')}>
            {t('deliverables.clearFilters')}
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {metrics.map((metric, index) => (
            <div
              key={metric.label}
              className={`inline-flex items-center gap-2 rounded border px-2.5 py-1 ${metricTone(index)}`}
            >
              <span className="text-sm font-semibold tabular-nums">{metric.value}</span>
              <span className="text-[10px] uppercase tracking-[0.14em] opacity-60">{metric.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-4 rounded-xl border border-white/8 p-4 backdrop-blur-xl" style={{ background: 'var(--af-card-bg)' }}>
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('deliverables.searchPlaceholder')}
            className="min-w-[220px] flex-1 rounded-lg border border-white/10 px-4 py-2.5 text-sm outline-none focus:border-cyan-400/40"
            style={{ background: 'var(--af-input-bg)', color: 'var(--af-text-base)' }}
          />
          <div className="flex flex-wrap gap-2">
            {(['all', 'workflow_run', 'scheduler_task_run', 'chat_turn'] as SourceFilter[]).map((value) => (
              <button
                key={value}
                onClick={() => setSourceFilter(value)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  sourceFilter === value
                    ? 'bg-cyan-500/15 text-cyan-200 ring-1 ring-cyan-400/30'
                    : 'bg-white/[0.04] hover:text-white'
                }`}
                style={sourceFilter !== value ? { color: 'var(--af-text-muted)' } : undefined}
              >
                {t(`deliverables.source.${value}`)}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {(['all', 'ready', 'error', 'cancelled'] as StatusFilter[]).map((value) => (
              <button
                key={value}
                onClick={() => setStatusFilter(value)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  statusFilter === value
                    ? 'bg-fuchsia-500/15 text-fuchsia-200 ring-1 ring-fuchsia-400/30'
                    : 'bg-white/[0.04] hover:text-white'
                }`}
                style={statusFilter !== value ? { color: 'var(--af-text-muted)' } : undefined}
              >
                {t(`deliverables.status.${value}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-2">
            {(['all', '24h', '7d', '30d'] as TimeRange[]).map((value) => (
              <button
                key={value}
                onClick={() => setTimeRange(value)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  timeRange === value
                    ? 'bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/30'
                    : 'bg-white/[0.04] hover:text-white'
                }`}
                style={timeRange !== value ? { color: 'var(--af-text-muted)' } : undefined}
              >
                {t(`deliverables.timeRange.${value}`)}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {(['all', 'media', 'problem'] as HighlightFilter[]).map((value) => (
              <button
                key={value}
                onClick={() => setHighlightFilter(value)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  highlightFilter === value
                    ? 'bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/30'
                    : 'bg-white/[0.04] hover:text-white'
                }`}
                style={highlightFilter !== value ? { color: 'var(--af-text-muted)' } : undefined}
              >
                {t(`deliverables.highlight.${value}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="min-w-[140px] flex-1 rounded-lg border border-cyan-400/10 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.12),transparent_60%),rgba(2,6,23,0.82)] px-4 py-2.5">
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-semibold text-cyan-50">{filteredItems.length}</span>
            <span className="text-[10px] uppercase tracking-[0.18em] text-cyan-200/70">{t('deliverables.spotlight.filtered')}</span>
          </div>
          <div className="mt-0.5 text-xs" style={{ color: 'var(--af-text-muted)' }}>{t('deliverables.spotlight.filteredHint')}</div>
        </div>
        <div className="min-w-[140px] flex-1 rounded-lg border border-emerald-400/10 bg-[radial-gradient(circle_at_top_left,rgba(34,197,94,0.10),transparent_60%),rgba(2,6,23,0.82)] px-4 py-2.5">
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-semibold text-emerald-50">{spotlight.media}</span>
            <span className="text-[10px] uppercase tracking-[0.18em] text-emerald-200/70">{t('deliverables.spotlight.media')}</span>
          </div>
          <div className="mt-0.5 text-xs" style={{ color: 'var(--af-text-muted)' }}>{t('deliverables.spotlight.mediaHint')}</div>
        </div>
        <div className="min-w-[140px] flex-1 rounded-lg border border-rose-400/10 bg-[radial-gradient(circle_at_top_left,rgba(244,63,94,0.10),transparent_60%),rgba(2,6,23,0.82)] px-4 py-2.5">
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-semibold text-rose-50">{spotlight.problems}</span>
            <span className="text-[10px] uppercase tracking-[0.18em] text-rose-200/70">{t('deliverables.spotlight.problems')}</span>
          </div>
          <div className="mt-0.5 text-xs" style={{ color: 'var(--af-text-muted)' }}>{t('deliverables.spotlight.problemsHint')}</div>
        </div>
      </div>

      {/* ── Main workspace: sidebar (groups + diagnostics) | list | detail ── */}
      <div className="grid gap-4 xl:grid-cols-[240px_minmax(0,1fr)]">

        {/* Left sidebar — bounded height, never pushes the list+detail section */}
        <div className="flex flex-col gap-4">

          {/* Source groups (at most 3 entries, does not grow) */}
          <div className="rounded-lg border border-white/8 p-4 backdrop-blur-xl" style={{ background: 'var(--af-card-bg)' }}>
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="text-[11px] uppercase tracking-[0.22em]" style={{ color: 'var(--af-text-faint)' }}>
              </div>
              <Badge variant="gray">{grouped.length}</Badge>
            </div>
            <div className="flex flex-col gap-2">
              {grouped.map((group) => (
                <div key={group.kind} className="rounded-md border border-white/8 px-3 py-2.5" style={{ background: 'var(--af-surface-2)' }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate text-xs font-medium" style={{ color: 'var(--af-text-base)' }}>{group.label}</div>
                    <Badge variant={sourceBadgeVariant(group.kind)}>{group.items.length}</Badge>
                  </div>
                  <div className="mt-1 text-[11px]" style={{ color: 'var(--af-text-faint)' }}>
                    {group.items[0] ? new Date(group.items[0].createdAt).toLocaleString() : ''}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Problem diagnostics — scrollable so it never overflows */}
          <div className="rounded-lg border border-rose-400/10 bg-[linear-gradient(180deg,rgba(127,29,29,0.16),rgba(2,6,23,0.82))] p-4 backdrop-blur-xl">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="text-[11px] uppercase tracking-[0.22em] text-rose-200/70">
                {t('deliverables.diagnostics.title')}
              </div>
              <Badge variant="red">{problemItems.length}</Badge>
            </div>
            <div className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
              {problemItems.length === 0 && (
                <div className="rounded-md border border-emerald-400/10 bg-emerald-500/10 p-3 text-sm text-emerald-100">
                  {t('deliverables.diagnostics.clean')}
                </div>
              )}
              {problemItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setSelectedId(item.id)}
                  className="rounded-md border border-white/8 p-3 text-left hover:border-white/15" style={{ background: 'var(--af-surface-2)' }}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={item.status === 'error' ? 'red' : 'gray'}>{item.status}</Badge>
                    <span className="line-clamp-1 text-xs font-medium" style={{ color: 'var(--af-text-base)' }}>{item.title}</span>
                  </div>
                  <div className="mt-1.5 line-clamp-2 text-xs leading-4" style={{ color: 'var(--af-text-muted)' }}>
                    {item.previewText || item.summary}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right area: list + detail always visible alongside the sidebar */}
        <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
          <div className="rounded-xl border border-white/8 p-4 backdrop-blur-xl" style={{ background: 'var(--af-card-bg)' }}>
            <div className="mb-3 flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-[0.22em]" style={{ color: 'var(--af-text-faint)' }}>
              </div>
              <Badge variant="gray">{filteredItems.length}</Badge>
            </div>

            {loading && data === null && <div className="py-6 text-sm" style={{ color: 'var(--af-text-muted)' }}>{t('deliverables.loading')}</div>}

            {!loading && filteredItems.length === 0 && (
              <div className="rounded-md border border-dashed border-white/10 p-5 text-sm" style={{ background: 'var(--af-surface-2)', color: 'var(--af-text-muted)' }}>
                {t('deliverables.empty')}
              </div>
            )}

            <div className="mb-3 rounded-md border border-white/8 px-4 py-3" style={{ background: 'var(--af-surface-2)' }}>
              <div className="flex items-center justify-between gap-2 text-xs" style={{ color: 'var(--af-text-muted)' }}>
                <span>{t('deliverables.listTitle')}</span>
                <span>{filteredItems.length}</span>
              </div>
              <div className="mt-2 text-[11px] leading-5" style={{ color: 'var(--af-text-faint)' }}>
                {grouped
                  .filter((group) => group.items.length > 0)
                  .map((group) => `${group.label} ${group.items.length}`)
                  .join(' · ')}
              </div>
            </div>

            <div className="flex max-h-[860px] flex-col gap-2 overflow-auto pr-1">
              {filteredItems.map((item) => {
                const active = item.id === selected?.id;
                const mediaCount = mediaArtifactCount(item);
                return (
                  <button
                    key={item.id}
                    onClick={() => setSelectedId(item.id)}
                    className={`rounded-md border px-4 py-3 text-left transition-all ${
                      active
                        ? 'border-cyan-400/35 bg-cyan-500/10 shadow-[0_20px_50px_rgba(6,182,212,0.08)]'
                        : 'border-white/8 hover:border-white/15 hover:bg-white/[0.03]'
                    }`}
                    style={active ? undefined : { background: 'var(--af-surface-2)' }}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant={
                          item.status === 'ready'
                            ? 'green'
                            : item.status === 'error'
                              ? 'red'
                              : 'gray'
                        }
                      >
                        {item.status}
                      </Badge>
                      <Badge variant={sourceBadgeVariant(item.source.kind)}>
                        {t(`deliverables.source.${sourceKeyLabel(item.source.kind)}`)}
                      </Badge>
                      {mediaCount > 0 && (
                        <Badge variant="green">{t('deliverables.card.mediaCount', { n: String(mediaCount) })}</Badge>
                      )}
                    </div>
                    <div className="mt-3 line-clamp-2 text-sm font-semibold" style={{ color: 'var(--af-text-heading)' }}>
                      {item.title}
                    </div>
                    <div className="mt-2 line-clamp-2 text-xs leading-5" style={{ color: 'var(--af-text-muted)' }}>
                      {item.previewText || item.summary}
                    </div>
                    <div className="mt-3 flex items-center justify-between text-[11px]" style={{ color: 'var(--af-text-faint)' }}>
                      <span>{new Date(item.createdAt).toLocaleString()}</span>
                      <span>{item.artifacts.length}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <DeliverableDetailView deliverable={selected} loading={loading && !selected} />
        </div>
      </div>
    </div>
  );
}