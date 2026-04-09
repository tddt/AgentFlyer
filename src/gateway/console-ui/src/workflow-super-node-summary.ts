import type { StepType } from './types.js';

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
}

type SuperNodeStepType = Extract<
  StepType,
  'multi_source' | 'debate' | 'decision' | 'risk_review' | 'adjudication'
>;

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

export function parseWorkflowSuperNodeStructuredSummary(
  type: StepType | undefined,
  output: string | undefined,
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

  return buildSummaryByType(type, data);
}

function buildSummaryByType(
  type: SuperNodeStepType,
  data: Record<string, unknown>,
): WorkflowSuperNodeStructuredSummary | null {
  const highlights: WorkflowSuperNodeSummaryHighlight[] = [];
  const texts: WorkflowSuperNodeSummaryTextSection[] = [];
  const lists: WorkflowSuperNodeSummaryListSection[] = [];

  switch (type) {
    case 'multi_source':
      pushText(texts, '综合判断', data.synthesis);
      pushList(lists, '核心数据', data.coreData);
      pushList(lists, '趋势信号', data.signals);
      pushList(lists, '异常点', data.anomalies);
      pushList(lists, '建议动作', data.recommendedActions);
      return texts.length > 0 || lists.length > 0
        ? { title: '行业信息整合包', highlights, texts, lists }
        : null;
    case 'debate':
      pushText(texts, '主持总结', data.moderatorSummary);
      pushList(lists, '核心观点', data.coreClaims);
      pushList(lists, '分歧点', data.disagreements);
      pushList(lists, '共识结论', data.consensus);
      pushList(lists, '待补证据', data.evidenceGaps);
      return texts.length > 0 || lists.length > 0
        ? { title: '对抗辩论纪要', highlights, texts, lists }
        : null;
    case 'decision':
      pushHighlight(highlights, '方向', data.direction);
      pushHighlight(highlights, '优先级', data.priority);
      pushHighlight(highlights, '置信度', data.confidence);
      pushText(texts, '决策依据', data.rationale);
      pushList(lists, '执行步骤', data.executionSteps);
      pushList(lists, '关键依赖', data.dependencies);
      return highlights.length > 0 || texts.length > 0 || lists.length > 0
        ? { title: '结构化决策方案', highlights, texts, lists }
        : null;
    case 'risk_review':
      pushHighlight(highlights, '风险等级', data.riskLevel);
      pushHighlight(highlights, '是否建议继续', data.proceedRecommendation);
      pushList(lists, '主要风险', data.majorRisks);
      pushList(lists, '整改建议', data.mitigations);
      pushList(lists, '否决项', data.vetoItems);
      return highlights.length > 0 || lists.length > 0
        ? { title: '风险审核报告', highlights, texts, lists }
        : null;
    case 'adjudication':
      pushHighlight(highlights, '拍板结果', data.verdict);
      pushHighlight(highlights, '责任归属', data.owner);
      pushText(texts, '决策备忘', data.decisionMemo);
      pushList(lists, '落地节点', data.milestones);
      pushList(lists, '继续观察项', data.watchItems);
      return highlights.length > 0 || texts.length > 0 || lists.length > 0
        ? { title: '最终执行方案', highlights, texts, lists }
        : null;
  }
}