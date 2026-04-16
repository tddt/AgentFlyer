import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { ScheduledTaskRecord } from '../agent/tools/builtin/scheduler-task-meta.js';
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

function parseDeliverableJsonRecord(output: string | undefined): Record<string, unknown> | null {
  if (!output?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(output);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readDeliverableString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readDeliverableStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
}

function joinSummaryParts(parts: string[]): string {
  return parts.filter(Boolean).join(' | ');
}

function compactSummaryParts(parts: Array<string | null | undefined>): string[] {
  return parts.filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
}

function formatListPreview(label: string, value: unknown, maxItems = 3): string | null {
  const items = readDeliverableStringArray(value);
  if (items.length === 0) {
    return null;
  }
  return `${label}: ${items.slice(0, maxItems).join(' / ')}`;
}

function formatMissingFields(fields: string[]): string | null {
  return fields.length > 0 ? `缺失字段: ${fields.join('、')}` : null;
}

function buildStructuredSuperNodeDeliverableSummary(
  workflow: WorkflowDef,
  run: WorkflowRunRecord,
): { summary: string; previewText: string } | null {
  const lastStepResult = run.stepResults[run.stepResults.length - 1];
  if (!lastStepResult?.output?.trim()) {
    return null;
  }

  const lastStep = workflow.steps.find((step) => step.id === lastStepResult.stepId);
  const type = lastStep?.type;
  if (
    type !== 'multi_source' &&
    type !== 'debate' &&
    type !== 'decision' &&
    type !== 'risk_review' &&
    type !== 'adjudication'
  ) {
    return null;
  }

  const data = parseDeliverableJsonRecord(lastStepResult.output);
  if (!data) {
    return null;
  }

  const missingFields: string[] = [];
  let title = '';
  let summaryParts: string[] = [];
  let previewParts: string[] = [];

  switch (type) {
    case 'multi_source': {
      title = '行业信息整合包';
      const synthesis = readDeliverableString(data.synthesis);
      if (!synthesis) missingFields.push('综合判断');
      if (readDeliverableStringArray(data.coreData).length === 0) missingFields.push('核心数据');
      if (readDeliverableStringArray(data.signals).length === 0) missingFields.push('趋势信号');
      if (readDeliverableStringArray(data.anomalies).length === 0) missingFields.push('异常点');
      if (readDeliverableStringArray(data.recommendedActions).length === 0)
        missingFields.push('建议动作');
      summaryParts = [
        title,
        synthesis ?? formatListPreview('核心数据', data.coreData, 1) ?? '待补充',
      ];
      previewParts = compactSummaryParts([
        title,
        synthesis ? `综合判断: ${synthesis}` : '',
        formatListPreview('核心数据', data.coreData),
        formatListPreview('趋势信号', data.signals),
        formatListPreview('异常点', data.anomalies),
        formatListPreview('建议动作', data.recommendedActions),
        formatMissingFields(missingFields),
      ]);
      break;
    }
    case 'debate': {
      title = '对抗辩论纪要';
      const moderatorSummary = readDeliverableString(data.moderatorSummary);
      if (!moderatorSummary) missingFields.push('主持总结');
      if (readDeliverableStringArray(data.coreClaims).length === 0) missingFields.push('核心观点');
      if (readDeliverableStringArray(data.disagreements).length === 0) missingFields.push('分歧点');
      if (readDeliverableStringArray(data.consensus).length === 0) missingFields.push('共识结论');
      if (readDeliverableStringArray(data.evidenceGaps).length === 0)
        missingFields.push('待补证据');
      summaryParts = [
        title,
        moderatorSummary ?? formatListPreview('共识结论', data.consensus, 1) ?? '待补充',
      ];
      previewParts = compactSummaryParts([
        title,
        moderatorSummary ? `主持总结: ${moderatorSummary}` : '',
        formatListPreview('核心观点', data.coreClaims),
        formatListPreview('分歧点', data.disagreements),
        formatListPreview('共识结论', data.consensus),
        formatListPreview('待补证据', data.evidenceGaps),
        formatMissingFields(missingFields),
      ]);
      break;
    }
    case 'decision': {
      title = '结构化决策方案';
      const direction = readDeliverableString(data.direction);
      const priority = readDeliverableString(data.priority);
      const confidence = readDeliverableString(data.confidence);
      const rationale = readDeliverableString(data.rationale);
      if (!direction) missingFields.push('方向');
      if (!priority) missingFields.push('优先级');
      if (!confidence) missingFields.push('置信度');
      if (!rationale) missingFields.push('决策依据');
      if (readDeliverableStringArray(data.executionSteps).length === 0)
        missingFields.push('执行步骤');
      if (readDeliverableStringArray(data.dependencies).length === 0)
        missingFields.push('关键依赖');
      summaryParts = [
        title,
        direction ? `方向:${direction}` : '方向待补充',
        priority ? `优先级:${priority}` : '',
      ];
      previewParts = compactSummaryParts([
        title,
        direction ? `方向: ${direction}` : '',
        priority ? `优先级: ${priority}` : '',
        confidence ? `置信度: ${confidence}` : '',
        rationale ? `决策依据: ${rationale}` : '',
        formatListPreview('执行步骤', data.executionSteps),
        formatListPreview('关键依赖', data.dependencies),
        formatMissingFields(missingFields),
      ]);
      break;
    }
    case 'risk_review': {
      title = '风险审核报告';
      const riskLevel = readDeliverableString(data.riskLevel);
      const proceedRecommendation = readDeliverableString(data.proceedRecommendation);
      if (!riskLevel) missingFields.push('风险等级');
      if (!proceedRecommendation) missingFields.push('是否建议继续');
      if (readDeliverableStringArray(data.majorRisks).length === 0) missingFields.push('主要风险');
      if (readDeliverableStringArray(data.mitigations).length === 0) missingFields.push('整改建议');
      if (readDeliverableStringArray(data.vetoItems).length === 0) missingFields.push('否决项');
      summaryParts = [
        title,
        riskLevel ? `风险等级:${riskLevel}` : '风险等级待补充',
        proceedRecommendation ? `建议:${proceedRecommendation}` : '',
      ];
      previewParts = compactSummaryParts([
        title,
        riskLevel ? `风险等级: ${riskLevel}` : '',
        proceedRecommendation ? `是否建议继续: ${proceedRecommendation}` : '',
        formatListPreview('主要风险', data.majorRisks),
        formatListPreview('整改建议', data.mitigations),
        formatListPreview('否决项', data.vetoItems),
        formatMissingFields(missingFields),
      ]);
      break;
    }
    case 'adjudication': {
      title = '最终执行方案';
      const verdict = readDeliverableString(data.verdict);
      const owner = readDeliverableString(data.owner);
      const decisionMemo = readDeliverableString(data.decisionMemo);
      if (!verdict) missingFields.push('拍板结果');
      if (!owner) missingFields.push('责任归属');
      if (!decisionMemo) missingFields.push('决策备忘');
      if (readDeliverableStringArray(data.milestones).length === 0) missingFields.push('落地节点');
      if (readDeliverableStringArray(data.watchItems).length === 0)
        missingFields.push('继续观察项');
      summaryParts = [
        title,
        verdict ? `拍板:${verdict}` : '拍板待补充',
        owner ? `责任:${owner}` : '',
      ];
      previewParts = compactSummaryParts([
        title,
        verdict ? `拍板结果: ${verdict}` : '',
        owner ? `责任归属: ${owner}` : '',
        decisionMemo ? `决策备忘: ${decisionMemo}` : '',
        formatListPreview('落地节点', data.milestones),
        formatListPreview('继续观察项', data.watchItems),
        formatMissingFields(missingFields),
      ]);
      break;
    }
  }

  return {
    summary: summarizeText(joinSummaryParts(summaryParts)),
    previewText: summarizeText(joinSummaryParts(previewParts), 400),
  };
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
  const structuredSummary = buildStructuredSuperNodeDeliverableSummary(workflow, run);

  return {
    title: `${workflow.name} Deliverable`,
    summary: structuredSummary?.summary ?? summarizeText(primaryText),
    previewText: structuredSummary?.previewText ?? summarizeText(primaryText, 400),
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
      structuredSummary: structuredSummary ? 'true' : 'false',
    },
    createdAt,
    updatedAt: createdAt,
  };
}

