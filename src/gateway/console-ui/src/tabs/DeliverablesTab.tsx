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
type ViewMode = 'stack' | 'cards';

function groupLabel(
  kind: DeliverableSource['kind'],
  t: (key: string, vars?: Record<string, string>) => string,
): string {
  return kind === 'workflow_run'
    ? t('deliverables.group.workflow')
    : t('deliverables.group.scheduler');
}

function metricTone(index: number): string {
  return [
    'border-cyan-400/15 bg-cyan-500/10 text-cyan-100',
    'border-emerald-400/15 bg-emerald-500/10 text-emerald-100',
    'border-fuchsia-400/15 bg-fuchsia-500/10 text-fuchsia-100',
    'border-amber-400/15 bg-amber-500/10 text-amber-100',
  ][index % 4];
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

function inTimeRange(createdAt: string, range: TimeRange): boolean {
  if (range === 'all') return true;
  const created = new Date(createdAt).getTime();
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
  const [viewMode, setViewMode] = useState<ViewMode>('cards');
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
    ].filter((group) => group.items.length > 0);
  }, [filteredItems, t]);

  const problemItems = useMemo(
    () => filteredItems.filter((item) => item.status === 'error' || item.status === 'cancelled').slice(0, 6),
    [filteredItems],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-[32px] border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.18),transparent_28%),radial-gradient(circle_at_top_right,rgba(168,85,247,0.16),transparent_24%),linear-gradient(135deg,rgba(15,23,42,0.96),rgba(2,6,23,0.96))] p-6 shadow-[0_40px_120px_rgba(2,6,23,0.45)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <div className="text-[11px] uppercase tracking-[0.28em] text-cyan-300/70">
              {t('deliverables.kicker')}
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-50">
              {t('deliverables.title')}
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-300">
              {t('deliverables.subtitle')}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setQuery('')}>
            {t('deliverables.clearFilters')}
          </Button>
        </div>

        <div className="mt-6 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          {metrics.map((metric, index) => (
            <div
              key={metric.label}
              className={`rounded-2xl border px-4 py-3 ${metricTone(index)}`}
            >
              <div className="text-[11px] uppercase tracking-[0.18em] text-white/60">
                {metric.label}
              </div>
              <div className="mt-3 text-2xl font-semibold">{metric.value}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-4 rounded-[28px] border border-white/8 bg-slate-900/70 p-5 backdrop-blur-xl">
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('deliverables.searchPlaceholder')}
            className="min-w-[220px] flex-1 rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-2.5 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-cyan-400/40"
          />
          <div className="flex flex-wrap gap-2">
            {(['all', 'workflow_run', 'scheduler_task_run'] as SourceFilter[]).map((value) => (
              <button
                key={value}
                onClick={() => setSourceFilter(value)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  sourceFilter === value
                    ? 'bg-cyan-500/15 text-cyan-200 ring-1 ring-cyan-400/30'
                    : 'bg-white/[0.04] text-slate-400 hover:text-slate-200'
                }`}
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
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  statusFilter === value
                    ? 'bg-fuchsia-500/15 text-fuchsia-200 ring-1 ring-fuchsia-400/30'
                    : 'bg-white/[0.04] text-slate-400 hover:text-slate-200'
                }`}
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
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  timeRange === value
                    ? 'bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/30'
                    : 'bg-white/[0.04] text-slate-400 hover:text-slate-200'
                }`}
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
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  highlightFilter === value
                    ? 'bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/30'
                    : 'bg-white/[0.04] text-slate-400 hover:text-slate-200'
                }`}
              >
                {t(`deliverables.highlight.${value}`)}
              </button>
            ))}
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            {(['cards', 'stack'] as ViewMode[]).map((value) => (
              <button
                key={value}
                onClick={() => setViewMode(value)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  viewMode === value
                    ? 'bg-cyan-500/15 text-cyan-200 ring-1 ring-cyan-400/30'
                    : 'bg-white/[0.04] text-slate-400 hover:text-slate-200'
                }`}
              >
                {t(`deliverables.viewMode.${value}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-[24px] border border-cyan-400/10 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.18),transparent_38%),rgba(2,6,23,0.82)] p-5">
          <div className="text-[11px] uppercase tracking-[0.2em] text-cyan-200/70">
            {t('deliverables.spotlight.filtered')}
          </div>
          <div className="mt-3 text-3xl font-semibold text-cyan-50">{filteredItems.length}</div>
          <div className="mt-2 text-sm text-slate-300">{t('deliverables.spotlight.filteredHint')}</div>
        </div>
        <div className="rounded-[24px] border border-emerald-400/10 bg-[radial-gradient(circle_at_top_left,rgba(34,197,94,0.16),transparent_34%),rgba(2,6,23,0.82)] p-5">
          <div className="text-[11px] uppercase tracking-[0.2em] text-emerald-200/70">
            {t('deliverables.spotlight.media')}
          </div>
          <div className="mt-3 text-3xl font-semibold text-emerald-50">{spotlight.media}</div>
          <div className="mt-2 text-sm text-slate-300">{t('deliverables.spotlight.mediaHint')}</div>
        </div>
        <div className="rounded-[24px] border border-rose-400/10 bg-[radial-gradient(circle_at_top_left,rgba(244,63,94,0.16),transparent_34%),rgba(2,6,23,0.82)] p-5">
          <div className="text-[11px] uppercase tracking-[0.2em] text-rose-200/70">
            {t('deliverables.spotlight.problems')}
          </div>
          <div className="mt-3 text-3xl font-semibold text-rose-50">{spotlight.problems}</div>
          <div className="mt-2 text-sm text-slate-300">{t('deliverables.spotlight.problemsHint')}</div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="rounded-[28px] border border-white/8 bg-slate-900/70 p-5 backdrop-blur-xl">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
              {t('deliverables.group.title')}
            </div>
            <Badge variant="gray">{grouped.length}</Badge>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {grouped.map((group) => (
              <div key={group.kind} className="rounded-2xl border border-white/8 bg-slate-950/55 p-4">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium text-slate-100">{group.label}</div>
                  <Badge variant={group.kind === 'workflow_run' ? 'blue' : 'purple'}>
                    {group.items.length}
                  </Badge>
                </div>
                <div className="mt-2 text-xs text-slate-500">
                  {group.items[0] ? new Date(group.items[0].createdAt).toLocaleString() : ''}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-[28px] border border-rose-400/10 bg-[linear-gradient(180deg,rgba(127,29,29,0.16),rgba(2,6,23,0.82))] p-5 backdrop-blur-xl">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div className="text-[11px] uppercase tracking-[0.22em] text-rose-200/70">
              {t('deliverables.diagnostics.title')}
            </div>
            <Badge variant="red">{problemItems.length}</Badge>
          </div>
          <div className="flex flex-col gap-3">
            {problemItems.length === 0 && (
              <div className="rounded-2xl border border-emerald-400/10 bg-emerald-500/10 p-4 text-sm text-emerald-100">
                {t('deliverables.diagnostics.clean')}
              </div>
            )}
            {problemItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                className="rounded-2xl border border-white/8 bg-slate-950/45 p-4 text-left hover:border-white/15"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={item.status === 'error' ? 'red' : 'gray'}>{item.status}</Badge>
                  <span className="text-sm font-medium text-slate-100">{item.title}</span>
                </div>
                <div className="mt-2 line-clamp-3 text-xs leading-5 text-slate-300">
                  {item.previewText || item.summary}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="rounded-[28px] border border-white/8 bg-slate-900/70 p-4 backdrop-blur-xl">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
              {t('deliverables.listTitle')}
            </div>
            <Badge variant="gray">{filteredItems.length}</Badge>
          </div>

          {loading && <div className="py-6 text-sm text-slate-400">{t('deliverables.loading')}</div>}

          {!loading && filteredItems.length === 0 && (
            <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/50 p-5 text-sm text-slate-500">
              {t('deliverables.empty')}
            </div>
          )}

          <div className="flex max-h-[860px] flex-col gap-5 overflow-auto pr-1">
            {grouped.map((group) => (
              <div key={group.kind} className="flex flex-col gap-3">
                <div className="sticky top-0 z-10 rounded-2xl border border-white/8 bg-slate-950/90 px-4 py-2 backdrop-blur-xl">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">
                      {group.label}
                    </div>
                    <Badge variant={group.kind === 'workflow_run' ? 'blue' : 'purple'}>
                      {group.items.length}
                    </Badge>
                  </div>
                </div>
                <div className={viewMode === 'cards' ? 'grid gap-3 md:grid-cols-2' : 'flex flex-col gap-3'}>
                  {group.items.map((item) => {
                    const active = item.id === selected?.id;
                    const mediaCount = mediaArtifactCount(item);
                    return (
                      <button
                        key={item.id}
                        onClick={() => setSelectedId(item.id)}
                        className={`rounded-2xl border text-left transition-all ${
                          active
                            ? 'border-cyan-400/35 bg-cyan-500/10 shadow-[0_20px_50px_rgba(6,182,212,0.08)]'
                            : 'border-white/8 bg-slate-950/55 hover:border-white/15 hover:bg-white/[0.03]'
                        } ${viewMode === 'cards' ? 'overflow-hidden p-0' : 'px-4 py-3'}`}
                      >
                        {viewMode === 'cards' ? (
                          <>
                            <div className="relative overflow-hidden border-b border-white/8 bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.22),transparent_36%),radial-gradient(circle_at_bottom_right,rgba(168,85,247,0.18),transparent_28%),linear-gradient(135deg,rgba(15,23,42,0.98),rgba(2,6,23,0.92))] px-4 py-4">
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
                                <Badge variant={item.source.kind === 'workflow_run' ? 'blue' : 'purple'}>
                                  {item.source.kind === 'workflow_run'
                                    ? t('deliverables.source.workflow_run')
                                    : t('deliverables.source.scheduler_task_run')}
                                </Badge>
                                {mediaCount > 0 && <Badge variant="green">{t('deliverables.card.mediaCount', { n: String(mediaCount) })}</Badge>}
                              </div>
                              <div className="mt-4 text-base font-semibold text-slate-50">{item.title}</div>
                              <div className="mt-2 line-clamp-3 text-sm leading-6 text-slate-300">
                                {item.previewText || item.summary}
                              </div>
                            </div>
                            <div className="px-4 py-3">
                              <div className="grid grid-cols-2 gap-3 text-xs text-slate-400">
                                <div>
                                  <div className="uppercase tracking-[0.18em] text-slate-500">
                                    {t('deliverables.card.createdAt')}
                                  </div>
                                  <div className="mt-1 text-slate-300">
                                    {new Date(item.createdAt).toLocaleString()}
                                  </div>
                                </div>
                                <div>
                                  <div className="uppercase tracking-[0.18em] text-slate-500">
                                    {t('deliverables.card.artifacts')}
                                  </div>
                                  <div className="mt-1 text-slate-300">{item.artifacts.length}</div>
                                </div>
                              </div>
                            </div>
                          </>
                        ) : (
                          <>
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
                              <Badge variant={item.source.kind === 'workflow_run' ? 'blue' : 'purple'}>
                                {item.source.kind === 'workflow_run'
                                  ? t('deliverables.source.workflow_run')
                                  : t('deliverables.source.scheduler_task_run')}
                              </Badge>
                              {mediaCount > 0 && <Badge variant="green">{t('deliverables.card.mediaCount', { n: String(mediaCount) })}</Badge>}
                            </div>
                            <div className="mt-3 text-sm font-semibold text-slate-100">{item.title}</div>
                            <div className="mt-2 line-clamp-3 text-xs leading-5 text-slate-400">
                              {item.previewText || item.summary}
                            </div>
                            <div className="mt-3 flex items-center justify-between text-[11px] text-slate-500">
                              <span>{new Date(item.createdAt).toLocaleString()}</span>
                              <span>
                                {item.artifacts.length} {t('deliverables.metrics.totalArtifacts')}
                              </span>
                            </div>
                          </>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <DeliverableDetailView deliverable={selected} loading={loading && !selected} />
      </div>
    </div>
  );
}