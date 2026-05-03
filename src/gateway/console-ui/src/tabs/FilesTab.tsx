import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { useLocale } from '../context/i18n.js';
import { rpc } from '../hooks/useRpc.js';
import { useToast } from '../hooks/useToast.js';
import type { DeliverableSource, FlatArtifact } from '../types.js';

const CONTENT_BASE = window.location.origin;
const CONTENT_TOKEN = encodeURIComponent(window.__AF_TOKEN__);

type SortKey = 'newest' | 'oldest' | 'name' | 'size';
type ViewMode = 'grid' | 'list';
type SourceFilter = DeliverableSource['kind'] | 'all';
type OrganizationMode = 'flat' | 'deliverable';

const FILES_INTENT_KEY = 'af:files-intent';
const DELIVERABLES_INTENT_KEY = 'af:deliverables-intent';

interface FilesIntent {
  deliverableId: string;
  deliverableTitle: string;
  sourceKind: DeliverableSource['kind'];
  category?: string | null;
  artifactId?: string;
  artifactName?: string;
}

interface DeliverablesIntent {
  selectedId?: string;
  category?: string | null;
  sourceKind?: DeliverableSource['kind'];
  query?: string;
}

function artifactContentUrl(contentItemId: string): string {
  return `${CONTENT_BASE}/api/content/${encodeURIComponent(contentItemId)}?token=${CONTENT_TOKEN}`;
}

function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  queueMicrotask(() => document.body.removeChild(a));
}