export interface SchedulerDeliverableOptions {
  task: ScheduledTaskRecord;
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

  async update(
    id: string,
    updates: Partial<Pick<DeliverableRecord, 'title' | 'summary'>>,
  ): Promise<DeliverableRecord | null> {
    const current = await this.readAll();
    const index = current.findIndex((record) => record.id === id);
    if (index < 0) return null;
    const existing = current[index]!;
    const updated: DeliverableRecord = { ...existing, ...updates, updatedAt: Date.now() };
    const next = current.map((record, i) => (i === index ? updated : record));
    await writeFile(deliverablesFile(this.dataDir), JSON.stringify(next, null, 2), 'utf-8');
    return updated;
  }

  async attachArtifact(id: string, artifact: ArtifactRef): Promise<DeliverableRecord | null> {
    const current = await this.readAll();
    const index = current.findIndex((record) => record.id === id);
    if (index < 0) return null;
    const existing = current[index]!;
    const updated: DeliverableRecord = {
      ...existing,
      artifacts: [...existing.artifacts, artifact],
      updatedAt: Date.now(),
    };
    const next = current.map((record, i) => (i === index ? updated : record));
    await writeFile(deliverablesFile(this.dataDir), JSON.stringify(next, null, 2), 'utf-8');
    return updated;
  }
}
