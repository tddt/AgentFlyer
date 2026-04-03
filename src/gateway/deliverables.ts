import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { ScheduledTaskMeta } from '../agent/tools/builtin/scheduler-tools.js';
import type { ContentItem } from './content-store.js';
import type { WorkflowDef, WorkflowRunRecord } from './workflow-backend.js';

export type DeliverableStatus = 'ready' | 'error' | 'cancelled';
export type DeliverableFormat =
  | 'text'
  | 'markdown'
  | 'json'
  | 'csv'
  | 'image'
  | 'video'
  | 'audio'
  | 'file';

export type ArtifactRole = 'primary' | 'step-output' | 'step-error' | 'file';

export type DeliverablePublicationTargetKind = 'system' | 'agent' | 'channel';
export type DeliverablePublicationMode = 'summary' | 'artifact';
export type DeliverablePublicationStatus = 'planned' | 'available' | 'sent' | 'failed';

export interface DeliverablePublicationTarget {
  id: string;
  kind: DeliverablePublicationTargetKind;
  targetId: string;
  label: string;
  mode: DeliverablePublicationMode;
  status: DeliverablePublicationStatus;
  threadKey?: string;
  agentId?: string;
  detail?: string;
  lastAttemptAt?: number;
}

export interface ArtifactRef {
  id: string;
  name: string;
  role: ArtifactRole;
  format: DeliverableFormat;
  mimeType?: string;
  filePath?: string;
  contentItemId?: string;
  textContent?: string;
  size?: number;
  stepId?: string;
  stepLabel?: string;
  stepIndex?: number;
  createdAt: number;
}

export type DeliverableSource =
  | {
      kind: 'workflow_run';
      workflowId: string;
      workflowName: string;
      runId: string;
    }
  | {
      kind: 'scheduler_task_run';
      taskId: string;
      taskName: string;
      runKey: string;
      startedAt: number;
      finishedAt: number;
      workflowId?: string;
      workflowRunId?: string;
      agentId?: string;
    }
  | {
      kind: 'chat_turn';
      agentId: string;
      threadKey: string;
      channelId: string;
      startedAt: number;
      finishedAt: number;
    };

export interface DeliverableListFilters {
  sourceKind?: DeliverableSource['kind'];
  status?: DeliverableStatus;
  workflowId?: string;
  runId?: string;
  taskId?: string;
  workflowRunId?: string;
  agentId?: string;
  query?: string;
  limit?: number;
}

export interface DeliverableStats {
  total: number;
  ready: number;
  error: number;
  cancelled: number;
  workflowRuns: number;
  schedulerRuns: number;
  chatTurns: number;
  totalArtifacts: number;
  textualArtifacts: number;
  fileArtifacts: number;
  recent24h: number;
}

export interface DeliverableListResult {
  items: DeliverableRecord[];
  stats: DeliverableStats;
}

export type DeliverableMetadataValue = string | number | boolean | null;

export interface DeliverableRecord {
  id: string;
  title: string;
  summary: string;
  previewText: string;
  status: DeliverableStatus;
  source: DeliverableSource;
  artifacts: ArtifactRef[];
  publications?: DeliverablePublicationTarget[];
  primaryArtifactId?: string;
  metadata?: Record<string, DeliverableMetadataValue>;
  createdAt: number;
  updatedAt: number;
}

export type CreateDeliverableInput = Omit<DeliverableRecord, 'id' | 'createdAt' | 'updatedAt'> & {
  createdAt?: number;
  updatedAt?: number;
};

const MAX_DELIVERABLES = 500;

export function makeSchedulerRunKey(taskId: string, startedAt: number): string {
  return `${taskId}:${startedAt}`;
}