function formatBytes(size?: number): string {
  if (!size || size <= 0) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sourceLabel(
  source: DeliverableSource,
  t: (k: string, v?: Record<string, string>) => string,
): string {
  if (source.kind === 'workflow_run') return `${t('files.source.workflow')}: ${source.workflowName}`;
  if (source.kind === 'scheduler_task_run') return `${t('files.source.scheduler')}: ${source.taskName}`;
  return `${t('files.source.chat')}: ${source.agentId}`;
}

function sourceBadgeVariant(source: DeliverableSource): 'blue' | 'purple' | 'green' {
  if (source.kind === 'workflow_run') return 'blue';
  if (source.kind === 'scheduler_task_run') return 'purple';
  return 'green';
}

function formatIcon(format: string): string {
  const map: Record<string, string> = {
    image: '🖼',
    video: '🎬',
    audio: '🎵',
    pdf: '📄',
    html: '🌐',
    markdown: '📝',
    json: '{ }',
    csv: '📊',
    spreadsheet: '📊',
    docx: '📃',
    text: '📋',
    file: '📎',
  };
  return map[format] ?? '📎';
}

function sortArtifacts(items: FlatArtifact[], key: SortKey): FlatArtifact[] {
  const copy = [...items];
  if (key === 'newest') return copy.sort((a, b) => b.createdAt - a.createdAt);
  if (key === 'oldest') return copy.sort((a, b) => a.createdAt - b.createdAt);
  if (key === 'name') return copy.sort((a, b) => a.name.localeCompare(b.name));
  if (key === 'size') return copy.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  return copy;
}

interface ModalShellProps {
  children: React.ReactNode;
  onClose: () => void;
}

function ModalShell({ children, onClose }: ModalShellProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0, 0, 0, 0.68)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl p-5"
        style={{
          background: 'var(--af-overlay-bg)',
          border: '1px solid var(--af-overlay-border)',
          boxShadow: '0 28px 80px rgba(0,0,0,0.5)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

interface RenameModalProps {
  artifact: FlatArtifact;
  onClose: () => void;
  onDone: () => void;
}

function RenameModal({ artifact, onClose, onDone }: RenameModalProps) {
  const { t } = useLocale();
  const { toast } = useToast();
  const [value, setValue] = useState(artifact.name);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (!value.trim()) return;
    setBusy(true);
    try {
      await rpc('artifact.rename', {
        deliverableId: artifact.deliverableId,
        artifactId: artifact.id,
        name: value.trim(),
      });
      toast(t('files.artifact.rename'), 'success');
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose}>
      <div className="text-sm font-semibold" style={{ color: 'var(--af-text-heading)' }}>
        {t('files.artifact.renameTitle')}
      </div>
      <div className="mt-1 text-xs truncate" style={{ color: 'var(--af-text-muted)' }}>{artifact.name}</div>
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t('files.artifact.namePlaceholder')}
        className="mt-4 w-full rounded-lg px-3 py-2 text-sm outline-none"
        style={{
          background: 'var(--af-input-bg)',
          color: 'var(--af-text-base)',
          border: '1px solid var(--af-input-ring)',
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
          if (e.key === 'Escape') onClose();
        }}
      />
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button variant="primary" size="sm" onClick={() => void submit()} disabled={busy || !value.trim()}>
          {t('files.category.confirm')}
        </Button>
      </div>
    </ModalShell>
  );
}

interface SetCategoryModalProps {
  artifacts: FlatArtifact[];
  categories: string[];
  onClose: () => void;
  onDone: () => void;
}

function SetCategoryModal({ artifacts, categories, onClose, onDone }: SetCategoryModalProps) {
  const { t } = useLocale();
  const { toast } = useToast();
  const [value, setValue] = useState(artifacts[0]?.category ?? '');
  const [busy, setBusy] = useState(false);

  async function submit(clear = false): Promise<void> {
    setBusy(true);
    try {
      for (const artifact of artifacts) {
        await rpc('artifact.setCategory', {
          deliverableId: artifact.deliverableId,
          artifactId: artifact.id,
          category: clear ? null : value.trim() || null,
        });
      }
      toast(clear ? t('files.category.clear') : t('files.category.set'), 'success');
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose}>
      <div className="text-sm font-semibold" style={{ color: 'var(--af-text-heading)' }}>
        {t('files.category.set')}
      </div>
      <div className="mt-1 text-xs" style={{ color: 'var(--af-text-muted)' }}>
        {artifacts.length > 1 ? `${artifacts.length} files` : artifacts[0]?.name}
      </div>
      {categories.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {categories.slice(0, 10).map((category) => (
            <button
              key={category}
              type="button"
              className="rounded-md px-2 py-0.5 text-xs"
              style={{
                background: value === category ? 'var(--af-accent-soft)' : 'var(--af-surface-2)',
                color: value === category ? 'var(--af-accent-text)' : 'var(--af-text-muted)',
                border: '1px solid var(--af-border)',
              }}
              onClick={() => setValue(category)}
            >
              {category}
            </button>
          ))}
        </div>
      )}
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t('files.category.placeholder')}
        className="mt-4 w-full rounded-lg px-3 py-2 text-sm outline-none"
        style={{
          background: 'var(--af-input-bg)',
          color: 'var(--af-text-base)',
          border: '1px solid var(--af-input-ring)',
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit(false);
          if (e.key === 'Escape') onClose();
        }}
      />
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => void submit(true)} disabled={busy}>
          {t('files.category.clear')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button variant="primary" size="sm" onClick={() => void submit(false)} disabled={busy}>
          {t('files.category.confirm')}
        </Button>
      </div>
    </ModalShell>
  );
}

interface DeleteModalProps {
  artifacts: FlatArtifact[];
  onClose: () => void;
  onDone: () => void;
}

function DeleteModal({ artifacts, onClose, onDone }: DeleteModalProps) {
  const { t } = useLocale();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    try {
      for (const artifact of artifacts) {
        await rpc('artifact.delete', {
          deliverableId: artifact.deliverableId,
          artifactId: artifact.id,
        });
      }
      toast(t('files.artifact.delete'), 'success');
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Error', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose}>
      <div className="text-sm font-semibold text-rose-300">{t('files.artifact.delete')}</div>
      <div className="mt-2 text-xs" style={{ color: 'var(--af-text-muted)' }}>
        {artifacts.length > 1 ? `${t('files.artifact.deleteConfirm')} (${artifacts.length} files)` : t('files.artifact.deleteConfirm')}
      </div>
      <div className="mt-2 text-xs truncate" style={{ color: 'var(--af-text-base)' }}>
        {artifacts.length > 1 ? artifacts.map((a) => a.name).slice(0, 3).join(' / ') : artifacts[0]?.name}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button variant="danger" size="sm" onClick={() => void submit()} disabled={busy}>
          {t('files.artifact.delete')}
        </Button>
      </div>
    </ModalShell>
  );
}

