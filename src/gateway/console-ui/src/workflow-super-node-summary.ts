import type { StepType, WorkflowStepResult } from './types.js';

export interface WorkflowSuperNodeSummaryHighlight {
  label: string;
  value: string;
}

export interface WorkflowSuperNodeSummaryTextSection {
  label: string;
  value: string;
}

export interface WorkflowSuperNodeSummaryListSection {
  label: string;
  items: string[];
}

export interface WorkflowSuperNodeStructuredSummary {
  title: string;
  highlights: WorkflowSuperNodeSummaryHighlight[];
  texts: WorkflowSuperNodeSummaryTextSection[];
  lists: WorkflowSuperNodeSummaryListSection[];
  missingFields: string[];
}

type SuperNodeStepType = Extract<
  StepType,
  'multi_source' | 'debate' | 'decision' | 'risk_review' | 'adjudication'
>;

type WorkflowSuperNodeTrace = NonNullable<WorkflowStepResult['superNodeTrace']>;

function parseJsonRecord(output: string | undefined): Record<string, unknown> | null {
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

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

function pushText(
  target: WorkflowSuperNodeSummaryTextSection[],
  label: string,
  value: unknown,
): void {
  const text = readString(value);
  if (text) {
    target.push({ label, value: text });
  }
}

function pushList(
  target: WorkflowSuperNodeSummaryListSection[],
  label: string,
  value: unknown,
): void {
  const items = readStringArray(value);
  if (items.length > 0) {
    target.push({ label, items });
  }
}

function pushHighlight(
  target: WorkflowSuperNodeSummaryHighlight[],
  label: string,
  value: unknown,
): void {
  const text = readString(value);
  if (text) {
    target.push({ label, value: text });
  }
}

function trackMissingString(target: string[], label: string, value: unknown): void {
  if (!readString(value)) {
    target.push(label);
  }
}

function trackMissingList(target: string[], label: string, value: unknown): void {
  if (readStringArray(value).length === 0) {
    target.push(label);
  }
}

function formatElapsed(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatStatus(status: WorkflowSuperNodeTrace['coordinatorStatus']): string | null {
  if (status === 'done') {
    return '已完成';
  }
  if (status === 'suspended') {
    return '已挂起';
  }
  if (status === 'error') {
    return '失败';
  }
  return null;
}

function buildDurationRangeText(trace: WorkflowSuperNodeTrace): string | null {
  const durations = trace.participantResults
    .map((item) => item.finishedAt - item.startedAt)
    .filter((value) => Number.isFinite(value) && value >= 0);

  if (
    trace.coordinatorStartedAt !== undefined &&
    trace.coordinatorFinishedAt !== undefined &&
    trace.coordinatorFinishedAt >= trace.coordinatorStartedAt
  ) {
    durations.push(trace.coordinatorFinishedAt - trace.coordinatorStartedAt);
  }

  if (durations.length === 0) {
    return null;
  }

  const min = Math.min(...durations);
  const max = Math.max(...durations);
  return min === max ? formatElapsed(min) : `${formatElapsed(min)} - ${formatElapsed(max)}`;
}

function applyExecutionTraceSummary(
  summary: WorkflowSuperNodeStructuredSummary,
  trace: WorkflowSuperNodeTrace | undefined,
): WorkflowSuperNodeStructuredSummary {
  if (!trace) {
    return summary;
  }

  const participantTotal = trace.participantResults.length;
  const participantDone = trace.participantResults.filter((item) => item.status === 'done').length;
  const participantSuspended = trace.participantResults.filter(
    (item) => item.status === 'suspended',
  ).length;
  const participantFailed = trace.participantResults.filter((item) => item.status === 'error').length;
  const coordinatorStatus = formatStatus(trace.coordinatorStatus);
  const durationRange = buildDurationRangeText(trace);
  const executionParts = [
    participantTotal > 0
      ? `参与者完成 ${participantDone}/${participantTotal}`
      : '无并行参与者',
    participantFailed > 0 ? `失败 ${participantFailed}` : null,
    participantSuspended > 0 ? `挂起 ${participantSuspended}` : null,
    trace.participantExecution === 'reused' ? '复用上次参与者结果' : null,
    trace.coordinatorAttempt > 1 ? `协调器第 ${trace.coordinatorAttempt} 次尝试` : null,
    coordinatorStatus ? `协调器${coordinatorStatus}` : null,
    durationRange ? `耗时区间 ${durationRange}` : null,
  ].filter((value): value is string => Boolean(value));

  return {
    ...summary,
    highlights: [
      { label: '参与者', value: `${participantDone}/${participantTotal} 完成` },
      ...(trace.participantExecution === 'reused'
        ? [{ label: '参与者执行', value: '复用' }]
        : []),
      ...(trace.coordinatorAttempt > 1
        ? [{ label: '协调尝试', value: `第 ${trace.coordinatorAttempt} 次` }]
        : []),
      ...(participantFailed > 0 ? [{ label: '失败数', value: String(participantFailed) }] : []),
      ...(participantSuspended > 0
        ? [{ label: '挂起数', value: String(participantSuspended) }]
        : []),
      ...(coordinatorStatus ? [{ label: '协调器', value: coordinatorStatus }] : []),
      ...summary.highlights,
    ],
    texts: executionParts.length > 0
      ? [{ label: '协作执行', value: `${executionParts.join('，')}。` }, ...summary.texts]
      : summary.texts,
  };
}

export function parseWorkflowSuperNodeStructuredSummary(
  type: StepType | undefined,
  output: string | undefined,
  trace?: WorkflowSuperNodeTrace,
): WorkflowSuperNodeStructuredSummary | null {
  if (
    type !== 'multi_source' &&
    type !== 'debate' &&
    type !== 'decision' &&
    type !== 'risk_review' &&
    type !== 'adjudication'
  ) {
    return null;
  }

  const data = parseJsonRecord(output);
  if (!data) {
    return null;
  }

  const summary = buildSummaryByType(type, data);
  return summary ? applyExecutionTraceSummary(summary, trace) : null;
}

function buildSummaryByType(
  type: SuperNodeStepType,
  data: Record<string, unknown>,
): WorkflowSuperNodeStructuredSummary | null {
  const highlights: WorkflowSuperNodeSummaryHighlight[] = [];
  const texts: WorkflowSuperNodeSummaryTextSection[] = [];
  const lists: WorkflowSuperNodeSummaryListSection[] = [];
  const missingFields: string[] = [];

  switch (type) {
    case 'multi_source':
      pushText(texts, '综合判断', data.synthesis);
      pushList(lists, '核心数据', data.coreData);
      pushList(lists, '趋势信号', data.signals);
      pushList(lists, '异常点', data.anomalies);
      pushList(lists, '建议动作', data.recommendedActions);
      trackMissingString(missingFields, '综合判断', data.synthesis);
      trackMissingList(missingFields, '核心数据', data.coreData);
      trackMissingList(missingFields, '趋势信号', data.signals);
      trackMissingList(missingFields, '异常点', data.anomalies);
      trackMissingList(missingFields, '建议动作', data.recommendedActions);
      return texts.length > 0 || lists.length > 0
        ? { title: '行业信息整合包', highlights, texts, lists, missingFields }
        : null;
    case 'debate':
      pushText(texts, '主持总结', data.moderatorSummary);
      pushList(lists, '核心观点', data.coreClaims);
      pushList(lists, '分歧点', data.disagreements);
      pushList(lists, '共识结论', data.consensus);
      pushList(lists, '待补证据', data.evidenceGaps);
      trackMissingString(missingFields, '主持总结', data.moderatorSummary);
      trackMissingList(missingFields, '核心观点', data.coreClaims);
      trackMissingList(missingFields, '分歧点', data.disagreements);
      trackMissingList(missingFields, '共识结论', data.consensus);
      trackMissingList(missingFields, '待补证据', data.evidenceGaps);
      return texts.length > 0 || lists.length > 0
        ? { title: '对抗辩论纪要', highlights, texts, lists, missingFields }
        : null;
    case 'decision':
      pushHighlight(highlights, '方向', data.direction);
      pushHighlight(highlights, '优先级', data.priority);
      pushHighlight(highlights, '置信度', data.confidence);
      pushText(texts, '决策依据', data.rationale);
      pushList(lists, '执行步骤', data.executionSteps);
      pushList(lists, '关键依赖', data.dependencies);
      trackMissingString(missingFields, '方向', data.direction);
      trackMissingString(missingFields, '优先级', data.priority);
      trackMissingString(missingFields, '置信度', data.confidence);
      trackMissingString(missingFields, '决策依据', data.rationale);
      trackMissingList(missingFields, '执行步骤', data.executionSteps);
      trackMissingList(missingFields, '关键依赖', data.dependencies);
      return highlights.length > 0 || texts.length > 0 || lists.length > 0
        ? { title: '结构化决策方案', highlights, texts, lists, missingFields }
        : null;
    case 'risk_review':
      pushHighlight(highlights, '风险等级', data.riskLevel);
      pushHighlight(highlights, '是否建议继续', data.proceedRecommendation);
      pushList(lists, '主要风险', data.majorRisks);
      pushList(lists, '整改建议', data.mitigations);
      pushList(lists, '否决项', data.vetoItems);
      trackMissingString(missingFields, '风险等级', data.riskLevel);
      trackMissingString(missingFields, '是否建议继续', data.proceedRecommendation);
      trackMissingList(missingFields, '主要风险', data.majorRisks);
      trackMissingList(missingFields, '整改建议', data.mitigations);
      trackMissingList(missingFields, '否决项', data.vetoItems);
      return highlights.length > 0 || lists.length > 0
        ? { title: '风险审核报告', highlights, texts, lists, missingFields }
        : null;
    case 'adjudication':
      pushHighlight(highlights, '拍板结果', data.verdict);
      pushHighlight(highlights, '责任归属', data.owner);
      pushText(texts, '决策备忘', data.decisionMemo);
      pushList(lists, '落地节点', data.milestones);
      pushList(lists, '继续观察项', data.watchItems);
      trackMissingString(missingFields, '拍板结果', data.verdict);
      trackMissingString(missingFields, '责任归属', data.owner);
      trackMissingString(missingFields, '决策备忘', data.decisionMemo);
      trackMissingList(missingFields, '落地节点', data.milestones);
      trackMissingList(missingFields, '继续观察项', data.watchItems);
      return highlights.length > 0 || texts.length > 0 || lists.length > 0
        ? { title: '最终执行方案', highlights, texts, lists, missingFields }
        : null;
  }
}