function deliverablesFile(dataDir: string): string {
  return join(dataDir, 'deliverables.json');
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function summarizeText(text: string, maxLength = 220): string {
  const compact = compactWhitespace(text);
  if (!compact) return '';
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

export function inferTextFormat(text: string): DeliverableFormat {
  const trimmed = text.trim();
  if (!trimmed) return 'text';

  try {
    JSON.parse(trimmed);
    return 'json';
  } catch {
    // ignore invalid json
  }

  if (/^#{1,6}\s|```|\n[-*]\s|\n\d+\.\s/m.test(trimmed)) {
    return 'markdown';
  }

  if (trimmed.includes(',') && trimmed.includes('\n')) {
    return 'csv';
  }

  return 'text';
}

function formatFromMime(mimeType: string): DeliverableFormat {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/json') return 'json';
  if (mimeType === 'text/csv') return 'csv';
  if (mimeType === 'text/markdown') return 'markdown';
  if (mimeType === 'text/plain') return 'text';
  return 'file';
}

export function createTextArtifact(
  name: string,
  text: string,
  createdAt: number,
  preferredFormat?: DeliverableFormat,
  extra?: Partial<ArtifactRef>,
): ArtifactRef {
  const format = preferredFormat ?? inferTextFormat(text);
  return {
    id: ulid(),
    name,
    role: extra?.role ?? 'primary',
    format,
    mimeType:
      format === 'json'
        ? 'application/json'
        : format === 'markdown'
          ? 'text/markdown'
          : format === 'csv'
            ? 'text/csv'
            : 'text/plain',
    textContent: text,
    stepId: extra?.stepId,
    stepLabel: extra?.stepLabel,
    stepIndex: extra?.stepIndex,
    createdAt,
  };
}

export function contentItemToArtifactRef(item: ContentItem): ArtifactRef {
  return {
    id: ulid(),
    name: item.name,
    role: 'file',
    format: formatFromMime(item.mimeType),
    mimeType: item.mimeType,
    filePath: item.filePath,
    contentItemId: item.id,
    size: item.size,
    createdAt: item.createdAt,
  };
}

export function findRecentArtifacts(
  items: ContentItem[],
  agentIds: string[],
  startedAt: number,
  finishedAt: number,
): ArtifactRef[] {
  if (agentIds.length === 0) return [];

  return items
    .filter(
      (item) =>
        agentIds.includes(item.agentId) &&
        item.createdAt >= startedAt - 1_000 &&
        item.createdAt <= finishedAt + 2_000,
    )
    .map(contentItemToArtifactRef);
}

function lastStepText(run: WorkflowRunRecord): string {
  for (let index = run.stepResults.length - 1; index >= 0; index -= 1) {
    const step = run.stepResults[index];
    if (step?.error?.trim()) return step.error.trim();
    if (step?.output?.trim()) return step.output.trim();
  }
  return '';
}

function workflowStatus(run: WorkflowRunRecord): DeliverableStatus {
  if (run.status === 'error') return 'error';
  if (run.status === 'cancelled') return 'cancelled';
  return 'ready';
}

function workflowStepArtifacts(
  workflow: WorkflowDef,
  run: WorkflowRunRecord,
  createdAt: number,
): ArtifactRef[] {
  return run.stepResults.flatMap((stepResult, index) => {
    const step = workflow.steps.find((item) => item.id === stepResult.stepId);
    const stepLabel = step?.label ?? step?.agentId ?? stepResult.stepId;

    if (stepResult.error?.trim()) {
      return [
        createTextArtifact(
          `step-${index + 1}-error.txt`,
          stepResult.error.trim(),
          createdAt,
          'text',
          {
            role: 'step-error',
            stepId: stepResult.stepId,
            stepLabel,
            stepIndex: index,
          },
        ),
      ];
    }

    if (stepResult.output?.trim()) {
      return [
        createTextArtifact(
          `step-${index + 1}-output.txt`,
          stepResult.output.trim(),
          createdAt,
          undefined,
          {
            role: 'step-output',
            stepId: stepResult.stepId,
            stepLabel,
            stepIndex: index,
          },
        ),
      ];
    }

    return [];
  });
}

export function buildWorkflowDeliverable(
  workflow: WorkflowDef,
  run: WorkflowRunRecord,
  fileArtifacts: ArtifactRef[],
  publications: DeliverablePublicationTarget[] = [],
): CreateDeliverableInput {
  const createdAt = run.finishedAt ?? run.startedAt;
  const primaryText =
    lastStepText(run) ||
    (run.status === 'cancelled'
      ? 'Workflow was cancelled before producing a final output.'
      : 'Workflow completed without a final textual output.');
  const textArtifact = createTextArtifact(
    'workflow-result.txt',
    primaryText,
    createdAt,
    undefined,
    {
      role: 'primary',
    },
  );
  const stepArtifacts = workflowStepArtifacts(workflow, run, createdAt);
  const artifacts = [textArtifact, ...stepArtifacts, ...fileArtifacts];
  const successfulSteps = run.stepResults.filter((step) => !!step.output && !step.error).length;

  return {
    title: `${workflow.name} Deliverable`,
    summary: summarizeText(primaryText),
    previewText: summarizeText(primaryText, 400),
    status: workflowStatus(run),
    source: {
      kind: 'workflow_run',
      workflowId: workflow.id,
      workflowName: workflow.name,
      runId: run.runId,
    },
    artifacts,
    publications: publications.length > 0 ? publications : undefined,
    primaryArtifactId: textArtifact.id,
    metadata: {
      stepCount: workflow.steps.length,
      successfulSteps,
      stepArtifactCount: stepArtifacts.length,
      artifactCount: artifacts.length,
    },
    createdAt,
    updatedAt: createdAt,
  };
}

export interface SchedulerDeliverableOptions {
  task: ScheduledTaskMeta;
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  result: string;
  workflowRunId?: string;
  fileArtifacts: ArtifactRef[];
  publications?: DeliverablePublicationTarget[];
}

export function buildSchedulerDeliverable(
  options: SchedulerDeliverableOptions,
): CreateDeliverableInput {
  const {
    task,
    startedAt,
    finishedAt,
    ok,
    result,
    workflowRunId,
    fileArtifacts,
    publications = [],
  } = options;
  const textArtifact = createTextArtifact('scheduler-result.txt', result, finishedAt, undefined, {
    role: 'primary',
  });
  const artifacts = [textArtifact, ...fileArtifacts];

  return {
    title: `${task.name} Deliverable`,
    summary: summarizeText(result),
    previewText: summarizeText(result, 400),
    status: ok ? 'ready' : 'error',
    source: {
      kind: 'scheduler_task_run',
      taskId: task.id,
      taskName: task.name,
      runKey: makeSchedulerRunKey(task.id, startedAt),
      startedAt,
      finishedAt,
      workflowId: task.workflowId,
      workflowRunId,
      agentId: task.agentId,
    },
    artifacts,
    publications: publications.length > 0 ? publications : undefined,
    primaryArtifactId: textArtifact.id,
    metadata: {
      startedAt,
      finishedAt,
      artifactCount: artifacts.length,
    },
    createdAt: finishedAt,
    updatedAt: finishedAt,
  };
}

export interface ChatTurnDeliverableOptions {
  agentId: string;
  threadKey: string;
  channelId: string;
  startedAt: number;
  finishedAt: number;
  replyText: string;
  fileArtifacts: ArtifactRef[];
  publications?: DeliverablePublicationTarget[];
}

export function buildChatTurnDeliverable(
  options: ChatTurnDeliverableOptions,
): CreateDeliverableInput {
  const {
    agentId,
    threadKey,
    channelId,
    startedAt,
    finishedAt,
    replyText,
    fileArtifacts,
    publications = [],
  } = options;
  const fallbackSummary =
    fileArtifacts.length > 0
      ? `Generated ${fileArtifacts.length} file${fileArtifacts.length === 1 ? '' : 's'} in this turn.`
      : 'Generated artifacts in this chat turn.';
  const primaryText = replyText.trim() || fallbackSummary;
  const textArtifact = createTextArtifact(
    'chat-turn-result.txt',
    primaryText,
    finishedAt,
    undefined,
    {
      role: 'primary',
    },
  );
  const artifacts = [textArtifact, ...fileArtifacts];

  return {
    title: `${agentId} Chat Deliverable`,
    summary: summarizeText(primaryText),
    previewText: summarizeText(primaryText, 400),
    status: 'ready',
    source: {
      kind: 'chat_turn',
      agentId,
      threadKey,
      channelId,
      startedAt,
      finishedAt,
    },
    artifacts,
    publications: publications.length > 0 ? publications : undefined,
    primaryArtifactId: textArtifact.id,
    metadata: {
      artifactCount: artifacts.length,
      fileArtifactCount: fileArtifacts.length,
    },
    createdAt: finishedAt,
    updatedAt: finishedAt,
  };
}

function sourceFingerprint(source: DeliverableSource): string {
  if (source.kind === 'workflow_run') {
    return `workflow:${source.runId}`;
  }
  if (source.kind === 'scheduler_task_run') {
    return `scheduler:${source.runKey}`;
  }
  return `chat:${source.agentId}:${source.threadKey}:${source.startedAt}`;
}

function matchesFilters(record: DeliverableRecord, filters: DeliverableListFilters): boolean {
  if (filters.sourceKind && record.source.kind !== filters.sourceKind) return false;
  if (filters.status && record.status !== filters.status) return false;
  if (
    filters.workflowId &&
    record.source.kind !== 'chat_turn' &&
    record.source.workflowId !== filters.workflowId
  ) {
    return false;
  }
  if (filters.workflowId && record.source.kind === 'chat_turn') return false;
  if (
    filters.runId &&
    record.source.kind === 'workflow_run' &&
    record.source.runId !== filters.runId
  ) {
    return false;
  }
  if (filters.runId && record.source.kind !== 'workflow_run') return false;
  if (
    filters.taskId &&
    record.source.kind === 'scheduler_task_run' &&
    record.source.taskId !== filters.taskId
  ) {
    return false;
  }
  if (filters.taskId && record.source.kind !== 'scheduler_task_run') return false;
  if (
    filters.workflowRunId &&
    record.source.kind === 'scheduler_task_run' &&
    record.source.workflowRunId !== filters.workflowRunId
  ) {
    return false;
  }
  if (
    filters.agentId &&
    record.source.kind === 'scheduler_task_run' &&
    record.source.agentId !== filters.agentId
  ) {
    return false;
  }
  if (
    filters.agentId &&
    record.source.kind === 'chat_turn' &&
    record.source.agentId !== filters.agentId
  ) {
    return false;
  }
  if (
    filters.agentId &&
    record.source.kind !== 'scheduler_task_run' &&
    record.source.kind !== 'chat_turn'
  ) {
    return false;
  }
  if (filters.query) {
    const query = filters.query.toLowerCase().trim();
    const haystack = [
      record.title,
      record.summary,
      record.previewText,
      record.source.kind === 'workflow_run'
        ? record.source.workflowName
        : record.source.kind === 'scheduler_task_run'
          ? record.source.taskName
          : record.source.agentId,
      record.source.kind === 'chat_turn' ? record.source.threadKey : '',
      record.source.kind === 'chat_turn' ? record.source.channelId : '',
      ...record.artifacts.map((artifact) => artifact.name),
    ]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}

export function buildDeliverableStats(items: DeliverableRecord[]): DeliverableStats {
  const now = Date.now();
  return items.reduce<DeliverableStats>(
    (stats, item) => {
      stats.total += 1;
      if (item.status === 'ready') stats.ready += 1;
      if (item.status === 'error') stats.error += 1;
      if (item.status === 'cancelled') stats.cancelled += 1;
      if (item.source.kind === 'workflow_run') stats.workflowRuns += 1;
      if (item.source.kind === 'scheduler_task_run') stats.schedulerRuns += 1;
      if (item.source.kind === 'chat_turn') stats.chatTurns += 1;
      stats.totalArtifacts += item.artifacts.length;
      stats.textualArtifacts += item.artifacts.filter((artifact) => !!artifact.textContent).length;
      stats.fileArtifacts += item.artifacts.filter((artifact) => !!artifact.filePath).length;
      if (item.createdAt >= now - 86_400_000) stats.recent24h += 1;
      return stats;
    },
    {
      total: 0,
      ready: 0,
      error: 0,
      cancelled: 0,
      workflowRuns: 0,
      schedulerRuns: 0,
      chatTurns: 0,
      totalArtifacts: 0,
      textualArtifacts: 0,
      fileArtifacts: 0,
      recent24h: 0,
    },
  );
}

export class DeliverableStore {
  constructor(private readonly dataDir: string) {}

  private async readAll(): Promise<DeliverableRecord[]> {
    const filePath = deliverablesFile(this.dataDir);
    if (!existsSync(filePath)) return [];
    try {
      return JSON.parse(await readFile(filePath, 'utf-8')) as DeliverableRecord[];
    } catch {
      return [];
    }
  }

  async list(filters: DeliverableListFilters = {}): Promise<DeliverableRecord[]> {
    const all = await this.readAll();
    const filtered = all.filter((record) => matchesFilters(record, filters));
    return filtered.slice(0, filters.limit ?? MAX_DELIVERABLES);
  }

  async get(id: string): Promise<DeliverableRecord | null> {
    const all = await this.readAll();
    return all.find((record) => record.id === id) ?? null;
  }

  async updatePublication(
    deliverableId: string,
    publicationId: string,
    updates: Partial<Pick<DeliverablePublicationTarget, 'status' | 'detail' | 'lastAttemptAt'>>,
  ): Promise<DeliverableRecord | null> {
    const current = await this.readAll();
    const index = current.findIndex((record) => record.id === deliverableId);
    if (index < 0) return null;
    const existing = current[index];
    if (!existing) return null;
    const publications = existing.publications?.map((publication) =>
      publication.id === publicationId ? { ...publication, ...updates } : publication,
    );
    const updatedRecord: DeliverableRecord = {
      ...existing,
      publications,
      updatedAt: Date.now(),
    };
    const next = current.map((record, recordIndex) =>
      recordIndex === index ? updatedRecord : record,
    );
    await writeFile(deliverablesFile(this.dataDir), JSON.stringify(next, null, 2), 'utf-8');
    return updatedRecord;
  }

  async summarize(filters: DeliverableListFilters = {}): Promise<DeliverableListResult> {
    const items = await this.list(filters);
    return {
      items,
      stats: buildDeliverableStats(items),
    };
  }

  async create(input: CreateDeliverableInput): Promise<DeliverableRecord> {
    const current = await this.readAll();
    const now = input.createdAt ?? Date.now();
    const record: DeliverableRecord = {
      ...input,
      id: ulid(),
      createdAt: now,
      updatedAt: input.updatedAt ?? now,
    };
    const updated = [record, ...current].slice(0, MAX_DELIVERABLES);
    await writeFile(deliverablesFile(this.dataDir), JSON.stringify(updated, null, 2), 'utf-8');
    return record;
  }

  async upsert(input: CreateDeliverableInput): Promise<DeliverableRecord> {
    const current = await this.readAll();
    const existing = current.find(
      (record) => sourceFingerprint(record.source) === sourceFingerprint(input.source),
    );
    const now = input.updatedAt ?? Date.now();
    const record: DeliverableRecord = {
      ...input,
      publications: input.publications ?? existing?.publications,
      id: existing?.id ?? ulid(),
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
    };
    const updated = [record, ...current.filter((item) => item.id !== record.id)].slice(
      0,
      MAX_DELIVERABLES,
    );
    await writeFile(deliverablesFile(this.dataDir), JSON.stringify(updated, null, 2), 'utf-8');
    return record;
  }
}
