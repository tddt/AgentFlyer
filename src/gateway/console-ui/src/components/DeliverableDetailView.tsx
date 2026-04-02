import { useEffect, useState } from 'react';
import { Badge } from './Badge.js';
import { CopyButton } from './CopyButton.js';
import { MarkdownView } from './MarkdownView.js';
import { useLocale } from '../context/i18n.js';
import { rpc } from '../hooks/useRpc.js';
import { useToast } from '../hooks/useToast.js';
import type { ArtifactRef, DeliverablePublicationTarget, DeliverableRecord } from '../types.js';

const CONTENT_BASE = `http://127.0.0.1:${window.__AF_PORT__}`;
const CONTENT_TOKEN = encodeURIComponent(window.__AF_TOKEN__);

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

function sourceLabel(deliverable: DeliverableRecord, t: (key: string, vars?: Record<string, string>) => string): string {
  return deliverable.source.kind === 'workflow_run'
    ? t('deliverables.source.workflowLabel', { name: deliverable.source.workflowName })
    : t('deliverables.source.schedulerLabel', { name: deliverable.source.taskName });
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

function renderArtifactContent(artifact: ArtifactRef): JSX.Element {
  if (!artifact.textContent) {
    return <></>;
  }

  if (artifact.format === 'json' || artifact.format === 'csv') {
    return (
      <pre className="max-h-[320px] overflow-auto rounded-2xl bg-slate-950/70 p-4 text-xs leading-6 text-slate-300">
        {artifact.textContent}
      </pre>
    );
  }

  return (
    <div className="max-h-[320px] overflow-auto rounded-2xl bg-slate-950/70 p-4">
      <MarkdownView content={artifact.textContent} />
    </div>
  );
}

function artifactUrl(artifact: ArtifactRef): string | null {
  if (!artifact.contentItemId) return null;
  return `${CONTENT_BASE}/api/content/${encodeURIComponent(artifact.contentItemId)}?token=${CONTENT_TOKEN}`;
}

function renderMediaPreview(
  artifact: ArtifactRef,
  t: (key: string, vars?: Record<string, string>) => string,
): JSX.Element | null {
  const url = artifactUrl(artifact);
  if (!url || !artifact.mimeType) return null;

  if (artifact.mimeType.startsWith('image/')) {
    return (
      <div className="overflow-hidden rounded-2xl border border-white/8 bg-slate-950/70">
        <img src={url} alt={artifact.name} className="max-h-[360px] w-full object-contain" />
      </div>
    );
  }

  if (artifact.mimeType.startsWith('video/')) {
    return (
      <div className="overflow-hidden rounded-2xl border border-white/8 bg-slate-950/70 p-2">
        <video controls preload="metadata" className="max-h-[360px] w-full rounded-xl" src={url} />
      </div>
    );
  }

  if (artifact.mimeType.startsWith('audio/')) {
    return (
      <div className="rounded-2xl border border-white/8 bg-slate-950/70 p-4">
        <div className="mb-3 text-sm text-slate-300">{t('deliverables.artifact.audioPreview')}</div>
        <audio controls preload="metadata" className="w-full" src={url} />
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
  const [publicationOverrides, setPublicationOverrides] = useState<
    Record<string, Partial<DeliverablePublicationTarget>>
  >({});

  useEffect(() => {
    setPublicationOverrides({});
    setPublishingId(null);
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

  const mainArtifact = primaryArtifact(deliverable);
  const preview = mainArtifact ? artifactPreview(mainArtifact) : null;
  const stepArtifacts = deliverable.artifacts
    .filter((artifact) => artifact.role === 'step-output' || artifact.role === 'step-error')
    .sort((left, right) => (left.stepIndex ?? 0) - (right.stepIndex ?? 0));
  const fileArtifacts = deliverable.artifacts.filter((artifact) => artifact.role === 'file');
  const mediaArtifacts = fileArtifacts.filter(
    (artifact) =>
      artifact.format === 'image' || artifact.format === 'video' || artifact.format === 'audio',
  );
  const publications = (deliverable.publications ?? []).map((publication) => ({
    ...publication,
    ...(publicationOverrides[publication.id] ?? {}),
  }));

  const publishToTarget = async (publication: DeliverablePublicationTarget): Promise<void> => {
    if (!deliverable) return;
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

  return (
    <div className="rounded-[28px] border border-white/10 bg-[radial-gradient(circle_at_top_right,rgba(34,197,94,0.14),transparent_22%),radial-gradient(circle_at_top_left,rgba(59,130,246,0.18),transparent_32%),rgba(2,6,23,0.88)] p-6 shadow-[0_30px_80px_rgba(2,6,23,0.45)] backdrop-blur-xl">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/8 pb-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={statusVariant(deliverable.status)}>{deliverable.status}</Badge>
            <Badge variant={deliverable.source.kind === 'workflow_run' ? 'blue' : 'purple'}>
              {sourceLabel(deliverable, t)}
            </Badge>
          </div>
          <h3 className="mt-3 text-2xl font-semibold tracking-tight text-slate-50">
            {deliverable.title}
          </h3>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
            {deliverable.summary || deliverable.previewText || t('deliverables.artifact.noPreview')}
          </p>
        </div>
        <CopyButton text={deliverable.previewText || deliverable.summary || deliverable.title} />
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-4">
        <div className="rounded-2xl border border-emerald-400/15 bg-emerald-500/8 px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.2em] text-emerald-300/70">
            {t('deliverables.detail.createdAt')}
          </div>
          <div className="mt-2 text-sm text-emerald-100">
            {new Date(deliverable.createdAt).toLocaleString()}
          </div>
        </div>
        <div className="rounded-2xl border border-cyan-400/15 bg-cyan-500/8 px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.2em] text-cyan-300/70">
            {t('deliverables.detail.updatedAt')}
          </div>
          <div className="mt-2 text-sm text-cyan-100">
            {new Date(deliverable.updatedAt).toLocaleString()}
          </div>
        </div>
        <div className="rounded-2xl border border-fuchsia-400/15 bg-fuchsia-500/8 px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.2em] text-fuchsia-300/70">
            {t('deliverables.detail.artifactCount')}
          </div>
          <div className="mt-2 text-sm text-fuchsia-100">{deliverable.artifacts.length}</div>
        </div>
        <div className="rounded-2xl border border-amber-400/15 bg-amber-500/8 px-4 py-3">
          <div className="text-[11px] uppercase tracking-[0.2em] text-amber-300/70">
            {t('deliverables.detail.sourceKey')}
          </div>
          <div className="mt-2 break-all text-sm text-amber-100">
            {deliverable.source.kind === 'workflow_run'
              ? deliverable.source.runId
              : deliverable.source.runKey}
          </div>
        </div>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_360px]">
        <div className="flex flex-col gap-4">
          <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                  {t('deliverables.detail.primary')}
                </div>
                {mainArtifact && (
                  <div className="mt-1 text-sm text-slate-300">
                    {mainArtifact.name} · {mainArtifact.format}
                  </div>
                )}
              </div>
              {preview && <CopyButton text={preview} />}
            </div>
            {preview ? (
              renderArtifactContent(mainArtifact as ArtifactRef)
            ) : (
              <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/40 p-5 text-sm text-slate-500">
                {t('deliverables.artifact.noPreview')}
              </div>
            )}
          </section>

          {stepArtifacts.length > 0 && (
            <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                  {t('deliverables.detail.stepTimeline')}
                </div>
                <Badge variant="gray">{stepArtifacts.length}</Badge>
              </div>
              <div className="flex flex-col gap-3">
                {stepArtifacts.map((artifact) => (
                  <div
                    key={artifact.id}
                    className="rounded-2xl border border-white/8 bg-slate-950/60 p-4"
                  >
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={artifact.role === 'step-error' ? 'red' : 'blue'}>
                            {artifact.role === 'step-error'
                              ? t('deliverables.artifact.stepError')
                              : t('deliverables.artifact.stepOutput')}
                          </Badge>
                          <span className="text-sm font-medium text-slate-100">
                            {artifact.stepLabel ?? artifact.name}
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
                          {t('deliverables.detail.stepNumber', {
                            n: String((artifact.stepIndex ?? 0) + 1),
                          })}
                        </div>
                      </div>
                      {artifact.textContent && <CopyButton text={artifact.textContent} />}
                    </div>
                    {renderArtifactContent(artifact)}
                  </div>
                ))}
              </div>
            </section>
          )}

          {mediaArtifacts.length > 0 && (
            <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                  {t('deliverables.detail.mediaGallery')}
                </div>
                <Badge variant="gray">{mediaArtifacts.length}</Badge>
              </div>
              <div className="grid gap-4 xl:grid-cols-2">
                {mediaArtifacts.map((artifact) => (
                  <div
                    key={artifact.id}
                    className="rounded-2xl border border-white/8 bg-slate-950/60 p-4"
                  >
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium text-slate-100">{artifact.name}</div>
                        <div className="mt-1 text-xs text-slate-500">
                          {artifact.mimeType ?? artifact.format}
                        </div>
                      </div>
                      <Badge
                        variant={
                          artifact.format === 'image'
                            ? 'blue'
                            : artifact.format === 'video'
                              ? 'purple'
                              : 'green'
                        }
                      >
                        {artifact.format}
                      </Badge>
                    </div>
                    {renderMediaPreview(artifact, t)}
                  </div>
                ))}
              </div>
            </section>
          )}

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
              ) : (
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
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                {t('deliverables.detail.distribution')}
              </div>
              <Badge variant="gray">{publications.length}</Badge>
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
                  {publication.kind === 'channel' && publication.threadKey && (
                    <div className="mt-3 flex justify-end">
                      <button
                        className="rounded-lg border border-cyan-400/20 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={publishingId === publication.id}
                        onClick={() => void publishToTarget(publication)}
                      >
                        {publishingId === publication.id
                          ? t('deliverables.publish.sending')
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
        </div>

        <section className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
              {t('deliverables.detail.artifacts')}
            </div>
            <Badge variant="gray">{fileArtifacts.length}</Badge>
          </div>
          <div className="flex max-h-[640px] flex-col gap-3 overflow-auto pr-1">
            {fileArtifacts.map((artifact) => {
              const inline = !!artifact.textContent;
              const sizeLabel = formatBytes(artifact.size);
              return (
                <div
                  key={artifact.id}
                  className="rounded-2xl border border-white/8 bg-slate-950/60 px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-100">
                        {artifact.name}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Badge variant={inline ? 'blue' : 'purple'}>{artifact.format}</Badge>
                        <Badge variant="gray">{artifact.role}</Badge>
                        {inline && <Badge variant="gray">{t('deliverables.artifact.inline')}</Badge>}
                        {sizeLabel && <Badge variant="gray">{sizeLabel}</Badge>}
                      </div>
                    </div>
                    {artifact.textContent && <CopyButton text={artifact.textContent} />}
                  </div>
                  {artifact.filePath && (
                    <div className="mt-3 text-xs text-slate-400">
                      <div className="text-[10px] uppercase tracking-wider text-slate-500">
                        {t('deliverables.artifact.filePath')}
                      </div>
                      <div className="mt-1 break-all">{artifact.filePath}</div>
                    </div>
                  )}
                  {artifactUrl(artifact) && (
                    <div className="mt-3">
                      <a
                        href={artifactUrl(artifact) ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-cyan-300 hover:text-cyan-200"
                      >
                        {t('deliverables.artifact.openRaw')}
                      </a>
                    </div>
                  )}
                </div>
              );
            })}
            {fileArtifacts.length === 0 && (
              <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/40 p-5 text-sm text-slate-500">
                {t('deliverables.detail.noExtraArtifacts')}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}