import type { MouseEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
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

const FILES_INTENT_KEY = 'af:files-intent';
const DELIVERABLES_INTENT_KEY = 'af:deliverables-intent';

interface DeliverablesIntent {
  selectedId?: string;
  category?: string | null;
  sourceKind?: DeliverableSource['kind'];
  query?: string;
}

interface FilesIntent {
  deliverableId: string;
  deliverableTitle: string;
  sourceKind: DeliverableSource['kind'];
  category?: string | null;
  artifactId?: string;
  artifactName?: string;
}

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
  const intentSelectedIdRef = useRef<string | null>(null);
  const intentRecoveryDoneRef = useRef(false);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [highlightFilter, setHighlightFilter] = useState<HighlightFilter>('all');
  const [data, setData] = useState<DeliverableListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // category & multi-select
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  // modals
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [mergeModalOpen, setMergeModalOpen] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState<string | null>(null);
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [categoryInput, setCategoryInput] = useState('');

  useEffect(() => {
    const raw = sessionStorage.getItem(DELIVERABLES_INTENT_KEY);
    if (!raw) return;
    sessionStorage.removeItem(DELIVERABLES_INTENT_KEY);
    try {
      const intent = JSON.parse(raw) as DeliverablesIntent;
      if (intent.selectedId) {
        intentSelectedIdRef.current = intent.selectedId;
        intentRecoveryDoneRef.current = false;
        setSelectedId(intent.selectedId);
      }
      if (intent.category !== undefined) setCategoryFilter(intent.category ?? null);
      if (intent.sourceKind) setSourceFilter(intent.sourceKind);
      if (intent.query) setQuery(intent.query);
    } catch {
      // ignore invalid intent payload
    }
  }, []);

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

  const categories = useMemo(() => {
    const cats = new Set<string>();
    for (const item of data?.items ?? []) {
      if (item.category) cats.add(item.category);
    }
    return Array.from(cats).sort();
  }, [data?.items]);

  const filteredItems = useMemo(() => {
    const items = data?.items ?? [];
    return items.filter((item) => {
      if (!inTimeRange(item.createdAt, timeRange)) return false;
      if (highlightFilter === 'media' && !hasMediaArtifacts(item)) return false;
      if (highlightFilter === 'problem' && item.status !== 'error' && item.status !== 'cancelled') return false;
      if (categoryFilter !== null) {
        if (categoryFilter === '') { if (item.category) return false; }
        else { if (item.category !== categoryFilter) return false; }
      }
      return true;
    });
  }, [data?.items, highlightFilter, timeRange, categoryFilter]);

  const selected = useMemo<DeliverableRecord | null>(() => {
    const items = filteredItems;
    if (items.length === 0) return null;
    return items.find((item) => item.id === selectedId) ?? items[0] ?? null;
  }, [filteredItems, selectedId]);

  useEffect(() => {
    const targetId = intentSelectedIdRef.current;
    if (!targetId || intentRecoveryDoneRef.current || loading || !data) return;
    const targetExists = data.items.some((item) => item.id === targetId);
    if (!targetExists) {
      intentRecoveryDoneRef.current = true;
      return;
    }
    const targetVisible = filteredItems.some((item) => item.id === targetId);
    if (!targetVisible) {
      setSourceFilter('all');
      setStatusFilter('all');
      setTimeRange('all');
      setHighlightFilter('all');
      setCategoryFilter(null);
      setQuery('');
      setSelectedId(targetId);
    }
    intentRecoveryDoneRef.current = true;
  }, [data, filteredItems, loading]);

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

  const exitSelectMode = () => { setSelectMode(false); setSelectedIds(new Set()); };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const reloadData = () => { setData(null); setLoading(true); };

  const handleBatchDelete = async () => {
    try {
      await rpc('deliverable.deleteMany', { ids: Array.from(selectedIds) });
      toast(t('deliverables.delete.batchSuccess').replace('{n}', String(selectedIds.size)), 'success');
      reloadData(); exitSelectMode(); setDeleteConfirmOpen(false);
    } catch { toast(t('deliverables.delete.failed'), 'error'); }
  };

  const handleSingleDelete = async (id: string, e: MouseEvent) => {
    e.stopPropagation();
    try {
      await rpc('deliverable.delete', { deliverableId: id });
      toast(t('deliverables.delete.success'), 'success');
      if (selectedId === id) setSelectedId(null);
      reloadData();
    } catch { toast(t('deliverables.delete.failed'), 'error'); }
  };

  const handleMerge = async () => {
    if (!mergeTargetId) return;
    const sourceIds = Array.from(selectedIds).filter((id) => id !== mergeTargetId);
    try {
      await rpc('deliverable.merge', { targetId: mergeTargetId, sourceIds });
      toast(t('deliverables.merge.success'), 'success');
      reloadData(); setMergeModalOpen(false); setMergeTargetId(null); exitSelectMode();
    } catch { toast(t('deliverables.merge.failed'), 'error'); }
  };

  const handleSetCategory = async () => {
    const ids = Array.from(selectedIds);
    const cat = categoryInput.trim() || null;
    try {
      for (const id of ids) await rpc('deliverable.setCategory', { deliverableId: id, category: cat });
      toast(t('deliverables.category.success'), 'success');
      reloadData(); setCategoryModalOpen(false); setCategoryInput(''); exitSelectMode();
    } catch { toast(t('deliverables.category.failed'), 'error'); }
  };

  const openInFiles = (item: DeliverableRecord, artifact?: { id: string; name: string }) => {
    const intent: FilesIntent = {
      deliverableId: item.id,
      deliverableTitle: item.title,
      sourceKind: item.source.kind,
      category: item.category ?? null,
      artifactId: artifact?.id,
      artifactName: artifact?.name,
    };
    sessionStorage.setItem(FILES_INTENT_KEY, JSON.stringify(intent));
    window.dispatchEvent(new CustomEvent('af:navigate', { detail: { tab: 'files' } }));
  };

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

          {/* Category tree — file-manager style */}
          <div className="rounded-lg border border-white/8 p-4 backdrop-blur-xl" style={{ background: 'var(--af-card-bg)' }}>
            <div className="mb-3 text-[11px] uppercase tracking-[0.22em]" style={{ color: 'var(--af-text-faint)' }}>
              {t('deliverables.category.title')}
            </div>
            <div className="flex flex-col gap-1">
              {/* All */}
              <button
                onClick={() => setCategoryFilter(null)}
                className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${categoryFilter === null ? 'bg-cyan-500/15 text-cyan-200 ring-1 ring-cyan-400/30' : 'bg-white/[0.04] hover:text-white'}`}
                style={categoryFilter !== null ? { color: 'var(--af-text-muted)' } : undefined}
              >
                <span>📋 {t('deliverables.category.all')}</span>
                <span className="text-[11px] opacity-70">{data?.items.length ?? 0}</span>
              </button>
              {/* Uncategorized */}
              <button
                onClick={() => setCategoryFilter('')}
                className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${categoryFilter === '' ? 'bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/30' : 'bg-white/[0.04] hover:text-white'}`}
                style={categoryFilter !== '' ? { color: 'var(--af-text-muted)' } : undefined}
              >
                <span>📄 {t('deliverables.category.uncategorized')}</span>
                <span className="text-[11px] opacity-70">{(data?.items ?? []).filter((i) => !i.category).length}</span>
              </button>
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setCategoryFilter(cat)}
                  className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${categoryFilter === cat ? 'bg-fuchsia-500/15 text-fuchsia-200 ring-1 ring-fuchsia-400/30' : 'bg-white/[0.04] hover:text-white'}`}
                  style={categoryFilter !== cat ? { color: 'var(--af-text-muted)' } : undefined}
                >
                  <span className="truncate">📁 {cat}</span>
                  <span className="ml-1 shrink-0 text-[11px] opacity-70">{(data?.items ?? []).filter((i) => i.category === cat).length}</span>
                </button>
              ))}
            </div>
          </div>

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
            <div className="mb-3 flex items-center justify-between gap-2">
              <Badge variant="gray">{filteredItems.length}</Badge>
              <button
                onClick={() => { setSelectMode(!selectMode); if (selectMode) exitSelectMode(); }}
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${selectMode ? 'bg-cyan-500/15 text-cyan-200 ring-1 ring-cyan-400/30' : 'bg-white/[0.04] hover:text-white'}`}
                style={!selectMode ? { color: 'var(--af-text-muted)' } : undefined}
              >
                {selectMode ? t('deliverables.select.cancelSelect') : t('deliverables.select.toggle')}
              </button>
            </div>

            {/* Multi-select action bar */}
            {selectedIds.size > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2">
                <span className="text-xs font-medium text-amber-200">
                  {t('deliverables.select.count').replace('{n}', String(selectedIds.size))}
                </span>
                <button
                  onClick={() => setDeleteConfirmOpen(true)}
                  className="rounded px-2 py-0.5 text-[11px] font-medium text-rose-300 ring-1 ring-rose-400/30 hover:bg-rose-500/15 transition-colors"
                >
                  🗑 {t('deliverables.delete.batchAction')}
                </button>
                <button
                  onClick={() => setMergeModalOpen(true)}
                  className="rounded px-2 py-0.5 text-[11px] font-medium text-fuchsia-300 ring-1 ring-fuchsia-400/30 hover:bg-fuchsia-500/15 transition-colors"
                >
                  🔀 {t('deliverables.merge.title')}
                </button>
                <button
                  onClick={() => setCategoryModalOpen(true)}
                  className="rounded px-2 py-0.5 text-[11px] font-medium text-cyan-300 ring-1 ring-cyan-400/30 hover:bg-cyan-500/15 transition-colors"
                >
                  📁 {t('deliverables.category.setLabel')}
                </button>
                <button
                  onClick={exitSelectMode}
                  className="ml-auto text-xs"
                  style={{ color: 'var(--af-text-faint)' }}
                >
                  ✕
                </button>
              </div>
            )}

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
                const checked = selectedIds.has(item.id);
                const mediaCount = mediaArtifactCount(item);
                const inSelectMode = selectMode || selectedIds.size > 0;
                return (
                  <div key={item.id} className="group relative">
                    <button
                      onClick={() => inSelectMode ? toggleSelect(item.id) : setSelectedId(item.id)}
                      className={`w-full rounded-md border px-4 py-3 text-left transition-all ${
                        checked
                          ? 'border-cyan-400/50 bg-cyan-500/15 shadow-[0_0_0_1px_rgba(6,182,212,0.2)]'
                          : active
                            ? 'border-cyan-400/35 bg-cyan-500/10 shadow-[0_20px_50px_rgba(6,182,212,0.08)]'
                            : 'border-white/8 hover:border-white/15 hover:bg-white/[0.03]'
                      }`}
                      style={checked || active ? undefined : { background: 'var(--af-surface-2)' }}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        {inSelectMode && (
                          <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[11px] border ${checked ? 'border-cyan-400 bg-cyan-500/20 text-cyan-300' : 'border-white/20 text-white/30'}`}>
                            {checked ? '✓' : ''}
                          </span>
                        )}
                        <Badge
                          variant={item.status === 'ready' ? 'green' : item.status === 'error' ? 'red' : 'gray'}
                        >
                          {item.status}
                        </Badge>
                        <Badge variant={sourceBadgeVariant(item.source.kind)}>
                          {t(`deliverables.source.${sourceKeyLabel(item.source.kind)}`)}
                        </Badge>
                        {mediaCount > 0 && (
                          <Badge variant="green">{t('deliverables.card.mediaCount', { n: String(mediaCount) })}</Badge>
                        )}
                        {item.category && (
                          <span className="rounded bg-fuchsia-500/10 px-1.5 py-0.5 text-[10px] text-fuchsia-300">
                            📁 {item.category}
                          </span>
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
                    {/* Single-item delete button (hover) */}
                    {!inSelectMode && (
                      <div className="absolute right-2 top-2 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openInFiles(item);
                          }}
                          className="rounded p-1 hover:bg-cyan-500/20 text-cyan-300 text-xs"
                          title={t('nav.files')}
                        >
                          📁
                        </button>
                        <button
                          onClick={(e) => { void handleSingleDelete(item.id, e); }}
                          className="rounded p-1 hover:bg-rose-500/20 text-rose-400 text-xs"
                          title={t('deliverables.delete.action')}
                        >
                          🗑
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <DeliverableDetailView
            deliverable={selected}
            loading={loading && !selected}
            onOpenFiles={(artifact) => {
              if (!selected) return;
              openInFiles(selected, artifact ? { id: artifact.id, name: artifact.name } : undefined);
            }}
          />
        </div>
      </div>

      {/* ── Delete confirm modal ── */}
      {deleteConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-xl border border-rose-400/20 p-6 shadow-2xl" style={{ background: 'var(--af-card-bg)' }}>
            <div className="mb-4 text-base font-semibold text-rose-200">
              {t('deliverables.delete.batchAction')}
            </div>
            <p className="mb-6 text-sm" style={{ color: 'var(--af-text-muted)' }}>
              {t('deliverables.delete.batchConfirm').replace('{n}', String(selectedIds.size))}
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteConfirmOpen(false)}
                className="rounded-lg px-4 py-2 text-sm hover:bg-white/[0.06] transition-colors"
                style={{ color: 'var(--af-text-muted)' }}
              >
                {t('agents.cancel')}
              </button>
              <button
                onClick={() => { void handleBatchDelete(); }}
                className="rounded-lg bg-rose-600/80 px-4 py-2 text-sm font-medium text-white hover:bg-rose-600 transition-colors"
              >
                {t('deliverables.delete.batchAction')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Merge modal ── */}
      {mergeModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-fuchsia-400/20 p-6 shadow-2xl" style={{ background: 'var(--af-card-bg)' }}>
            <div className="mb-2 text-base font-semibold text-fuchsia-200">{t('deliverables.merge.title')}</div>
            <p className="mb-4 text-xs" style={{ color: 'var(--af-text-muted)' }}>{t('deliverables.merge.hint')}</p>
            <div className="mb-4 flex max-h-60 flex-col gap-2 overflow-y-auto">
              {filteredItems.filter((i) => !selectedIds.has(i.id)).map((item) => (
                <button
                  key={item.id}
                  onClick={() => setMergeTargetId(item.id)}
                  className={`rounded-md border px-3 py-2 text-left text-xs transition-colors ${mergeTargetId === item.id ? 'border-fuchsia-400/50 bg-fuchsia-500/15 text-fuchsia-200' : 'border-white/8 hover:border-white/15'}`}
                  style={mergeTargetId !== item.id ? { background: 'var(--af-surface-2)', color: 'var(--af-text-base)' } : undefined}
                >
                  {mergeTargetId === item.id ? '◉' : '○'} {item.title}
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => { setMergeModalOpen(false); setMergeTargetId(null); }}
                className="rounded-lg px-4 py-2 text-sm hover:bg-white/[0.06] transition-colors"
                style={{ color: 'var(--af-text-muted)' }}
              >
                {t('agents.cancel')}
              </button>
              <button
                onClick={() => { void handleMerge(); }}
                disabled={!mergeTargetId}
                className="rounded-lg bg-fuchsia-600/80 px-4 py-2 text-sm font-medium text-white hover:bg-fuchsia-600 transition-colors disabled:opacity-40"
              >
                {t('deliverables.merge.action')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Category assign modal ── */}
      {categoryModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-xl border border-cyan-400/20 p-6 shadow-2xl" style={{ background: 'var(--af-card-bg)' }}>
            <div className="mb-4 text-base font-semibold text-cyan-200">{t('deliverables.category.setLabel')}</div>
            <input
              value={categoryInput}
              onChange={(e) => setCategoryInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSetCategory(); }}
              placeholder={t('deliverables.category.placeholder')}
              autoFocus
              className="mb-2 w-full rounded-lg border border-white/10 px-3 py-2 text-sm outline-none focus:border-cyan-400/40"
              style={{ background: 'var(--af-input-bg)', color: 'var(--af-text-base)' }}
            />
            {categories.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-1">
                {categories.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setCategoryInput(cat)}
                    className="rounded bg-white/[0.06] px-2 py-0.5 text-[11px] transition-colors hover:bg-white/[0.1]"
                    style={{ color: 'var(--af-text-muted)' }}
                  >
                    {cat}
                  </button>
                ))}
                <button
                  onClick={() => setCategoryInput('')}
                  className="rounded bg-white/[0.04] px-2 py-0.5 text-[11px] text-rose-300/70 transition-colors hover:text-rose-300"
                >
                  {t('deliverables.category.clear')}
                </button>
              </div>
            )}
            <div className="flex justify-end gap-3">
              <button
                onClick={() => { setCategoryModalOpen(false); setCategoryInput(''); }}
                className="rounded-lg px-4 py-2 text-sm hover:bg-white/[0.06] transition-colors"
                style={{ color: 'var(--af-text-muted)' }}
              >
                {t('agents.cancel')}
              </button>
              <button
                onClick={() => { void handleSetCategory(); }}
                className="rounded-lg bg-cyan-600/80 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-600 transition-colors"
              >
                {t('deliverables.category.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}