interface FileItemProps {
  artifact: FlatArtifact;
  rowId: string;
  focused: boolean;
  checked: boolean;
  onToggle: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
  onOpenDeliverable: () => void;
  mode: ViewMode;
  t: (k: string, v?: Record<string, string>) => string;
}

type ActionTone = 'neutral' | 'danger';

interface ActionIconButtonProps {
  label: string;
  icon: string;
  tone?: ActionTone;
  onClick: () => void;
  disabled?: boolean;
}

function ActionIconButton({ label, icon, tone = 'neutral', onClick, disabled = false }: ActionIconButtonProps) {
  const isDanger = tone === 'danger';
  return (
    <div className="relative group/action">
      <button
        type="button"
        title={label}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md border text-xs transition-all duration-150 hover:-translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2"
        style={{
          borderColor: isDanger ? 'rgba(251,113,133,0.45)' : 'var(--af-border)',
          background: isDanger ? 'rgba(244,63,94,0.13)' : 'var(--af-surface-2)',
          color: isDanger ? 'rgb(254,205,211)' : 'var(--af-text-muted)',
          boxShadow: isDanger ? '0 0 0 0 rgba(244,63,94,0)' : '0 0 0 0 rgba(6,182,212,0)',
          // Focus ring color differs for destructive action to reduce misclick risk.
          ['--tw-ring-color' as string]: isDanger ? 'rgba(244,63,94,0.35)' : 'rgba(6,182,212,0.35)',
        }}
      >
        <span aria-hidden="true">{icon}</span>
      </button>
      <span
        className="pointer-events-none absolute -top-8 left-1/2 z-20 -translate-x-1/2 rounded-md px-1.5 py-1 text-[10px] opacity-0 transition-opacity duration-150 group-hover/action:opacity-100"
        style={{
          background: 'var(--af-overlay-bg)',
          border: '1px solid var(--af-overlay-border)',
          color: 'var(--af-text-base)',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    </div>
  );
}

function FileItem({ artifact, rowId, focused, checked, onToggle, onRename, onMove, onDelete, onOpenDeliverable, mode, t }: FileItemProps) {
  const source = sourceLabel(artifact.deliverableSource, t);
  const canDownload = !!artifact.contentItemId;
  const download = () => {
    if (!artifact.contentItemId) return;
    triggerDownload(artifactContentUrl(artifact.contentItemId), artifact.name);
  };

  if (mode === 'list') {
    return (
      <div
        id={rowId}
        className="grid grid-cols-[26px_minmax(0,2.2fr)_120px_190px_130px_220px] items-center gap-3 px-3 py-2.5"
        style={{
          borderBottom: '1px solid var(--af-border)',
          background: focused ? 'var(--af-accent-soft)' : 'transparent',
        }}
      >
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <div className="min-w-0 flex items-center gap-2">
          <span>{formatIcon(artifact.format)}</span>
          <div className="min-w-0">
            <div className="truncate text-sm" style={{ color: 'var(--af-text-heading)' }} title={artifact.name}>{artifact.name}</div>
            <div className="truncate text-[11px]" style={{ color: 'var(--af-text-muted)' }}>{artifact.deliverableTitle}</div>
          </div>
        </div>
        <div className="text-xs" style={{ color: 'var(--af-text-muted)' }}>{formatBytes(artifact.size)}</div>
        <div className="text-xs truncate" style={{ color: 'var(--af-text-muted)' }} title={artifact.category ?? t('files.category.uncategorized')}>
          {artifact.category ?? t('files.category.uncategorized')}
        </div>
        <div className="text-xs" style={{ color: 'var(--af-text-muted)' }}>{formatDate(artifact.createdAt)}</div>
        <div
          className="ml-auto flex items-center gap-1 rounded-lg px-1.5 py-1"
          style={{ border: '1px solid var(--af-border)', background: 'var(--af-surface-2)' }}
        >
          <ActionIconButton label={t('nav.deliverables')} icon="↗" onClick={onOpenDeliverable} />
          <ActionIconButton label={t('files.artifact.download')} icon="⬇" onClick={download} disabled={!canDownload} />
          <ActionIconButton label={t('files.artifact.rename')} icon="✎" onClick={onRename} />
          <ActionIconButton label={t('files.category.set')} icon="📁" onClick={onMove} />
          <span className="mx-0.5 h-4 w-px" style={{ background: 'var(--af-border)' }} />
          <ActionIconButton label={t('files.artifact.delete')} icon="🗑" tone="danger" onClick={onDelete} />
        </div>
      </div>
    );
  }

  return (
    <div
      id={rowId}
      className="rounded-xl p-3"
      style={{
        background: focused ? 'var(--af-accent-soft)' : 'var(--af-card-bg)',
        border: focused ? '1px solid var(--af-border-strong)' : '1px solid var(--af-card-ring)',
      }}
    >
      <div className="flex items-start gap-2">
        <input type="checkbox" checked={checked} onChange={onToggle} className="mt-1" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span>{formatIcon(artifact.format)}</span>
            <div className="truncate text-sm font-medium" style={{ color: 'var(--af-text-heading)' }} title={artifact.name}>{artifact.name}</div>
          </div>
          <div className="mt-1 truncate text-[11px]" style={{ color: 'var(--af-text-muted)' }}>{artifact.deliverableTitle}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge variant={sourceBadgeVariant(artifact.deliverableSource)}>{source}</Badge>
            <Badge variant="gray">{formatBytes(artifact.size)}</Badge>
            {artifact.category && <Badge variant="blue">{artifact.category}</Badge>}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <div className="text-[11px]" style={{ color: 'var(--af-text-muted)' }}>{formatDate(artifact.createdAt)}</div>
        <div
          className="flex items-center gap-1 rounded-lg px-1.5 py-1"
          style={{ border: '1px solid var(--af-border)', background: 'var(--af-surface-2)' }}
        >
          <ActionIconButton label={t('nav.deliverables')} icon="↗" onClick={onOpenDeliverable} />
          <ActionIconButton label={t('files.artifact.download')} icon="⬇" onClick={download} disabled={!canDownload} />
          <ActionIconButton label={t('files.artifact.rename')} icon="✎" onClick={onRename} />
          <ActionIconButton label={t('files.category.set')} icon="📁" onClick={onMove} />
          <span className="mx-0.5 h-4 w-px" style={{ background: 'var(--af-border)' }} />
          <ActionIconButton label={t('files.artifact.delete')} icon="🗑" tone="danger" onClick={onDelete} />
        </div>
      </div>
    </div>
  );
}

export function FilesTab() {
  const { t } = useLocale();
  const { toast } = useToast();

  const [allArtifacts, setAllArtifacts] = useState<FlatArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('newest');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [organizationMode, setOrganizationMode] = useState<OrganizationMode>('flat');
  const [focusedArtifactKey, setFocusedArtifactKey] = useState<string | null>(null);
  const [intentContext, setIntentContext] = useState<FilesIntent | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [renameTarget, setRenameTarget] = useState<FlatArtifact | null>(null);
  const [moveTargets, setMoveTargets] = useState<FlatArtifact[] | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<FlatArtifact[] | null>(null);

  const load = useCallback(async () => {
    try {
      const items = await rpc<FlatArtifact[]>('artifact.listAll');
      setAllArtifacts(items);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to load files', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const raw = sessionStorage.getItem(FILES_INTENT_KEY);
    if (!raw) return;
    sessionStorage.removeItem(FILES_INTENT_KEY);
    try {
      const intent = JSON.parse(raw) as FilesIntent;
      setIntentContext(intent);
      setSourceFilter(intent.sourceKind);
      setCategoryFilter(intent.category ?? null);
      setSearch(intent.artifactName ?? intent.deliverableTitle);
      if (intent.artifactId) setFocusedArtifactKey(`${intent.deliverableId}:${intent.artifactId}`);
    } catch {
      // ignore invalid payload
    }
  }, []);

  useEffect(() => {
    if (!focusedArtifactKey) return;
    const element = document.getElementById(`file-item-${focusedArtifactKey}`);
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusedArtifactKey, viewMode, allArtifacts.length]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const artifact of allArtifacts) {
      if (artifact.category?.trim()) set.add(artifact.category.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allArtifacts]);

  const filtered = useMemo(() => {
    let items = allArtifacts;
    if (categoryFilter === '') items = items.filter((a) => !a.category);
    else if (categoryFilter !== null) items = items.filter((a) => a.category === categoryFilter);

    if (sourceFilter !== 'all') items = items.filter((a) => a.deliverableSource.kind === sourceFilter);

    const q = search.trim().toLowerCase();
    if (q) {
      items = items.filter((a) =>
        a.name.toLowerCase().includes(q)
        || a.deliverableTitle.toLowerCase().includes(q)
        || (a.category ?? '').toLowerCase().includes(q),
      );
    }

    return sortArtifacts(items, sortKey);
  }, [allArtifacts, categoryFilter, sourceFilter, search, sortKey]);

  const categoryCountMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const artifact of allArtifacts) {
      if (artifact.category) m.set(artifact.category, (m.get(artifact.category) ?? 0) + 1);
    }
    return m;
  }, [allArtifacts]);

  const selectedArtifacts = useMemo(
    () => filtered.filter((a) => selectedIds.has(`${a.deliverableId}:${a.id}`)),
    [filtered, selectedIds],
  );

  const groupedByDeliverable = useMemo(() => {
    const groups = new Map<
      string,
      { deliverableId: string; deliverableTitle: string; source: DeliverableSource; items: FlatArtifact[] }
    >();
    for (const artifact of filtered) {
      const key = artifact.deliverableId;
      const group = groups.get(key);
      if (group) {
        group.items.push(artifact);
      } else {
        groups.set(key, {
          deliverableId: artifact.deliverableId,
          deliverableTitle: artifact.deliverableTitle,
          source: artifact.deliverableSource,
          items: [artifact],
        });
      }
    }
    return Array.from(groups.values()).sort((a, b) => b.items.length - a.items.length);
  }, [filtered]);

  const allVisibleSelected = filtered.length > 0 && filtered.every((a) => selectedIds.has(`${a.deliverableId}:${a.id}`));

  const toggleSelected = (artifact: FlatArtifact): void => {
    const key = `${artifact.deliverableId}:${artifact.id}`;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSelectAllVisible = (): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const artifact of filtered) next.delete(`${artifact.deliverableId}:${artifact.id}`);
      } else {
        for (const artifact of filtered) next.add(`${artifact.deliverableId}:${artifact.id}`);
      }
      return next;
    });
  };

  const clearSelection = (): void => setSelectedIds(new Set());

  const finishMutation = async (): Promise<void> => {
    setRenameTarget(null);
    setMoveTargets(null);
    setDeleteTargets(null);
    clearSelection();
    await load();
  };

  const openDeliverable = (artifact: FlatArtifact): void => {
    const intent: DeliverablesIntent = {
      selectedId: artifact.deliverableId,
      sourceKind: artifact.deliverableSource.kind,
      query: artifact.deliverableTitle,
    };
    sessionStorage.setItem(DELIVERABLES_INTENT_KEY, JSON.stringify(intent));
    window.dispatchEvent(new CustomEvent('af:navigate', { detail: { tab: 'deliverables' } }));
  };

  const backToIntentDeliverable = (): void => {
    if (!intentContext) return;
    const intent: DeliverablesIntent = {
      selectedId: intentContext.deliverableId,
      category: intentContext.category ?? null,
      sourceKind: intentContext.sourceKind,
      query: intentContext.deliverableTitle,
    };
    sessionStorage.setItem(DELIVERABLES_INTENT_KEY, JSON.stringify(intent));
    window.dispatchEvent(new CustomEvent('af:navigate', { detail: { tab: 'deliverables' } }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40 gap-2.5">
        <div
          className="w-4 h-4 rounded-full border-2 animate-spin"
          style={{ borderColor: 'var(--af-border)', borderTopColor: 'var(--af-accent)' }}
        />
        <span className="text-sm" style={{ color: 'var(--af-text-muted)' }}>{t('files.loading')}</span>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--af-border)' }}>
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em]" style={{ color: 'var(--af-text-faint)' }}>{t('files.kicker')}</div>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--af-text-heading)' }}>{t('files.title')}</h2>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex overflow-hidden rounded-lg" style={{ border: '1px solid var(--af-border)' }}>
              <button
                className="px-2.5 py-1 text-xs"
                style={organizationMode === 'flat'
                  ? { background: 'var(--af-accent-soft)', color: 'var(--af-accent-text)' }
                  : { background: 'var(--af-surface-2)', color: 'var(--af-text-muted)' }}
                onClick={() => setOrganizationMode('flat')}
              >
                {t('files.group.flat')}
              </button>
              <button
                className="px-2.5 py-1 text-xs"
                style={organizationMode === 'deliverable'
                  ? { background: 'var(--af-accent-soft)', color: 'var(--af-accent-text)' }
                  : { background: 'var(--af-surface-2)', color: 'var(--af-text-muted)' }}
                onClick={() => setOrganizationMode('deliverable')}
              >
                {t('files.group.deliverable')}
              </button>
            </div>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('files.searchPlaceholder')}
              className="w-72 rounded-lg px-3 py-1.5 text-sm outline-none"
              style={{
                background: 'var(--af-input-bg)',
                color: 'var(--af-text-base)',
                border: '1px solid var(--af-input-ring)',
              }}
            />
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="rounded-lg px-2 py-1.5 text-xs outline-none"
              style={{ background: 'var(--af-surface-2)', color: 'var(--af-text-base)', border: '1px solid var(--af-border)' }}
            >
              <option value="newest">{t('files.sort.newest')}</option>
              <option value="oldest">{t('files.sort.oldest')}</option>
              <option value="name">{t('files.sort.name')}</option>
              <option value="size">{t('files.sort.size')}</option>
            </select>
            <div className="flex overflow-hidden rounded-lg" style={{ border: '1px solid var(--af-border)' }}>
              <button
                className="px-2.5 py-1 text-xs"
                style={viewMode === 'list'
                  ? { background: 'var(--af-accent-soft)', color: 'var(--af-accent-text)' }
                  : { background: 'var(--af-surface-2)', color: 'var(--af-text-muted)' }}
                onClick={() => setViewMode('list')}
              >
                {t('files.viewMode.list')}
              </button>
              <button
                className="px-2.5 py-1 text-xs"
                style={viewMode === 'grid'
                  ? { background: 'var(--af-accent-soft)', color: 'var(--af-accent-text)' }
                  : { background: 'var(--af-surface-2)', color: 'var(--af-text-muted)' }}
                onClick={() => setViewMode('grid')}
              >
                {t('files.viewMode.grid')}
              </button>
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Badge variant="gray">{t('files.count', { n: String(filtered.length) })}</Badge>
          <Badge variant="gray">{t('files.category.all')}: {allArtifacts.length}</Badge>
          <Badge variant="gray">{t('files.category.uncategorized')}: {allArtifacts.filter((a) => !a.category).length}</Badge>
        </div>
        {intentContext && (
          <div
            className="mt-3 flex flex-wrap items-center gap-2 rounded-lg px-3 py-2"
            style={{ background: 'var(--af-surface-2)', border: '1px solid var(--af-border)' }}
          >
            <span className="text-xs" style={{ color: 'var(--af-text-muted)' }}>
              {t('files.context.fromDeliverable')}
            </span>
            <span className="text-xs font-medium" style={{ color: 'var(--af-text-heading)' }}>
              {intentContext.deliverableTitle}
            </span>
            {intentContext.artifactName && (
              <span className="text-xs" style={{ color: 'var(--af-text-muted)' }}>
                · {intentContext.artifactName}
              </span>
            )}
            <div className="ml-auto">
              <Button variant="ghost" size="sm" onClick={backToIntentDeliverable}>
                {t('files.context.backToDeliverable')}
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <aside className="w-64 shrink-0 overflow-y-auto p-3" style={{ borderRight: '1px solid var(--af-border)' }}>
          <div className="rounded-xl p-3" style={{ background: 'var(--af-card-bg)', border: '1px solid var(--af-card-ring)' }}>
            <div className="mb-2 text-[10px] uppercase tracking-[0.18em]" style={{ color: 'var(--af-text-faint)' }}>{t('files.category.title')}</div>
            <button
              className="mb-1 flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs"
              style={categoryFilter === null
                ? { background: 'var(--af-accent-soft)', color: 'var(--af-accent-text)' }
                : { color: 'var(--af-text-muted)' }}
              onClick={() => setCategoryFilter(null)}
            >
              <span>{t('files.category.all')}</span>
              <span>{allArtifacts.length}</span>
            </button>
            <button
              className="mb-1 flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs"
              style={categoryFilter === ''
                ? { background: 'var(--af-accent-soft)', color: 'var(--af-accent-text)' }
                : { color: 'var(--af-text-muted)' }}
              onClick={() => setCategoryFilter('')}
            >
              <span>{t('files.category.uncategorized')}</span>
              <span>{allArtifacts.filter((a) => !a.category).length}</span>
            </button>
            {categories.map((category) => (
              <button
                key={category}
                className="mb-1 flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs"
                style={categoryFilter === category
                  ? { background: 'var(--af-accent-soft)', color: 'var(--af-accent-text)' }
                  : { color: 'var(--af-text-muted)' }}
                onClick={() => setCategoryFilter(category)}
              >
                <span className="truncate">{category}</span>
                <span>{categoryCountMap.get(category) ?? 0}</span>
              </button>
            ))}
          </div>

          <div className="mt-3 rounded-xl p-3" style={{ background: 'var(--af-card-bg)', border: '1px solid var(--af-card-ring)' }}>
            <div className="mb-2 text-[10px] uppercase tracking-[0.18em]" style={{ color: 'var(--af-text-faint)' }}>{t('files.source.label')}</div>
            {(['all', 'workflow_run', 'scheduler_task_run', 'chat_turn'] as const).map((kind) => {
              const label = kind === 'all'
                ? t('files.category.all')
                : kind === 'workflow_run'
                  ? t('files.source.workflow')
                  : kind === 'scheduler_task_run'
                    ? t('files.source.scheduler')
                    : t('files.source.chat');
              const active = sourceFilter === kind;
              return (
                <button
                  key={kind}
                  className="mb-1 w-full rounded-lg px-2 py-1.5 text-left text-xs"
                  style={active
                    ? { background: 'var(--af-accent-soft)', color: 'var(--af-accent-text)' }
                    : { color: 'var(--af-text-muted)' }}
                  onClick={() => setSourceFilter(kind)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </aside>

        <main className="flex-1 min-w-0 overflow-hidden p-3">
          <div className="h-full rounded-xl overflow-hidden" style={{ background: 'var(--af-card-bg)', border: '1px solid var(--af-card-ring)' }}>
            <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid var(--af-border)' }}>
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAllVisible} />
              <span className="text-xs" style={{ color: 'var(--af-text-muted)' }}>已选 {selectedArtifacts.length}</span>
              {selectedArtifacts.length > 0 && (
                <>
                  <Button variant="ghost" size="sm" onClick={() => setMoveTargets(selectedArtifacts)}>{t('files.category.set')}</Button>
                  <Button variant="danger" size="sm" onClick={() => setDeleteTargets(selectedArtifacts)}>{t('files.artifact.delete')}</Button>
                  <Button variant="ghost" size="sm" onClick={clearSelection}>{t('common.cancel')}</Button>
                </>
              )}
              <div className="ml-auto text-xs" style={{ color: 'var(--af-text-muted)' }}>
                {categoryFilter === null ? t('files.category.all') : categoryFilter === '' ? t('files.category.uncategorized') : categoryFilter}
              </div>
            </div>

            {viewMode === 'list' && (
              <div className="grid grid-cols-[26px_minmax(0,2.2fr)_120px_190px_130px_220px] gap-3 px-3 py-2 text-[11px] uppercase tracking-[0.12em]"
                style={{ color: 'var(--af-text-faint)', borderBottom: '1px solid var(--af-border)' }}>
                <span></span>
                <span>Name</span>
                <span>Size</span>
                <span>Folder</span>
                <span>Created</span>
                <span className="text-right">Actions</span>
              </div>
            )}

            <div className="h-[calc(100%-88px)] overflow-auto">
              {filtered.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--af-text-muted)' }}>
                  {t('files.empty')}
                </div>
              ) : organizationMode === 'flat' && viewMode === 'list' ? (
                filtered.map((artifact) => {
                  const key = `${artifact.deliverableId}:${artifact.id}`;
                  return (
                    <FileItem
                      key={key}
                      artifact={artifact}
                      rowId={`file-item-${key}`}
                      focused={focusedArtifactKey === key}
                      checked={selectedIds.has(key)}
                      onToggle={() => toggleSelected(artifact)}
                      onRename={() => setRenameTarget(artifact)}
                      onMove={() => setMoveTargets([artifact])}
                      onDelete={() => setDeleteTargets([artifact])}
                      onOpenDeliverable={() => openDeliverable(artifact)}
                      mode="list"
                      t={t}
                    />
                  );
                })
              ) : organizationMode === 'flat' ? (
                <div className="grid gap-3 p-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
                  {filtered.map((artifact) => {
                    const key = `${artifact.deliverableId}:${artifact.id}`;
                    return (
                      <FileItem
                        key={key}
                        artifact={artifact}
                        rowId={`file-item-${key}`}
                        focused={focusedArtifactKey === key}
                        checked={selectedIds.has(key)}
                        onToggle={() => toggleSelected(artifact)}
                        onRename={() => setRenameTarget(artifact)}
                        onMove={() => setMoveTargets([artifact])}
                        onDelete={() => setDeleteTargets([artifact])}
                        onOpenDeliverable={() => openDeliverable(artifact)}
                        mode="grid"
                        t={t}
                      />
                    );
                  })}
                </div>
              ) : (
                <div className="p-3 space-y-3">
                  {groupedByDeliverable.map((group) => (
                    <div
                      key={group.deliverableId}
                      className="rounded-xl"
                      style={{ border: '1px solid var(--af-border)', background: 'var(--af-surface-3)' }}
                    >
                      <div
                        className="flex items-center gap-2 px-3 py-2"
                        style={{ borderBottom: '1px solid var(--af-border)' }}
                      >
                        <Badge variant={sourceBadgeVariant(group.source)}>{sourceLabel(group.source, t)}</Badge>
                        <div className="text-sm font-medium truncate" style={{ color: 'var(--af-text-heading)' }}>
                          {group.deliverableTitle}
                        </div>
                        <Badge variant="gray">{group.items.length}</Badge>
                        <div className="ml-auto">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openDeliverable(group.items[0]!)}
                          >
                            {t('nav.deliverables')}
                          </Button>
                        </div>
                      </div>
                      {viewMode === 'list' ? (
                        group.items.map((artifact) => {
                          const key = `${artifact.deliverableId}:${artifact.id}`;
                          return (
                            <FileItem
                              key={key}
                              artifact={artifact}
                              rowId={`file-item-${key}`}
                              focused={focusedArtifactKey === key}
                              checked={selectedIds.has(key)}
                              onToggle={() => toggleSelected(artifact)}
                              onRename={() => setRenameTarget(artifact)}
                              onMove={() => setMoveTargets([artifact])}
                              onDelete={() => setDeleteTargets([artifact])}
                              onOpenDeliverable={() => openDeliverable(artifact)}
                              mode="list"
                              t={t}
                            />
                          );
                        })
                      ) : (
                        <div className="grid gap-3 p-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
                          {group.items.map((artifact) => {
                            const key = `${artifact.deliverableId}:${artifact.id}`;
                            return (
                              <FileItem
                                key={key}
                                artifact={artifact}
                                rowId={`file-item-${key}`}
                                focused={focusedArtifactKey === key}
                                checked={selectedIds.has(key)}
                                onToggle={() => toggleSelected(artifact)}
                                onRename={() => setRenameTarget(artifact)}
                                onMove={() => setMoveTargets([artifact])}
                                onDelete={() => setDeleteTargets([artifact])}
                                onOpenDeliverable={() => openDeliverable(artifact)}
                                mode="grid"
                                t={t}
                              />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </main>
      </div>

      {renameTarget && (
        <RenameModal
          artifact={renameTarget}
          onClose={() => setRenameTarget(null)}
          onDone={() => void finishMutation()}
        />
      )}
      {moveTargets && (
        <SetCategoryModal
          artifacts={moveTargets}
          categories={categories}
          onClose={() => setMoveTargets(null)}
          onDone={() => void finishMutation()}
        />
      )}
      {deleteTargets && (
        <DeleteModal
          artifacts={deleteTargets}
          onClose={() => setDeleteTargets(null)}
          onDone={() => void finishMutation()}
        />
      )}
    </div>
  );
}
