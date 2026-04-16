import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from './Badge.js';
import { CopyButton } from './CopyButton.js';
import { MarkdownView } from './MarkdownView.js';
import { useLocale } from '../context/i18n.js';
import { rpc } from '../hooks/useRpc.js';
import { useToast } from '../hooks/useToast.js';
import type {
  ArtifactRef,
  DeliverablePublicationTarget,
  DeliverableRecord,
  WorkflowRunRecord,
  WorkflowStepResult,
} from '../types.js';

const CONTENT_BASE = `http://127.0.0.1:${window.__AF_PORT__}`;
const CONTENT_TOKEN = encodeURIComponent(window.__AF_TOKEN__);
const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
const BROWSER_PREVIEW_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

function formatBytes(size?: number): string | null {
  if (!size || size <= 0) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function artifactPreview(artifact: ArtifactRef): string | null {
  if (!artifact.textContent?.trim()) return null;
  return artifact.textContent;
}

function canFetchTextPreview(artifact: ArtifactRef): boolean {
  if (!artifact.contentItemId || !artifact.mimeType) return false;
  if ((artifact.size ?? 0) > MAX_TEXT_PREVIEW_BYTES) return false;
  if (artifact.mimeType === 'text/html') return false;
  return artifact.mimeType.startsWith('text/') || artifact.mimeType === 'application/json';
}

function canEmbedBrowserPreview(artifact: ArtifactRef): boolean {
  if (!artifact.contentItemId || !artifact.mimeType) return false;
  return artifact.mimeType === 'text/html' || BROWSER_PREVIEW_MIME_TYPES.has(artifact.mimeType);
}

function sourceLabel(
  deliverable: DeliverableRecord,
  t: (key: string, vars?: Record<string, string>) => string,
): string {
  if (deliverable.source.kind === 'workflow_run') {
    return t('deliverables.source.workflowLabel', { name: deliverable.source.workflowName });
  }
  if (deliverable.source.kind === 'scheduler_task_run') {
    return t('deliverables.source.schedulerLabel', { name: deliverable.source.taskName });
  }
  return t('deliverables.source.chatLabel', { name: deliverable.source.agentId });
}

function sourceKey(deliverable: DeliverableRecord): string {
  if (deliverable.source.kind === 'workflow_run') {
    return deliverable.source.runId;
  }
  if (deliverable.source.kind === 'scheduler_task_run') {
    return deliverable.source.runKey;
  }
  return `${deliverable.source.agentId}:${deliverable.source.threadKey}`;
}

function statusVariant(status: DeliverableRecord['status']): 'green' | 'red' | 'gray' {
  if (status === 'ready') return 'green';
  if (status === 'error') return 'red';
  return 'gray';
}

function publicationVariant(
  status: DeliverablePublicationTarget['status'],
): 'green' | 'red' | 'gray' | 'blue' {
  if (status === 'sent') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'available') return 'blue';
  return 'gray';
}

function primaryArtifact(deliverable: DeliverableRecord): ArtifactRef | undefined {
  return (
    deliverable.artifacts.find((artifact) => artifact.id === deliverable.primaryArtifactId) ??
    deliverable.artifacts[0]
  );
}

function renderArtifactTextContent(artifact: ArtifactRef, textContent: string): ReactElement {
  if (artifact.format === 'json' || artifact.format === 'csv') {
    return (
      <pre className="max-h-[680px] overflow-auto rounded-2xl bg-slate-950/70 p-5 text-xs leading-6 text-slate-300">
        {textContent}
      </pre>
    );
  }

  if (artifact.format === 'markdown' || artifact.mimeType === 'text/markdown') {
    return (
      <div className="max-h-[680px] overflow-auto rounded-2xl bg-slate-950/70 p-5">
        <MarkdownView content={textContent} />
      </div>
    );
  }

  return (
    <pre className="max-h-[680px] overflow-auto rounded-2xl bg-slate-950/70 p-5 text-xs leading-6 whitespace-pre-wrap break-words text-slate-300">
      {textContent}
    </pre>
  );
}

function artifactUrl(artifact: ArtifactRef | null | undefined): string | null {
  if (!artifact?.contentItemId) return null;
  return `${CONTENT_BASE}/api/content/${encodeURIComponent(artifact.contentItemId)}?token=${CONTENT_TOKEN}`;
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

function downloadArtifact(artifact: ArtifactRef): void {
  const url = artifactUrl(artifact);
  if (url) {
    triggerDownload(url, artifact.name);
    return;
  }
  if (artifact.textContent) {
    const blob = new Blob([artifact.textContent], { type: artifact.mimeType ?? 'text/plain' });
    const blobUrl = URL.createObjectURL(blob);
    triggerDownload(blobUrl, artifact.name);
    queueMicrotask(() => URL.revokeObjectURL(blobUrl));
  }
}

function downloadAllArtifacts(artifacts: ArtifactRef[]): void {
  // stagger by 80ms to avoid browser blocking multiple simultaneous downloads
  artifacts.forEach((artifact, idx) => {
    setTimeout(() => downloadArtifact(artifact), idx * 80);
  });
}

function renderMediaPreview(
  artifact: ArtifactRef,
  t: (key: string, vars?: Record<string, string>) => string,
): ReactElement | null {
  const url = artifactUrl(artifact);
  if (!url || !artifact.mimeType) return null;

  if (artifact.mimeType.startsWith('image/')) {
    return (
      <div className="overflow-hidden rounded-2xl border border-white/8 bg-slate-950/70">
        <img src={url} alt={artifact.name} className="max-h-[720px] w-full object-contain" />
      </div>
    );
  }

  if (artifact.mimeType.startsWith('video/')) {
    return (
      <div className="overflow-hidden rounded-2xl border border-white/8 bg-slate-950/70 p-2">
        <video controls preload="metadata" className="max-h-[720px] w-full rounded-xl" src={url} />
      </div>
    );
  }

  if (artifact.mimeType.startsWith('audio/')) {
    return (
      <div className="rounded-2xl border border-white/8 bg-slate-950/70 p-5">
        <div className="mb-3 text-sm text-slate-300">{t('deliverables.artifact.audioPreview')}</div>
        <audio controls preload="metadata" className="w-full" src={url} />
      </div>
    );
  }

  return null;
}

function ArtifactPreviewContent({
  artifact,
  t,
}: {
  artifact: ArtifactRef;
  t: (key: string, vars?: Record<string, string>) => string;
}): ReactElement | null {
  const url = artifactUrl(artifact);
  const [textContent, setTextContent] = useState<string | null>(artifact.textContent ?? null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    setTextContent(artifact.textContent ?? null);
    setLoadFailed(false);
    if (artifact.textContent || !url || !canFetchTextPreview(artifact)) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        const body = new TextDecoder('utf-8').decode(buffer);
        if (!controller.signal.aborted) {
          setTextContent(body);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [artifact.contentItemId, artifact.id, artifact.mimeType, artifact.size, artifact.textContent, url]);

  const mediaPreview = renderMediaPreview(artifact, t);
  if (mediaPreview) {
    return mediaPreview;
  }

  if (textContent?.trim()) {
    return renderArtifactTextContent(artifact, textContent);
  }

  if (loading) {
    return (
      <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/40 p-5 text-sm text-slate-500">
        {t('deliverables.artifact.loadingPreview')}
      </div>
    );
  }

  if (url && canEmbedBrowserPreview(artifact)) {
    return (
      <div className="overflow-hidden rounded-2xl border border-white/8 bg-slate-950/70">
        <div className="border-b border-white/8 px-4 py-2 text-xs text-slate-400">
          {t('deliverables.artifact.browserPreview')}
        </div>
        <iframe
          title={artifact.name}
          src={url}
          sandbox={artifact.mimeType === 'text/html' ? '' : undefined}
          className="h-[720px] w-full bg-white"
        />
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div className="rounded-2xl border border-dashed border-amber-400/20 bg-amber-500/8 p-5 text-sm text-amber-100">
        {t('deliverables.artifact.previewFailed')}
      </div>
    );
  }

  return null;
}

export function DeliverableDetailView({
  deliverable,
  loading = false,
  onPublished,
}: {
  deliverable: DeliverableRecord | null;
  loading?: boolean;
  onPublished?: () => void;
}) {
  const { t } = useLocale();
  const { toast } = useToast();
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [batchPublishing, setBatchPublishing] = useState(false);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [publicationOverrides, setPublicationOverrides] = useState<
    Record<string, Partial<DeliverablePublicationTarget>>
  >({});
  // B4: inline title/summary editing
  const [editingField, setEditingField] = useState<'title' | 'summary' | null>(null);
  const [localTitle, setLocalTitle] = useState<string | null>(null);
  const [localSummary, setLocalSummary] = useState<string | null>(null);
  // B3: file attach
  const [showAttach, setShowAttach] = useState(false);
  const [attachPath, setAttachPath] = useState('');
  const [attaching, setAttaching] = useState(false);
  // B5: execution trace
  const [traceOpen, setTraceOpen] = useState(false);
  const [traceRun, setTraceRun] = useState<WorkflowRunRecord | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const summaryInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setPublicationOverrides({});
    setPublishingId(null);
    setSelectedArtifactId(null);
    setEditingField(null);
    setLocalTitle(null);
    setLocalSummary(null);
    setShowAttach(false);
    setAttachPath('');
    setTraceOpen(false);
    setTraceRun(null);
  }, [deliverable?.id]);

  if (loading) {
    return (
      <div className="rounded-[28px] border border-white/10 bg-slate-950/70 p-8 text-sm text-slate-400">
        {t('deliverables.loading')}
      </div>
    );
  }

  if (!deliverable) {
    return (
      <div className="rounded-[28px] border border-dashed border-white/10 bg-slate-950/40 p-8 text-sm text-slate-500">
        {t('deliverables.detail.none')}
      </div>
    );
  }

  const artifacts = deliverable.artifacts;
  const activeArtifact =
    artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? primaryArtifact(deliverable);
  const preview = activeArtifact ? artifactPreview(activeArtifact) : null;
  const publications = (deliverable.publications ?? []).map((publication) => ({
    ...publication,
    ...(publicationOverrides[publication.id] ?? {}),
  }));

  const moveArtifactSelection = (nextIndex: number): void => {
    const artifact = artifacts[nextIndex];
    if (!artifact) return;
    setSelectedArtifactId(artifact.id);
    queueMicrotask(() => {
      const element = document.getElementById(`deliverable-artifact-${artifact.id}`);
      element?.focus();
    });
  };

  const handleArtifactKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveArtifactSelection(Math.min(index + 1, artifacts.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveArtifactSelection(Math.max(index - 1, 0));
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      moveArtifactSelection(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      moveArtifactSelection(artifacts.length - 1);
    }
  };

  const publishToTarget = async (publication: DeliverablePublicationTarget): Promise<void> => {
    setPublishingId(publication.id);
    try {
      await rpc('deliverable.publish', {
        deliverableId: deliverable.id,
        publicationId: publication.id,
      });
      setPublicationOverrides((current) => ({
        ...current,
        [publication.id]: {
          status: 'sent',
          lastAttemptAt: Date.now(),
        },
      }));
      toast(t('deliverables.publish.success'), 'success');
      onPublished?.();
    } catch (error) {
      setPublicationOverrides((current) => ({
        ...current,
        [publication.id]: {
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
          lastAttemptAt: Date.now(),
        },
      }));
      toast(error instanceof Error ? error.message : t('deliverables.publish.failed'), 'error');
    } finally {
      setPublishingId(null);
    }
  };

  const batchPublishAll = async (): Promise<void> => {
    setBatchPublishing(true);
    try {
      const result = await rpc<{ total: number; results: Array<{ ok: boolean }> }>(
        'deliverable.batchPublish',
        { deliverableId: deliverable.id },
      );
      const successCount = result.results.filter((r) => r.ok).length;
      toast(t('deliverables.publish.batchDone', { count: String(successCount) }), 'success');
      onPublished?.();
    } catch (error) {
      toast(error instanceof Error ? error.message : t('deliverables.publish.failed'), 'error');
    } finally {
      setBatchPublishing(false);
    }
  };

  const saveField = async (field: 'title' | 'summary', value: string): Promise<void> => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (field === 'title') setLocalTitle(trimmed);
    else setLocalSummary(trimmed);
    try {
      await rpc('deliverable.update', { deliverableId: deliverable.id, [field]: trimmed });
      toast(t('deliverables.update.success'), 'success');
      onPublished?.();
    } catch {
      toast(t('deliverables.update.failed'), 'error');
      if (field === 'title') setLocalTitle(null);
      else setLocalSummary(null);
    }
    setEditingField(null);
  };

  const attachFile = async (): Promise<void> => {
    if (!attachPath.trim()) return;
    setAttaching(true);
    try {
      await rpc('deliverable.attachArtifact', {
        deliverableId: deliverable.id,
        filePath: attachPath.trim(),
      });
      toast(t('deliverables.attach.success'), 'success');
      setAttachPath('');
      setShowAttach(false);
      onPublished?.();
    } catch (error) {
      toast(error instanceof Error ? error.message : t('deliverables.attach.failed'), 'error');
    } finally {
      setAttaching(false);
    }
  };

  const loadTrace = async (): Promise<void> => {
    if (deliverable.source.kind !== 'workflow_run') return;
    setTraceLoading(true);
    try {
      const result = await rpc<WorkflowRunRecord | null>('workflow.runStatus', {
        runId: deliverable.source.runId,
      });
      setTraceRun(result);
    } catch {
      // silently ignore
    } finally {
      setTraceLoading(false);
    }
  };

  return (
    <div className="rounded-[28px] border border-white/10 bg-[radial-gradient(circle_at_top_right,rgba(34,197,94,0.14),transparent_22%),radial-gradient(circle_at_top_left,rgba(59,130,246,0.18),transparent_32%),rgba(2,6,23,0.88)] p-6 shadow-[0_30px_80px_rgba(2,6,23,0.45)] backdrop-blur-xl">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/8 pb-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={statusVariant(deliverable.status)}>{deliverable.status}</Badge>
            <Badge
              variant={
                deliverable.source.kind === 'workflow_run'
                  ? 'blue'
                  : deliverable.source.kind === 'scheduler_task_run'
                    ? 'purple'
                    : 'green'
              }
            >
              {sourceLabel(deliverable, t)}
            </Badge>
            <Badge variant="gray">{artifacts.length}</Badge>
          </div>
          <h3 className="mt-3 text-xl font-semibold tracking-tight text-slate-50">
            {editingField === 'title' ? (
              <input
                ref={titleInputRef}
                autoFocus
                defaultValue={localTitle ?? deliverable.title}
                className="w-full rounded-lg bg-slate-800/80 px-3 py-1.5 text-xl font-semibold text-slate-50 ring-1 ring-cyan-400/50 outline-none"
                onBlur={(e) => void saveField('title', e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setEditingField(null);
                  e.stopPropagation();
                }}
              />
            ) : (
              <span
                title={t('deliverables.detail.editHint')}
                className="cursor-text hover:opacity-80"
                onDoubleClick={() => setEditingField('title')}
              >
                {localTitle ?? deliverable.title}
              </span>
            )}
          </h3>
          <p className="mt-1 max-w-3xl line-clamp-2 text-sm leading-6 text-slate-300">
            {editingField === 'summary' ? (
              <textarea
                ref={summaryInputRef}
                autoFocus
                rows={2}
                defaultValue={localSummary ?? deliverable.summary}
                className="w-full rounded-lg bg-slate-800/80 px-3 py-1.5 text-sm text-slate-300 ring-1 ring-cyan-400/50 outline-none resize-none"
                onBlur={(e) => void saveField('summary', e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditingField(null);
                  e.stopPropagation();
                }}
              />
            ) : (
              <span
                title={t('deliverables.detail.editHint')}
                className="cursor-text hover:opacity-80"
                onDoubleClick={() => setEditingField('summary')}
              >
                {(localSummary ?? deliverable.summary) || deliverable.previewText || t('deliverables.artifact.noPreview')}
              </span>
            )}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <div className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-300">
              <span className="mr-2 text-slate-500">{t('deliverables.detail.createdAt')}</span>
              {new Date(deliverable.createdAt).toLocaleString()}
            </div>
            <div className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-300">
              <span className="mr-2 text-slate-500">{t('deliverables.detail.updatedAt')}</span>
              {new Date(deliverable.updatedAt).toLocaleString()}
            </div>
            <div className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-300">
              <span className="mr-2 text-slate-500">{t('deliverables.detail.artifactCount')}</span>
              {deliverable.artifacts.length}
            </div>
            <div className="max-w-full rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs text-slate-300">
              <span className="mr-2 text-slate-500">{t('deliverables.detail.sourceKey')}</span>
              <span className="break-all">{sourceKey(deliverable)}</span>
            </div>
          </div>
        </div>
        <CopyButton text={deliverable.previewText || deliverable.summary || deliverable.title} />
      </div>

      <div className="mt-4 grid gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
        <div className="xl:sticky xl:top-6 xl:self-start">
          <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                {t('deliverables.detail.artifacts')}
              </div>
              <div className="flex items-center gap-2">
                {artifacts.length > 1 && (
                  <button
                    type="button"
                    className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2.5 py-1 text-[10px] text-cyan-200 hover:bg-cyan-500/18"
                    onClick={() => downloadAllArtifacts(artifacts)}
                    title={t('deliverables.artifact.downloadAll')}
                  >
                    ↓ {t('deliverables.artifact.downloadAll')}
                  </button>
                )}
                <Badge variant="gray">{artifacts.length}</Badge>
              </div>
            </div>
            <div className="mb-3 rounded-xl border border-cyan-400/10 bg-cyan-500/[0.06] px-3 py-2 text-[11px] leading-5 text-cyan-100/80">
              {t('deliverables.artifact.keyboardHint')}
            </div>
            <div className="flex max-h-[760px] flex-col gap-2 overflow-auto pr-1">
              {artifacts.map((artifact, index) => {
                const active = artifact.id === activeArtifact?.id;
                const sizeLabel = formatBytes(artifact.size);
                return (
                  <button
                    id={`deliverable-artifact-${artifact.id}`}
                    key={artifact.id}
                    type="button"
                    onClick={() => setSelectedArtifactId(artifact.id)}
                    onKeyDown={(event) => handleArtifactKeyDown(event, index)}
                    className={`relative rounded-2xl border px-4 py-3 pl-5 text-left transition-all ${
                      active
                        ? 'border-cyan-300/45 bg-cyan-500/12 ring-1 ring-cyan-300/30 shadow-[0_18px_36px_rgba(6,182,212,0.12)]'
                        : 'border-white/8 bg-slate-950/55 hover:border-white/15 hover:bg-white/[0.03] focus:border-cyan-300/35'
                    }`}
                    aria-pressed={active}
                  >
                    <span
                      className={`absolute inset-y-3 left-2 w-1 rounded-full ${
                        active ? 'bg-cyan-300 shadow-[0_0_18px_rgba(103,232,249,0.85)]' : 'bg-white/8'
                      }`}
                    />
                    <div className="flex items-center justify-between gap-3">
                      <div className="truncate text-sm font-medium text-slate-100">{artifact.name}</div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          className="rounded-full border border-slate-600/40 bg-slate-800/60 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-700/70"
                          onClick={(e) => { e.stopPropagation(); downloadArtifact(artifact); }}
                          title={t('deliverables.artifact.download')}
                        >
                          ↓
                        </button>
                        <div className="rounded-full border border-white/8 bg-slate-900/80 px-2 py-0.5 text-[10px] text-slate-400">
                          {index + 1}/{artifacts.length}
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge variant={artifact.role === 'primary' ? 'blue' : 'purple'}>
                        {artifact.role}
                      </Badge>
                      <Badge variant="gray">{artifact.format}</Badge>
                      {sizeLabel && <Badge variant="gray">{sizeLabel}</Badge>}
                    </div>
                    <div className="mt-2 line-clamp-2 text-xs leading-5 text-slate-400">
                      {artifact.mimeType ?? artifact.filePath ?? ''}
                    </div>
                  </button>
                );
              })}
            </div>
            {/* B3: Attach file */}
            {!showAttach ? (
              <button
                type="button"
                className="mt-3 w-full rounded-xl border border-dashed border-slate-600/50 py-2 text-[11px] text-slate-500 hover:border-cyan-400/30 hover:text-cyan-300"
                onClick={() => setShowAttach(true)}
              >
                {t('deliverables.attach.action')}
              </button>
            ) : (
              <div className="mt-3 flex flex-col gap-2">
                <input
                  autoFocus
                  className="w-full rounded-lg bg-slate-800/70 px-3 py-2 text-xs text-slate-200 ring-1 ring-slate-600/60 outline-none focus:ring-cyan-400/40"
                  placeholder={t('deliverables.attach.placeholder')}
                  value={attachPath}
                  onChange={(e) => setAttachPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void attachFile();
                    if (e.key === 'Escape') { setShowAttach(false); setAttachPath(''); }
                  }}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={attaching || !attachPath.trim()}
                    className="flex-1 rounded-lg bg-cyan-600/30 py-1.5 text-xs text-cyan-100 hover:bg-cyan-600/45 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => void attachFile()}
                  >
                    {attaching ? '…' : t('deliverables.attach.confirm')}
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-slate-600/40 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
                    onClick={() => { setShowAttach(false); setAttachPath(''); }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>

        <div className="flex flex-col gap-4">
          <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                {activeArtifact && (
                  <div>
                    <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-slate-500">
                      <span>{t('deliverables.detail.primary')}</span>
                      <span className="rounded-full border border-white/8 bg-white/[0.03] px-2 py-0.5 text-[10px] text-slate-400">
                        {artifacts.findIndex((artifact) => artifact.id === activeArtifact.id) + 1}/{artifacts.length}
                      </span>
                    </div>
                    <div className="mt-2 truncate text-lg font-semibold text-slate-50">
                      {activeArtifact.name}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2">
                      <Badge variant={activeArtifact.role === 'primary' ? 'blue' : 'purple'}>
                        {activeArtifact.role}
                      </Badge>
                      <Badge variant="gray">{activeArtifact.format}</Badge>
                      {activeArtifact.mimeType && <Badge variant="gray">{activeArtifact.mimeType}</Badge>}
                    </div>
                  </div>
                )}
              </div>
              {preview && <CopyButton text={preview} />}
            </div>
            {activeArtifact ? (
              <ArtifactPreviewContent key={activeArtifact.id} artifact={activeArtifact} t={t} />
            ) : (
              <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/40 p-5 text-sm text-slate-500">
                {t('deliverables.artifact.noPreview')}
              </div>
            )}
            {activeArtifact?.filePath && (
              <div className="mt-4 rounded-xl bg-slate-950/70 px-3 py-2 text-xs text-slate-400">
                <div className="text-[10px] uppercase tracking-wider text-slate-500">
                  {t('deliverables.artifact.filePath')}
                </div>
                <div className="mt-1 break-all">{activeArtifact.filePath}</div>
              </div>
            )}
            {artifactUrl(activeArtifact) && (
              <div className="mt-4 flex justify-end">
                <a
                  href={artifactUrl(activeArtifact) ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-500/15"
                >
                  {t('deliverables.artifact.openRaw')}
                </a>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
              {t('deliverables.detail.source')}
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {deliverable.source.kind === 'workflow_run' ? (
                <>
                  <div className="rounded-xl bg-slate-950/70 px-3 py-2 text-sm text-slate-300">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('deliverables.detail.workflowId')}
                    </div>
                    <div className="mt-1 break-all">{deliverable.source.workflowId}</div>
                  </div>
                  <div className="rounded-xl bg-slate-950/70 px-3 py-2 text-sm text-slate-300">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('deliverables.detail.runId')}
                    </div>
                    <div className="mt-1 break-all">{deliverable.source.runId}</div>
                  </div>
                </>
              ) : deliverable.source.kind === 'scheduler_task_run' ? (
                <>
                  <div className="rounded-xl bg-slate-950/70 px-3 py-2 text-sm text-slate-300">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('deliverables.detail.taskId')}
                    </div>
                    <div className="mt-1 break-all">{deliverable.source.taskId}</div>
                  </div>
                  <div className="rounded-xl bg-slate-950/70 px-3 py-2 text-sm text-slate-300">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('deliverables.detail.runKey')}
                    </div>
                    <div className="mt-1 break-all">{deliverable.source.runKey}</div>
                  </div>
                  {deliverable.source.workflowId && (
                    <div className="rounded-xl bg-slate-950/70 px-3 py-2 text-sm text-slate-300">
                      <div className="text-[10px] uppercase tracking-wider text-slate-500">
                        {t('deliverables.detail.workflowId')}
                      </div>
                      <div className="mt-1 break-all">{deliverable.source.workflowId}</div>
                    </div>
                  )}
                  {deliverable.source.agentId && (
                    <div className="rounded-xl bg-slate-950/70 px-3 py-2 text-sm text-slate-300">
                      <div className="text-[10px] uppercase tracking-wider text-slate-500">
                        {t('deliverables.detail.agentId')}
                      </div>
                      <div className="mt-1 break-all">{deliverable.source.agentId}</div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="rounded-xl bg-slate-950/70 px-3 py-2 text-sm text-slate-300">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('deliverables.detail.agentId')}
                    </div>
                    <div className="mt-1 break-all">{deliverable.source.agentId}</div>
                  </div>
                  <div className="rounded-xl bg-slate-950/70 px-3 py-2 text-sm text-slate-300">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('deliverables.detail.threadKey')}
                    </div>
                    <div className="mt-1 break-all">{deliverable.source.threadKey}</div>
                  </div>
                  <div className="rounded-xl bg-slate-950/70 px-3 py-2 text-sm text-slate-300">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500">
                      {t('deliverables.detail.channelId')}
                    </div>
                    <div className="mt-1 break-all">{deliverable.source.channelId}</div>
                  </div>
                </>
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                {t('deliverables.detail.distribution')}
              </div>
              <div className="flex items-center gap-2">
                {publications.some((p) => p.status === 'available' || p.status === 'planned') && (
                  <button
                    type="button"
                    disabled={batchPublishing}
                    className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2.5 py-1 text-[10px] text-cyan-200 hover:bg-cyan-500/18 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => void batchPublishAll()}
                  >
                    {batchPublishing ? t('deliverables.publish.batchSending') : t('deliverables.publish.publishAll')}
                  </button>
                )}
                <Badge variant="gray">{publications.length}</Badge>
              </div>
            </div>
            <div className="flex flex-col gap-3">
              {publications.map((publication) => (
                <div
                  key={publication.id}
                  className="rounded-2xl border border-white/8 bg-slate-950/60 p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={publicationVariant(publication.status)}>
                      {t(`deliverables.publication.status.${publication.status}`)}
                    </Badge>
                    <Badge variant={publication.mode === 'artifact' ? 'green' : 'blue'}>
                      {t(`deliverables.publication.mode.${publication.mode}`)}
                    </Badge>
                    <Badge variant="gray">{t(`deliverables.publication.kind.${publication.kind}`)}</Badge>
                    {publication.lastAttemptAt && publication.status === 'sent' && (
                      <span className="text-[10px] text-slate-500">
                        {new Date(publication.lastAttemptAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                  <div className="mt-3 text-sm font-medium text-slate-100">{publication.label}</div>
                  {publication.detail && (
                    <div className="mt-2 text-xs leading-5 text-slate-400">{publication.detail}</div>
                  )}
                  <div className="mt-3 text-[11px] text-slate-500">
                    {t('deliverables.publication.targetId')}: {publication.targetId}
                  </div>
                  {publication.threadKey && (
                    <div className="mt-1 text-[11px] text-slate-500">threadKey: {publication.threadKey}</div>
                  )}
                  {publication.agentId && (
                    <div className="mt-1 text-[11px] text-slate-500">agentId: {publication.agentId}</div>
                  )}
                  {(publication.status === 'available' || publication.status === 'planned' || publication.status === 'failed') && (
                    <div className="mt-3 flex justify-end">
                      <button
                        className="rounded-lg border border-cyan-400/20 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={publishingId === publication.id}
                        onClick={() => void publishToTarget(publication)}
                      >
                        {publishingId === publication.id
                          ? t('deliverables.publish.sending')
                          : publication.status === 'failed'
                            ? t('deliverables.publish.retry')
                            : t('deliverables.publish.action')}
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {publications.length === 0 && (
                <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/40 p-5 text-sm text-slate-500">
                  {t('deliverables.detail.noDistribution')}
                </div>
              )}
            </div>
          </section>

          {/* B5: Workflow execution trace panel */}
          {deliverable.source.kind === 'workflow_run' && (
            <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <button
                type="button"
                className="flex w-full items-center justify-between text-[11px] uppercase tracking-[0.22em] text-slate-500 hover:text-slate-300"
                onClick={() => {
                  const next = !traceOpen;
                  setTraceOpen(next);
                  if (next && !traceRun && !traceLoading) void loadTrace();
                }}
              >
                <span>{t('deliverables.trace.title')}</span>
                <span className="text-slate-600">{traceOpen ? '▲' : '▼'}</span>
              </button>
              {traceOpen && (
                <div className="mt-3">
                  {traceLoading && (
                    <div className="text-xs text-slate-500">{t('deliverables.trace.loading')}</div>
                  )}
                  {!traceLoading && traceRun && traceRun.stepResults.length === 0 && (
                    <div className="text-xs text-slate-500">{t('deliverables.trace.empty')}</div>
                  )}
                  {!traceLoading && traceRun && traceRun.stepResults.length > 0 && (
                    <div className="flex flex-col gap-2">
                      {traceRun.stepResults.map((result: WorkflowStepResult, idx: number) => {
                        const duration =
                          result.startedAt && result.finishedAt
                            ? `${((result.finishedAt - result.startedAt) / 1000).toFixed(1)}s`
                            : null;
                        const hasError = !!result.error;
                        const isDone = !!result.finishedAt && !hasError;
                        return (
                          <button
                            key={result.stepId}
                            type="button"
                            className={`rounded-xl border p-3 text-left transition-all ${
                              artifacts.some((a) => a.stepId === result.stepId)
                                ? 'border-cyan-400/25 bg-cyan-500/8 hover:bg-cyan-500/14'
                                : 'border-white/8 bg-slate-950/50 hover:border-white/15'
                            }`}
                            onClick={() => {
                              const artifact = artifacts.find((a) => a.stepId === result.stepId);
                              if (artifact) setSelectedArtifactId(artifact.id);
                            }}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-medium text-slate-200">
                                {idx + 1}. {result.stepId}
                              </span>
                              <div className="flex items-center gap-2">
                                {duration && (
                                  <span className="text-[10px] text-slate-500">
                                    {t('deliverables.trace.duration')}: {duration}
                                  </span>
                                )}
                                <Badge variant={hasError ? 'red' : isDone ? 'green' : 'gray'}>
                                  {hasError
                                    ? t('deliverables.trace.step.error')
                                    : isDone
                                      ? t('deliverables.trace.step.done')
                                      : t('deliverables.trace.step.running')}
                                </Badge>
                              </div>
                            </div>
                            {(result.error ?? result.output) && (
                              <div className="mt-1.5 line-clamp-2 text-[11px] leading-5 text-slate-400">
                                {result.error ?? result.output}
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {!traceLoading && !traceRun && (
                    <div className="text-xs text-slate-500">{t('deliverables.trace.empty')}</div>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
