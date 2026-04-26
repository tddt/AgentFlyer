/**
 * WorkflowEditor — form for creating and editing workflow definitions.
 * Supports agent / transform / condition / http step types.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../components/Button.js';
import { useLocale } from '../context/i18n.js';
import type { Locale } from '../context/i18n.js';
import { rpc } from '../hooks/useRpc.js';
import type {
  AgentInfo,
  ChannelInfo,
  ConditionBranch,
  PublicationTargetConfig,
  StepOutputVar,
  StepType,
  WorkflowDef,
  WorkflowDiagnoseResult,
  WorkflowDesignerLayout,
  WorkflowDesignerPosition,
  WorkflowGraphDiagnostic,
  WorkflowRunRecord,
  WorkflowValidationDiagnostic,
  WorkflowStep,
} from '../types.js';

function formatAgentOptionLabel(agent: AgentInfo): string {
  const baseLabel = agent.name ?? agent.agentId;
  return agent.sandboxProfile ? `${baseLabel} [sandbox:${agent.sandboxProfile}]` : baseLabel;
}

function getPreferredAgent(agentList: AgentInfo[]): AgentInfo | null {
  return (
    agentList.find((agent) => agent.sandboxProfile === 'readonly-output') ??
    agentList.find((agent) => !!agent.sandboxProfile) ??
    null
  );
}

function getWorkflowAgentHint(step: WorkflowStep, agentList: AgentInfo[], locale: Locale = 'zh'): string | null {
  const agentId = step.agentId?.trim();
  if (!agentId) {
    const preferred = getPreferredAgent(agentList);
    return preferred
      ? locale === 'zh'
        ? `建议优先选择 ${formatAgentOptionLabel(preferred)} 作为受限执行目标。`
        : `Prefer ${formatAgentOptionLabel(preferred)} as the constrained execution target.`
      : null;
  }

  const selected = agentList.find((agent) => agent.agentId === agentId);
  if (!selected) {
    return null;
  }
  if (selected.sandboxProfile === 'readonly-output') {
    return locale === 'zh'
      ? '当前已选择 readonly-output，只读执行路径优先。'
      : 'readonly-output is selected, so the read-only execution path is preferred.';
  }
  if (selected.sandboxProfile) {
    return locale === 'zh'
      ? `当前已绑定 sandbox:${selected.sandboxProfile}。`
      : `sandbox:${selected.sandboxProfile} is currently bound.`;
  }

  const preferred = getPreferredAgent(agentList);
  if (preferred && preferred.agentId !== selected.agentId) {
    return locale === 'zh'
      ? `当前 agent 未绑定 sandboxProfile，建议切换到 ${formatAgentOptionLabel(preferred)}。`
      : `The current agent has no sandboxProfile. Consider switching to ${formatAgentOptionLabel(preferred)}.`;
  }
  return locale === 'zh'
    ? '当前 agent 未绑定 sandboxProfile，建议在自动化执行前绑定 readonly-output 或其他受限 profile。'
    : 'The current agent has no sandboxProfile. Bind readonly-output or another constrained profile before automated execution.';
}

function agentSearchText(agent: AgentInfo): string {
  return [agent.agentId, agent.name ?? '', ...(agent.mentionAliases ?? [])].join(' ').toLowerCase();
}

function scoreAgentByKeywords(agent: AgentInfo, keywords: string[]): number {
  const haystack = agentSearchText(agent);
  return keywords.reduce((score, keyword) => (haystack.includes(keyword) ? score + 1 : score), 0);
}

function matchedAgentKeywords(agent: AgentInfo, keywords: string[]): string[] {
  const haystack = agentSearchText(agent);
  return Array.from(new Set(keywords.filter((keyword) => haystack.includes(keyword)))).slice(0, 3);
}

function typeKeywords(type: StepType, role: 'coordinator' | 'participant'): string[] {
  switch (type) {
    case 'multi_source':
      return role === 'coordinator'
        ? ['synth', 'coordinator', 'lead', 'manager', 'analyst', '汇总', '协调', '统筹']
        : ['research', 'intel', 'market', 'user', 'competitor', 'collect', '采集', '研究', '情报', '市场', '竞品', '用户'];
    case 'debate':
      return role === 'coordinator'
        ? ['moderator', 'judge', 'lead', 'review', '主持', '裁决', '协调']
        : ['debate', 'critic', 'opponent', 'advocate', 'challenge', '辩论', '正方', '反方', '质询', '评审'];
    case 'decision':
      return role === 'coordinator'
        ? ['decide', 'planner', 'strategy', 'lead', '决策', '策略', '规划', '负责人']
        : ['analysis', 'business', 'growth', 'cost', 'product', '分析', '收益', '成本', '产品'];
    case 'risk_review':
      return role === 'coordinator'
        ? ['audit', 'lead', 'review', 'risk', '审核', '风控', '负责人']
        : ['risk', 'compliance', 'security', 'legal', 'audit', '风控', '合规', '法务', '审计', '安全'];
    case 'adjudication':
      return role === 'coordinator'
        ? ['judge', 'owner', 'exec', 'lead', '裁定', '拍板', '负责人', '管理']
        : ['owner', 'delivery', 'milestone', 'ops', '责任', '执行', '里程碑', '运营'];
    default:
      return role === 'coordinator'
        ? ['lead', 'coordinator', 'manager', '协调', '统筹']
        : ['analysis', 'research', 'review', '分析', '研究', '评审'];
  }
}

type RankedAgentRecommendation = {
  agent: AgentInfo;
  score: number;
  reasons: string[];
};

function buildAgentRecommendation(
  agent: AgentInfo,
  type: StepType,
  role: 'coordinator' | 'participant',
): RankedAgentRecommendation {
  const reasons = matchedAgentKeywords(agent, typeKeywords(type, role));
  const sandboxReason = agent.sandboxProfile ? [`sandbox:${agent.sandboxProfile}`] : [];
  return {
    agent,
    score: scoreAgentByKeywords(agent, typeKeywords(type, role)),
    reasons: [...reasons, ...sandboxReason].slice(0, 3),
  };
}

function rankSuperStepAgents(
  type: StepType,
  agents: AgentInfo[],
): { coordinator: RankedAgentRecommendation | null; participants: RankedAgentRecommendation[] } {
  const preferred = getPreferredAgent(agents);
  const coordinatorRanked = agents.map((agent) => buildAgentRecommendation(agent, type, 'coordinator')).sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    if (preferred && left.agent.agentId === preferred.agentId) return -1;
    if (preferred && right.agent.agentId === preferred.agentId) return 1;
    return formatAgentOptionLabel(left.agent).localeCompare(formatAgentOptionLabel(right.agent), 'zh-CN');
  });

  const coordinator = coordinatorRanked[0] ?? null;
  const participantRanked = agents
    .filter((agent) => agent.agentId !== coordinator?.agent.agentId)
    .map((agent) => buildAgentRecommendation(agent, type, 'participant'))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      if (preferred && left.agent.agentId === preferred.agentId) return 1;
      if (preferred && right.agent.agentId === preferred.agentId) return -1;
      return formatAgentOptionLabel(left.agent).localeCompare(formatAgentOptionLabel(right.agent), 'zh-CN');
    });

  const minimumParticipants =
    type === 'debate' ? 2 : type === 'multi_source' || type === 'risk_review' ? 1 : 2;
  const participants = participantRanked.slice(0, Math.min(Math.max(minimumParticipants, 1), participantRanked.length));

  return { coordinator, participants };
}

type WorkflowStageMeta = {
  id: string;
  title: string;
  accent: string;
};

type WorkflowStageSummary = {
  stage: WorkflowStageMeta;
  stepCount: number;
  issueCount: number;
  avgCompletion: number;
  waitingCount: number;
  firstStepId?: string;
  actions: WorkflowStageAction[];
};

type WorkflowChecklistItem = {
  id: string;
  stepId?: string;
  message: string;
  tone: 'warn' | 'neutral';
};

type WorkflowStageAction = {
  id: string;
  stepId: string;
  label: string;
};

type WorkflowEditorMode = 'form' | 'graph';

type GraphConnectionState = {
  sourceStepId: string;
  mode: 'next' | 'branch';
  branchIndex?: number;
};

type WorkflowGraphEdge = {
  id: string;
  fromStepId: string;
  toStepId: string;
  tone: 'default' | 'branch';
  label?: string;
};

type DragState = {
  stepIds: string[];
  pointerId: number;
  startX: number;
  startY: number;
  origins: Record<string, WorkflowDesignerPosition>;
};

type GraphMarqueeState = {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

type WorkflowGraphCanvasMetrics = {
  width: number;
  height: number;
  contentWidth: number;
  contentHeight: number;
};

const GRAPH_NODE_WIDTH = 208;
const GRAPH_NODE_HEIGHT = 132;
const GRAPH_STAGE_GAP_X = 300;
const GRAPH_STAGE_GAP_Y = 184;
const GRAPH_END_NODE_ID = '$end';
const GRAPH_END_NODE_WIDTH = 144;
const GRAPH_END_NODE_HEIGHT = 84;

function buildDefaultWorkflowDesignerPositions(steps: WorkflowStep[]): Record<string, WorkflowDesignerPosition> {
  const stageColumnOffsets = new Map<string, number>();
  const positions: Record<string, WorkflowDesignerPosition> = {};
  let fallbackColumn = 0;

  for (const step of steps) {
    const stage = getWorkflowStageMeta(step.type ?? 'agent');
    if (!stageColumnOffsets.has(stage.id)) {
      stageColumnOffsets.set(stage.id, fallbackColumn);
      fallbackColumn += 1;
    }
    const column = stageColumnOffsets.get(stage.id) ?? 0;
    const row = Object.values(positions).filter((position) => position.x === 72 + column * GRAPH_STAGE_GAP_X).length;
    positions[step.id] = {
      x: 72 + column * GRAPH_STAGE_GAP_X,
      y: 72 + row * GRAPH_STAGE_GAP_Y,
    };
  }

  return positions;
}

function normalizeWorkflowDesignerLayout(
  steps: WorkflowStep[],
  layout: WorkflowDesignerLayout | undefined,
): WorkflowDesignerLayout {
  const defaults = buildDefaultWorkflowDesignerPositions(steps);
  const positions: Record<string, WorkflowDesignerPosition> = {};

  for (const step of steps) {
    positions[step.id] = layout?.positions?.[step.id] ?? defaults[step.id] ?? { x: 72, y: 72 };
  }

  return {
    preferredMode: layout?.preferredMode,
    positions,
  };
}

function clampDesignerPosition(position: WorkflowDesignerPosition): WorkflowDesignerPosition {
  return {
    x: Math.max(24, position.x),
    y: Math.max(24, position.y),
  };
}

function summarizeBranchExpression(expression: string | undefined): string {
  const normalized = (expression ?? '').trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return '未命名分支';
  }
  return normalized.length > 18 ? `${normalized.slice(0, 18)}...` : normalized;
}

function buildWorkflowGraphEdges(steps: WorkflowStep[]): WorkflowGraphEdge[] {
  const edges: WorkflowGraphEdge[] = [];

  for (const [index, step] of steps.entries()) {
    if (step.type === 'condition') {
      for (const [branchIndex, branch] of (step.branches ?? []).entries()) {
        if (!branch.goto) {
          continue;
        }
        edges.push({
          id: `${step.id}:branch:${branchIndex}:${branch.goto}`,
          fromStepId: step.id,
          toStepId: branch.goto === '$end' ? GRAPH_END_NODE_ID : branch.goto,
          tone: 'branch',
          label: summarizeBranchExpression(branch.expression),
        });
      }
      continue;
    }

    const targetStepId = step.nextStepId === '$end' ? GRAPH_END_NODE_ID : step.nextStepId ?? steps[index + 1]?.id;
    if (!targetStepId) {
      continue;
    }
    edges.push({
      id: `${step.id}:next:${targetStepId}`,
      fromStepId: step.id,
      toStepId: targetStepId,
      tone: 'default',
    });
  }

  return edges;
}

/** Parse all {{vars.stepId.varName}} references from a template string. */
function parseVarRefs(template: string): string[] {
  const stepIds: string[] = [];
  const pattern = /\{\{vars\.([^.}]+)\.[^}]+\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(template)) !== null) {
    if (m[1] && !stepIds.includes(m[1])) stepIds.push(m[1]);
  }
  return stepIds;
}

/** Build data-flow edges: step A declares {{vars.B.*}} → A depends on B. */
function buildDataFlowEdges(steps: WorkflowStep[]): Array<{ fromStepId: string; toStepId: string }> {
  const stepIdSet = new Set(steps.map((s) => s.id));
  const edges: Array<{ fromStepId: string; toStepId: string }> = [];
  for (const step of steps) {
    const templates = [
      step.messageTemplate,
      step.bodyTemplate ?? '',
      step.transformCode ?? '',
      ...(step.superNodePrompts ?? []),
      ...(step.branches?.map((b) => b.expression) ?? []),
    ].join(' ');
    for (const sourceId of parseVarRefs(templates)) {
      if (stepIdSet.has(sourceId) && sourceId !== step.id) {
        edges.push({ fromStepId: sourceId, toStepId: step.id });
      }
    }
  }
  return edges;
}

function buildWorkflowGraphEndPosition(
  steps: WorkflowStep[],
  positions: Record<string, WorkflowDesignerPosition>,
): WorkflowDesignerPosition {
  if (steps.length === 0) {
    return { x: 420, y: 180 };
  }

  const coordinates = steps.map((step) => positions[step.id] ?? { x: 72, y: 72 });
  const maxX = Math.max(...coordinates.map((position) => position.x));
  const avgY = coordinates.reduce((sum, position) => sum + position.y, 0) / coordinates.length;
  return {
    x: maxX + GRAPH_STAGE_GAP_X,
    y: Math.max(72, Math.round(avgY)),
  };
}

function buildWorkflowGraphCanvasMetrics(
  steps: WorkflowStep[],
  positions: Record<string, WorkflowDesignerPosition>,
  endPosition: WorkflowDesignerPosition,
): WorkflowGraphCanvasMetrics {
  const maxNodeX = Math.max(
    ...steps.map((step) => (positions[step.id]?.x ?? 72) + GRAPH_NODE_WIDTH),
    endPosition.x + GRAPH_END_NODE_WIDTH,
    1200,
  );
  const maxNodeY = Math.max(
    ...steps.map((step) => (positions[step.id]?.y ?? 72) + GRAPH_NODE_HEIGHT),
    endPosition.y + GRAPH_END_NODE_HEIGHT,
    720,
  );

  return {
    width: maxNodeX + 180,
    height: maxNodeY + 180,
    contentWidth: maxNodeX,
    contentHeight: maxNodeY,
  };
}

function buildGraphSelectionBounds(selection: GraphMarqueeState): {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
} {
  const left = Math.min(selection.startX, selection.currentX);
  const top = Math.min(selection.startY, selection.currentY);
  const right = Math.max(selection.startX, selection.currentX);
  const bottom = Math.max(selection.startY, selection.currentY);
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
    right,
    bottom,
  };
}

function intersectsGraphSelection(
  position: WorkflowDesignerPosition,
  selection: { left: number; top: number; right: number; bottom: number },
): boolean {
  const nodeRight = position.x + GRAPH_NODE_WIDTH;
  const nodeBottom = position.y + GRAPH_NODE_HEIGHT;
  return !(
    nodeRight < selection.left ||
    position.x > selection.right ||
    nodeBottom < selection.top ||
    position.y > selection.bottom
  );
}

function describeGraphConnectionState(
  state: GraphConnectionState | null,
  steps: WorkflowStep[],
  locale: Locale,
): string | null {
  if (!state) {
    return null;
  }
  const step = steps.find((item) => item.id === state.sourceStepId);
  const label = step?.label ?? state.sourceStepId;
  if (state.mode === 'next') {
    return locale === 'zh'
      ? `${label} 的主链路连线已激活，点击目标节点即可更新下一步。`
      : `Main path linking is active for ${label}. Click a target node to update the next step.`;
  }
  const branchNumber = typeof state.branchIndex === 'number' ? state.branchIndex + 1 : '';
  return locale === 'zh'
    ? `${label} 的分支 ${branchNumber} 连线已激活，点击目标节点即可绑定 goto。`
    : `Branch ${branchNumber} linking is active for ${label}. Click a target node to bind its goto.`;
}

function getWorkflowStageMeta(type: StepType, locale: Locale = 'zh'): WorkflowStageMeta {
  switch (type) {
    case 'multi_source':
      return { id: 'collect', title: locale === 'zh' ? '采集阶段' : 'Collection', accent: 'text-cyan-300 bg-cyan-500/10 ring-cyan-500/25' };
    case 'debate':
      return { id: 'debate', title: locale === 'zh' ? '辩论阶段' : 'Debate', accent: 'text-rose-300 bg-rose-500/10 ring-rose-500/25' };
    case 'decision':
      return { id: 'decide', title: locale === 'zh' ? '决策阶段' : 'Decision', accent: 'text-sky-300 bg-sky-500/10 ring-sky-500/25' };
    case 'risk_review':
      return { id: 'risk', title: locale === 'zh' ? '风控阶段' : 'Risk Review', accent: 'text-orange-300 bg-orange-500/10 ring-orange-500/25' };
    case 'adjudication':
      return { id: 'adjudicate', title: locale === 'zh' ? '裁定阶段' : 'Adjudication', accent: 'text-fuchsia-300 bg-fuchsia-500/10 ring-fuchsia-500/25' };
    default:
      return { id: 'general', title: locale === 'zh' ? '通用编排' : 'General', accent: 'text-slate-300 bg-slate-800/70 ring-slate-700/60' };
  }
}

function collectWorkflowStages(steps: WorkflowStep[], locale: Locale = 'zh'): WorkflowStageMeta[] {
  return steps.reduce<WorkflowStageMeta[]>((acc, step) => {
    const stage = getWorkflowStageMeta(step.type ?? 'agent', locale);
    if (acc[acc.length - 1]?.id !== stage.id) {
      acc.push(stage);
    }
    return acc;
  }, []);
}

function collectWorkflowStageSummaries(
  steps: WorkflowStep[],
  stepIssueMap: Record<string, string[]>,
  locale: Locale = 'zh',
): WorkflowStageSummary[] {
  const grouped = new Map<
    string,
    { stage: WorkflowStageMeta; steps: WorkflowStep[]; issueCount: number; completionSum: number; waitingCount: number }
  >();

  for (const step of steps) {
    const stage = getWorkflowStageMeta(step.type ?? 'agent', locale);
    const issues = stepIssueMap[step.id] ?? [];
    const completion = buildStepCompletionMetrics(step, issues);
    const waitingCount = buildStepReadinessPills(step).filter((pill) => pill.tone === 'warn').length;
    const current = grouped.get(stage.id);
    if (current) {
      current.steps.push(step);
      current.issueCount += issues.length;
      current.completionSum += completion.percent;
      current.waitingCount += waitingCount;
    } else {
      grouped.set(stage.id, {
        stage,
        steps: [step],
        issueCount: issues.length,
        completionSum: completion.percent,
        waitingCount,
      });
    }
  }

  return Array.from(grouped.values()).map((item) => {
    const actions: WorkflowStageAction[] = [];

    for (const step of item.steps) {
      const type = step.type ?? 'agent';
      if ((type === 'agent' || isSuperStepType(type)) && !step.agentId?.trim()) {
        actions.push({
          id: `coordinator-${step.id}`,
          stepId: step.id,
          label: locale === 'zh' ? '补协调者' : 'Set coordinator',
        });
      }

      if (isSuperStepType(type)) {
        const participantCount = step.participantAgentIds?.length ?? 0;
        const minimumParticipants =
          type === 'debate' ? 2 : type === 'multi_source' || type === 'risk_review' ? 1 : 0;
        if (participantCount < minimumParticipants) {
          actions.push({
            id: `participants-${step.id}`,
            stepId: step.id,
            label: locale === 'zh' ? '补参与者' : 'Set participants',
          });
        }
        if ((step.superNodePrompts?.length ?? 0) === 0) {
          actions.push({
            id: `prompts-${step.id}`,
            stepId: step.id,
            label: locale === 'zh' ? '补视角提示' : 'Add prompts',
          });
        }
      }

      if ((step.outputs?.length ?? 0) === 0 && (type === 'agent' || isSuperStepType(type) || type === 'http')) {
        actions.push({
          id: `outputs-${step.id}`,
          stepId: step.id,
          label: locale === 'zh' ? '补输出变量' : 'Add outputs',
        });
      }

      if (actions.length >= 3) {
        break;
      }
    }

    return {
      stage: item.stage,
      stepCount: item.steps.length,
      issueCount: item.issueCount,
      avgCompletion: Math.round(item.completionSum / item.steps.length),
      waitingCount: item.waitingCount,
      firstStepId: item.steps[0]?.id,
      actions,
    };
  });
}

function collectWorkflowChecklistItems(
  workflowName: string,
  steps: WorkflowStep[],
  stepIssueMap: Record<string, string[]>,
  publicationTargets: PublicationTargetConfig[],
  locale: Locale = 'zh',
): WorkflowChecklistItem[] {
  const items: WorkflowChecklistItem[] = [];
  if (!workflowName.trim()) {
    items.push({
      id: 'workflow-name',
      message: locale === 'zh' ? '先给当前 workflow 起一个明确名称。' : 'Give this workflow a clear name first.',
      tone: 'warn',
    });
  }
  if (steps.length === 0) {
    items.push({
      id: 'workflow-empty',
      message: locale === 'zh' ? '当前还没有步骤，先添加一个起始节点。' : 'There are no steps yet. Add a starting node first.',
      tone: 'warn',
    });
    return items;
  }

  for (const step of steps) {
    const type = step.type ?? 'agent';
    const stepLabel = step.label ?? step.id;
    const stepIssues = stepIssueMap[step.id] ?? [];
    if (stepIssues.length > 0) {
      items.push({
        id: `issue-${step.id}`,
        stepId: step.id,
        message:
          locale === 'zh'
            ? `${stepLabel} 还有 ${stepIssues.length} 个诊断问题待处理。`
            : `${stepLabel} still has ${stepIssues.length} diagnostic issues to resolve.`,
        tone: 'warn',
      });
    }
    if ((type === 'agent' || isSuperStepType(type)) && !step.agentId?.trim()) {
      items.push({
        id: `agent-${step.id}`,
        stepId: step.id,
        message:
          locale === 'zh'
            ? `${stepLabel} 还没有选择协调 / 执行 agent。`
            : `${stepLabel} does not have a coordinator/execution agent yet.`,
        tone: 'warn',
      });
    }
    if (isSuperStepType(type)) {
      const participantCount = step.participantAgentIds?.length ?? 0;
      const minimumParticipants =
        type === 'debate' ? 2 : type === 'multi_source' || type === 'risk_review' ? 1 : 0;
      if (participantCount < minimumParticipants) {
        items.push({
          id: `participants-${step.id}`,
          stepId: step.id,
          message:
            locale === 'zh'
              ? `${stepLabel} 的参与 agent 数量不足，当前 ${participantCount}，至少需要 ${minimumParticipants}。`
              : `${stepLabel} does not have enough participant agents. Current: ${participantCount}, required: ${minimumParticipants}.`,
          tone: 'warn',
        });
      }
      if ((step.superNodePrompts?.length ?? 0) === 0) {
        items.push({
          id: `prompts-${step.id}`,
          stepId: step.id,
          message:
            locale === 'zh'
              ? `${stepLabel} 还没有配置视角 / 立场提示。`
              : `${stepLabel} does not have prompts/stances configured yet.`,
          tone: 'warn',
        });
      }
      if ((step.outputs?.length ?? 0) === 0) {
        items.push({
          id: `outputs-${step.id}`,
          stepId: step.id,
          message:
            locale === 'zh'
              ? `${stepLabel} 还没有命名输出变量，建议套用结构化模板。`
              : `${stepLabel} does not have named output variables yet. Consider applying a structured preset.`,
          tone: 'neutral',
        });
      }
    }
  }

  if (publicationTargets.length === 0) {
    items.push({
      id: 'publication-targets',
      message:
        locale === 'zh'
          ? '当前未配置交付物传播渠道，如需自动发送 deliverable 可补一个目标。'
          : 'No deliverable publication target is configured. Add one if you want automatic delivery.',
      tone: 'neutral',
    });
  }

  return items.slice(0, 8);
}

// ── WorkflowGuide ─────────────────────────────────────────────────────────────

function WorkflowGuide({ onClose }: { onClose: () => void }) {
  const { locale } = useLocale();
  const [tab, setTab] = useState<'overview' | 'steps' | 'vars' | 'format'>('overview');
  const guideText =
    locale === 'zh'
      ? {
          title: '📖 工作流使用说明',
          tabOverview: '概览',
          tabSteps: '步骤类型',
          tabVars: '变量系统',
          tabFormat: '输出格式',
          quickStart: '快速上手',
          quickStartLine1: '进入工作流编辑器后，在页面中部、阶段摘要和待补清单下面，可以看到',
          quickStartSwitch: '当前表单版 / 图形设计器',
          quickStartLine2: '切换区。',
          quickStartLine3: '如果想用画布版，直接点击',
          quickStartGraph: '图形设计器',
          quickStartLine4: '或下方的“进入画布设计器”入口即可。',
        }
      : {
          title: '📖 Workflow Guide',
          tabOverview: 'Overview',
          tabSteps: 'Step Types',
          tabVars: 'Variables',
          tabFormat: 'Output',
          quickStart: 'Quick Start',
          quickStartLine1: 'In the workflow editor, look in the middle of the page under stage summaries and the checklist for the',
          quickStartSwitch: 'Form / Graph Designer',
          quickStartLine2: 'switch.',
          quickStartLine3: 'To use the canvas view, click',
          quickStartGraph: 'Graph Designer',
          quickStartLine4: 'or use the “Open Canvas Designer” entry below.',
        };
  const tabCls = (t: string) =>
    `px-3 py-1.5 text-xs rounded-lg transition-colors ${
      tab === t
        ? 'bg-indigo-600/30 ring-1 ring-indigo-500/50 text-indigo-200'
        : 'text-slate-500 hover:text-slate-300'
    }`;
  const h3 = 'text-xs font-semibold text-slate-200 mb-1.5';
  const p = 'text-xs text-slate-400 leading-relaxed';
  const code =
    'font-mono bg-slate-900/80 ring-1 ring-slate-700/60 rounded px-1 py-0.5 text-emerald-300 text-[11px]';
  const li = 'text-xs text-slate-400 leading-relaxed list-disc list-inside';

  return (
    <div className="rounded-xl bg-slate-800/80 ring-1 ring-slate-700/60 flex flex-col overflow-hidden">
      {/* Guide header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700/50">
        <span className="text-sm font-semibold text-slate-100">{guideText.title}</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-sm">
          ✕
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 px-4 pt-3">
        <button className={tabCls('overview')} onClick={() => setTab('overview')}>
          {guideText.tabOverview}
        </button>
        <button className={tabCls('steps')} onClick={() => setTab('steps')}>
          {guideText.tabSteps}
        </button>
        <button className={tabCls('vars')} onClick={() => setTab('vars')}>
          {guideText.tabVars}
        </button>
        <button className={tabCls('format')} onClick={() => setTab('format')}>
          {guideText.tabFormat}
        </button>
      </div>

      <div className="px-4 py-4 flex flex-col gap-4 max-h-[70vh] overflow-y-auto text-sm">
        {/* ── 概览 ── */}
        {tab === 'overview' && (
          <>
            <section className="flex flex-col gap-1.5">
              <h3 className={h3}>什么是工作流？</h3>
              <p className={p}>
                工作流是将多个 Agent/操作串联成
                <strong className="text-slate-300">有序流水线</strong>的机制。
                每个步骤的输出可以传递给下一步，支持条件跳转、数据转换和 HTTP
                调用，构建复杂的自动化场景。
              </p>
            </section>

            <section className="flex flex-col gap-1.5">
              <h3 className={h3}>{guideText.quickStart}</h3>
              <div className="rounded-lg bg-cyan-500/10 ring-1 ring-cyan-500/20 p-3 flex flex-col gap-2">
                <p className={p}>
                  {guideText.quickStartLine1}
                  <strong className="text-cyan-200">{guideText.quickStartSwitch}</strong>
                  {guideText.quickStartLine2}
                </p>
                <p className={p}>
                  {guideText.quickStartLine3}
                  <strong className="text-cyan-200">{guideText.quickStartGraph}</strong>
                  {guideText.quickStartLine4}
                </p>
              </div>
            </section>

            <section className="flex flex-col gap-1.5">
              <h3 className={h3}>工作流结构</h3>
              <div className="rounded-lg bg-slate-900/60 ring-1 ring-slate-700/40 p-3 flex flex-col gap-2">
                <div className="flex items-start gap-2">
                  <span className="text-indigo-400 font-mono text-xs w-20 shrink-0">名称 *</span>
                  <span className={p}>工作流的唯一显示名称，必填。</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-indigo-400 font-mono text-xs w-20 shrink-0">描述</span>
                  <span className={p}>可选说明文字，显示在列表卡片上。</span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-indigo-400 font-mono text-xs w-20 shrink-0">初始输入</span>
                  <span className={p}>
                    开关打开时运行前弹出输入框，内容可用 <code className={code}>{'{{input}}'}</code>{' '}
                    引用； 关闭时直接执行，适合定时任务或无用户交互的流程。
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-indigo-400 font-mono text-xs w-20 shrink-0">全局变量</span>
                  <span className={p}>
                    在所有步骤都可用的常量，用 <code className={code}>{'{{globals.key}}'}</code>{' '}
                    引用。
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-indigo-400 font-mono text-xs w-20 shrink-0">步骤</span>
                  <span className={p}>流水线节点，默认按顺序执行，可通过 Condition 步骤跳转。</span>
                </div>
              </div>
            </section>

            <section className="flex flex-col gap-1.5">
              <h3 className={h3}>执行流程</h3>
              <div className="rounded-lg bg-slate-900/60 ring-1 ring-slate-700/40 p-3 font-mono text-xs text-slate-400 leading-relaxed">
                用户输入 (input)
                <br />
                &nbsp;&nbsp;↓
                <br />
                Step 1 → 输出 prev_output
                <br />
                &nbsp;&nbsp;↓
                <br />
                Step 2 → 获取 prev_output，输出新 prev_output
                <br />
                &nbsp;&nbsp;↓
                <br />
                Condition → 判断跳转到 Step N 或 $end
                <br />
                &nbsp;&nbsp;↓
                <br />
                完成 (done)
              </div>
            </section>
          </>
        )}

        {/* ── 步骤类型 ── */}
        {tab === 'steps' && (
          <>
            <section className="flex flex-col gap-1.5">
              <h3 className={h3}>🤖 Agent 步骤</h3>
              <p className={p}>将消息发送给指定 Agent，等待其回复并把回复作为本步输出。</p>
              <ul className="flex flex-col gap-1 mt-1">
                <li className={li}>
                  <strong className="text-slate-300">选择 Agent</strong>：从下拉框选定已注册的
                  Agent。
                </li>
                <li className={li}>
                  <strong className="text-slate-300">消息模板</strong>
                  ：支持所有变量占位符，见「变量系统」。
                </li>
                <li className={li}>
                  <strong className="text-slate-300">输出格式约束</strong>：控制 Agent
                  的回复格式（纯文本/JSON/Markdown/自定义）。
                </li>
                <li className={li}>
                  <strong className="text-slate-300">命名输出变量</strong>
                  ：从本步输出提取字段，在后续步骤中引用。
                </li>
              </ul>
            </section>

            <section className="flex flex-col gap-1.5">
              <h3 className={h3}>⚙️ Transform 步骤</h3>
              <p className={p}>执行轻量 JavaScript 表达式，不调用 LLM，低成本处理数据。</p>
              <div className="rounded-lg bg-slate-900/60 ring-1 ring-slate-700/40 p-3 font-mono text-xs text-emerald-300 leading-relaxed">
                {/* Expression examples */}
                <div className="text-slate-500 mb-1">
                  {'// 可用变量：vars, globals, input, prev_output'}
                </div>
                <div>{'`总结：${prev_output.slice(0, 200)}`'}</div>
                <div className="mt-1">{`vars.step1.title + ' — ' + globals.suffix`}</div>
                <div className="mt-1">{'JSON.stringify({ q: input, result: prev_output })'}</div>
              </div>
            </section>

            <section className="flex flex-col gap-1.5">
              <h3 className={h3}>🔀 Condition 步骤</h3>
              <p className={p}>
                根据上一步输出选择跳转路径。
                <strong className="text-slate-300">从上到下依次判断</strong>，第一个匹配的分支生效。
                若全部不匹配则顺序进入下一步。
              </p>
              <div className="rounded-lg bg-slate-900/60 ring-1 ring-slate-700/40 p-3 font-mono text-xs text-emerald-300 leading-relaxed">
                <div className="text-slate-500 mb-1">
                  {'// 表达式作用域：output, vars, globals'}
                </div>
                <div>{`output.includes('成功')              → step_done`}</div>
                <div className="mt-1">
                  {'output.length > 500                   → step_summarize'}
                </div>
                <div className="mt-1">{`vars.step1.status === 'error'          → $end`}</div>
              </div>
              <p className={`${p} mt-1`}>
                目标填 <code className={code}>$end</code> 表示立即终止整个工作流。
              </p>
            </section>

            <section className="flex flex-col gap-1.5">
              <h3 className={h3}>🌐 HTTP 步骤</h3>
              <p className={p}>向外部 API 发送请求，响应体作为本步输出。</p>
              <ul className="flex flex-col gap-1 mt-1">
                <li className={li}>
                  <strong className="text-slate-300">URL</strong>：支持占位符，如{' '}
                  <code className={code}>{'https://api.example.com/q={{input}}'}</code>
                </li>
                <li className={li}>
                  <strong className="text-slate-300">Method</strong>：GET / POST / PUT / DELETE /
                  PATCH
                </li>
                <li className={li}>
                  <strong className="text-slate-300">请求体模板</strong>：POST/PUT 时填 JSON
                  字符串，支持占位符。
                </li>
                <li className={li}>
                  <strong className="text-slate-300">命名输出变量</strong>：用 JSONPath 从响应 JSON
                  提取字段。
                </li>
              </ul>
            </section>

            <section className="flex flex-col gap-1.5">
              <h3 className={h3}>通用步骤选项</h3>
              <div className="rounded-lg bg-slate-900/60 ring-1 ring-slate-700/40 p-3 flex flex-col gap-2">
                <div className="flex items-start gap-2">
                  <span className="text-indigo-400 font-mono text-xs w-16 shrink-0">继续条件</span>
                  <span className={p}>
                    <strong className="text-slate-300">始终继续</strong>：即使本步失败也执行下一步；
                    <strong className="text-slate-300">成功时继续</strong>：失败则中止整个流程。
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-indigo-400 font-mono text-xs w-16 shrink-0">重试次数</span>
                  <span className={p}>失败后自动重试的次数，最多 10 次，默认 0。</span>
                </div>
              </div>
            </section>
          </>
        )}

        {/* ── 变量系统 ── */}
        {tab === 'vars' && (
          <>
            <section className="flex flex-col gap-1.5">
              <h3 className={h3}>模板占位符汇总</h3>
              <div className="rounded-lg bg-slate-900/60 ring-1 ring-slate-700/40 overflow-hidden">
                {[
                  ['{{input}}', '运行时用户填写的初始输入'],
                  ['{{prev_output}}', '上一步的输出文本'],
                  ['{{step_N_output}}', '第 N 步（1起）的输出，例如 {{step_1_output}}'],
                  ['{{vars.stepId.name}}', '从指定步骤提取的命名变量，stepId 为步骤 ID'],
                  ['{{globals.key}}', '工作流级别的全局常量'],
                ].map(([ph, desc]) => (
                  <div
                    key={ph}
                    className="flex items-start gap-3 px-3 py-2 border-b border-slate-700/30 last:border-0"
                  >
                    <code className={`${code} shrink-0 whitespace-nowrap`}>{ph}</code>
                    <span className={p}>{desc}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="flex flex-col gap-1.5">
              <h3 className={h3}>命名输出变量（Named Output Vars）</h3>
              <p className={p}>
                在 Agent 或 HTTP 步骤底部点「+ 添加变量」，为输出提取命名字段，后续步骤用
                <code className={code}>{'{{vars.<stepId>.<name>}}'}</code> 引用。
              </p>
              <div className="rounded-lg bg-slate-900/60 ring-1 ring-slate-700/40 p-3 flex flex-col gap-2 text-xs">
                <div className="flex items-start gap-2">
                  <span className="text-amber-400 font-mono shrink-0 w-20">JSONPath</span>
                  <span className={p}>
                    从 JSON 输出提取字段，例如 <code className={code}>$.data.title</code> 或{' '}
                    <code className={code}>$.items.0.id</code>
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <span className="text-amber-400 font-mono shrink-0 w-20">Regex</span>
                  <span className={p}>
                    正则第一个捕获组，例如{' '}
                    <code className={code}>{'/价格：(\\d+(\\.\\d+)?)/'}</code>
                  </span>
                </div>
              </div>
            </section>

            <section className="flex flex-col gap-1.5">
              <h3 className={h3}>全局变量（Global Variables）</h3>
              <p className={p}>
                在编辑器顶部「全局变量」区块添加键值对。运行时这些值不会改变， 适合存放 API
                地址、语言偏好、固定 Prompt 片段等。
              </p>
              <div className="rounded-lg bg-slate-900/60 ring-1 ring-slate-700/40 p-3 font-mono text-xs text-slate-400">
                <div>lang = zh-CN</div>
                <div>base_url = https://api.example.com</div>
                <div>system_prompt = 你是一个专业的摘要助手</div>
              </div>
              <p className={p}>
                引用方式：<code className={code}>{'{{globals.lang}}'}</code>、
                <code className={code}>{'{{globals.base_url}}'}</code>
              </p>
            </section>

            <section className="flex flex-col gap-1.5">
              <h3 className={h3}>运行时变量面板</h3>
              <p className={p}>
                运行面板中，每个步骤完成后会实时显示
                <strong className="text-emerald-400">绿色「本步赋值变量」区块</strong>，
                展示该步新提取的命名变量值。流程结束后底部汇总所有变量。历史记录中同样保存完整快照。
              </p>
            </section>
          </>
        )}

        {/* ── 输出格式 ── */}
        {tab === 'format' && (
          <>
            <section className="flex flex-col gap-1.5">
              <h3 className={h3}>输出格式约束（Agent 步骤专属）</h3>
              <p className={p}>
                对 Agent 步骤可设置输出格式约束，系统会在消息末尾自动追加格式要求指令， 使 Agent
                按预期格式回复，便于后续步骤解析。
              </p>
            </section>

            <section className="flex flex-col gap-2">
              {[
                {
                  label: '— 不限制',
                  color: 'text-slate-400',
                  desc: '不追加任何格式指令，Agent 自由回复。',
                  tip: '',
                },
                {
                  label: '纯文本',
                  color: 'text-slate-300',
                  desc: '要求 Agent 不使用任何 Markdown 标记，输出干净文字。适合需要进一步拼接或展示给非 Markdown 环境的场景。',
                  tip: '追加：「请以纯文本格式回答，不要使用任何 Markdown 标记。」',
                },
                {
                  label: 'JSON',
                  color: 'text-emerald-300',
                  desc: '要求 Agent 严格输出合法 JSON，不含多余说明文字。结合 JSONPath 命名变量可直接提取字段。',
                  tip: '追加：「请严格以合法 JSON 格式输出，不要包含说明文字或 Markdown 代码块，只输出 JSON。」',
                },
                {
                  label: 'Markdown',
                  color: 'text-blue-300',
                  desc: '要求 Agent 使用 Markdown 排版，包括标题、列表、代码块等。适合输出报告或展示给用户的内容。',
                  tip: '追加：「请以 Markdown 格式输出，合理使用标题（##）、列表、代码块（```）等格式。」',
                },
                {
                  label: '自定义指令',
                  color: 'text-purple-300',
                  desc: '填写任意格式要求追加到消息末尾。适合特殊结构要求，例如：「以三点式列出，每点不超过 50 字」。',
                  tip: '内容原样追加到消息末尾，与消息正文之间自动插入空行。',
                },
              ].map((item) => (
                <div
                  key={item.label}
                  className="rounded-lg bg-slate-900/60 ring-1 ring-slate-700/40 p-3 flex flex-col gap-1"
                >
                  <span className={`text-xs font-semibold ${item.color}`}>{item.label}</span>
                  <p className={p}>{item.desc}</p>
                  {item.tip && (
                    <p className="text-[11px] text-slate-500 italic mt-0.5">{item.tip}</p>
                  )}
                </div>
              ))}
            </section>

            <section className="flex flex-col gap-1.5 mt-2">
              <h3 className={h3}>最佳实践</h3>
              <ul className="flex flex-col gap-1">
                <li className={li}>
                  需要从 Agent 输出提取字段时，先设置「JSON」格式，再添加 JSONPath 命名变量。
                </li>
                <li className={li}>
                  Condition 步骤判断时，若上一步是 JSON 格式输出，可用{' '}
                  <code className={code}>{'vars.stepId.field'}</code> 代替原始文本匹配。
                </li>
                <li className={li}>
                  Transform 步骤可在 Agent JSON 输出与下一步消息模板之间做格式转换，无需额外 LLM
                  调用。
                </li>
              </ul>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

export function newStepId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ── helpers ──────────────────────────────────────────────────────────────────

const STEP_TYPE_LABELS: Record<StepType, string> = {
  agent: '🤖 Agent',
  transform: '⚙️ Transform',
  condition: '🔀 Condition',
  http: '🌐 HTTP',
  multi_source: '📡 多源采集',
  debate: '⚔️ 对抗辩论',
  decision: '🧭 决策生成',
  risk_review: '🛡️ 风险审核',
  adjudication: '🏛️ 裁定',
};

const STEP_TYPE_LABELS_EN: Record<StepType, string> = {
  agent: '🤖 Agent',
  transform: '⚙️ Transform',
  condition: '🔀 Condition',
  http: '🌐 HTTP',
  multi_source: '📡 Multi-source',
  debate: '⚔️ Debate',
  decision: '🧭 Decision',
  risk_review: '🛡️ Risk Review',
  adjudication: '🏛️ Adjudication',
};

function getStepTypeLabel(type: StepType, locale: Locale): string {
  return locale === 'zh' ? STEP_TYPE_LABELS[type] : STEP_TYPE_LABELS_EN[type];
}

const STEP_TYPE_HELP_EN: Record<
  StepType,
  {
    summary: string;
    tip: string;
  }
> = {
  agent: {
    summary: 'Best for single-step execution, content generation, tool calls, or the first hop after human input.',
    tip: 'Pick an agent first, then decide whether you need JSON or Markdown constraints.',
  },
  transform: {
    summary: 'Best for lightweight text cleanup, field composition, and format bridging without another model call.',
    tip: 'Keep it focused on small expression transforms rather than complex business logic.',
  },
  condition: {
    summary: 'Best for branching the workflow into different handling paths. The first matching rule wins.',
    tip: 'Write the strictest condition first, then add the fallback branch.',
  },
  http: {
    summary: 'Best for calling external APIs, webhooks, or internal services and passing the response downstream.',
    tip: 'If you need field extraction, prefer JSON responses.',
  },
  multi_source: {
    summary: 'Best for parallel collection across multiple dimensions, then merging through a coordinator into one structured result.',
    tip: 'Configure at least one participant agent and define clear collection dimensions.',
  },
  debate: {
    summary: 'Best for multi-agent pro/con debate around the same topic before a coordinator converges the result.',
    tip: 'Configure at least two participant agents and define explicit opposing stances.',
  },
  decision: {
    summary: 'Best for generating actionable decisions with direction, priority, and dependencies from supporting analysis.',
    tip: 'Structured output templates make it easier for downstream condition or deliverable nodes to consume.',
  },
  risk_review: {
    summary: 'Best for parallel review of major risks, veto conditions, and remediation suggestions before execution.',
    tip: 'Assign different participant agents to different risk dimensions.',
  },
  adjudication: {
    summary: 'Best for final arbitration after multiple opinions, with clear ownership and execution milestones.',
    tip: 'Use it as the final step in a decision flow and output verdict, owner, and milestones together.',
  },
};

function getStepTypeHelp(type: StepType, locale: Locale): { summary: string; tip: string } {
  return locale === 'zh' ? STEP_TYPE_HELP[type] : STEP_TYPE_HELP_EN[type];
}

const STEP_TYPE_COLORS: Record<StepType, string> = {
  agent: 'bg-indigo-600/20 ring-indigo-500/40 text-indigo-300',
  transform: 'bg-amber-600/20 ring-amber-500/40 text-amber-300',
  condition: 'bg-purple-600/20 ring-purple-500/40 text-purple-300',
  http: 'bg-emerald-600/20 ring-emerald-500/40 text-emerald-300',
  multi_source: 'bg-cyan-600/20 ring-cyan-500/40 text-cyan-300',
  debate: 'bg-rose-600/20 ring-rose-500/40 text-rose-300',
  decision: 'bg-sky-600/20 ring-sky-500/40 text-sky-300',
  risk_review: 'bg-orange-600/20 ring-orange-500/40 text-orange-300',
  adjudication: 'bg-fuchsia-600/20 ring-fuchsia-500/40 text-fuchsia-300',
};

const STEP_TYPE_HELP: Record<
  StepType,
  {
    summary: string;
    tip: string;
  }
> = {
  agent: {
    summary: '适合单点执行、生成内容、调用工具或承接人工输入后的第一跳。',
    tip: '先选 agent，再决定是否需要 JSON/Markdown 约束。',
  },
  transform: {
    summary: '适合轻量文本整理、字段拼装、上下游格式桥接，不消耗额外模型调用。',
    tip: '推荐只做小范围表达式转换，不承担复杂业务逻辑。',
  },
  condition: {
    summary: '适合把流程分叉成不同处理路径，按分支顺序命中第一条规则。',
    tip: '先写最严格的条件，再写兜底分支。',
  },
  http: {
    summary: '适合调用外部 API、Webhook 或内部服务，把响应交给后续节点消费。',
    tip: '需要字段提取时，建议让接口返回 JSON。',
  },
  multi_source: {
    summary: '适合并行采集多维信息，再由协调 agent 统一汇总成一个结构化结论。',
    tip: '至少配置 1 个参与 agent，并给出清晰的采集维度。',
  },
  debate: {
    summary: '适合让多个 agent 围绕同一议题进行正反对抗，再由协调 agent 收敛结论。',
    tip: '至少配置 2 个参与 agent，并明确对立立场。',
  },
  decision: {
    summary: '适合结合补充分析视角生成可执行决策，输出方向、优先级和依赖。',
    tip: '建议同时配置结构化模板，便于下游 condition 或 deliverable 直接消费。',
  },
  risk_review: {
    summary: '适合在执行前并行识别主要风险、否决项和整改建议。',
    tip: '建议让不同参与 agent 各自盯一类风险维度。',
  },
  adjudication: {
    summary: '适合在多方意见之后最终拍板，明确责任归属与后续落地节奏。',
    tip: '适合作为决策流最后一跳，统一输出 verdict、owner、milestones。',
  },
};

function isSuperStepType(type: StepType): boolean {
  return (
    type === 'multi_source' ||
    type === 'debate' ||
    type === 'decision' ||
    type === 'risk_review' ||
    type === 'adjudication'
  );
}

function parseMultilineItems(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toMultilineItems(values: string[] | undefined): string {
  return (values ?? []).join('\n');
}

function superStepMessageLabel(type: StepType, locale: Locale = 'zh'): string {
  switch (type) {
    case 'multi_source':
      return locale === 'zh' ? '采集任务说明' : 'Collection Task';
    case 'debate':
      return locale === 'zh' ? '辩题 / 对抗议题' : 'Debate Topic';
    case 'decision':
      return locale === 'zh' ? '决策任务说明' : 'Decision Task';
    case 'risk_review':
      return locale === 'zh' ? '待审方案 / 审核任务' : 'Review Target';
    case 'adjudication':
      return locale === 'zh' ? '待裁定事项' : 'Adjudication Target';
    case 'http':
      return locale === 'zh' ? '请求体模板 (bodyTemplate)' : 'Request Body Template (bodyTemplate)';
    default:
      return locale === 'zh' ? '消息模板' : 'Message Template';
  }
}

function superStepPromptLabel(type: StepType, locale: Locale = 'zh'): string {
  switch (type) {
    case 'multi_source':
      return locale === 'zh' ? '采集维度（每行一个）' : 'Collection Dimensions (one per line)';
    case 'debate':
      return locale === 'zh' ? '对立立场（每行一个）' : 'Opposing Stances (one per line)';
    case 'decision':
      return locale === 'zh' ? '补充视角（每行一个，可选）' : 'Additional Perspectives (one per line, optional)';
    case 'risk_review':
      return locale === 'zh' ? '审核视角（每行一个）' : 'Review Perspectives (one per line)';
    case 'adjudication':
      return locale === 'zh' ? '参考视角（每行一个，可选）' : 'Reference Perspectives (one per line, optional)';
    default:
      return locale === 'zh' ? '视角提示' : 'Prompt Hints';
  }
}

function superStepParticipantHint(type: StepType, locale: Locale = 'zh'): string {
  switch (type) {
    case 'multi_source':
      return locale === 'zh' ? '并行采集 agent，至少选择 1 个。' : 'Parallel collection agents. Select at least 1.';
    case 'debate':
      return locale === 'zh' ? '对立辩论 agent，至少选择 2 个。' : 'Opposing debate agents. Select at least 2.';
    case 'decision':
      return locale === 'zh' ? '可选的并行补充分析 agent。' : 'Optional parallel supporting analysis agents.';
    case 'risk_review':
      return locale === 'zh' ? '并行风险审核 agent，至少选择 1 个。' : 'Parallel risk review agents. Select at least 1.';
    case 'adjudication':
      return locale === 'zh' ? '可选的并行参考分析 agent。' : 'Optional parallel reference analysis agents.';
    default:
      return '';
  }
}

function superStepStructuredPresetLabel(type: StepType): string {
  switch (type) {
    case 'multi_source':
      return '行业信息整合包';
    case 'debate':
      return '对抗辩论纪要';
    case 'decision':
      return '结构化决策方案';
    case 'risk_review':
      return '风险审核报告';
    case 'adjudication':
      return '最终执行方案';
    default:
      return '结构化输出';
  }
}

function buildSuperStepStructuredPreset(type: StepType): {
  outputFormat: 'json';
  outputFormatMode: 'prepend';
  outputFormatPrompt: string;
  outputs: StepOutputVar[];
} | null {
  switch (type) {
    case 'multi_source':
      return {
        outputFormat: 'json',
        outputFormatMode: 'prepend',
        outputFormatPrompt:
          [
            '请严格输出合法 JSON，不要输出 Markdown、解释文字或代码块。',
            'JSON 结构固定为：',
            '{',
            '  "coreData": string[],',
            '  "signals": string[],',
            '  "anomalies": string[],',
            '  "synthesis": string,',
            '  "recommendedActions": string[]',
            '}',
          ].join('\n'),
        outputs: [
          { name: 'coreData', jsonPath: '$.coreData' },
          { name: 'signals', jsonPath: '$.signals' },
          { name: 'anomalies', jsonPath: '$.anomalies' },
          { name: 'synthesis', jsonPath: '$.synthesis' },
          { name: 'recommendedActions', jsonPath: '$.recommendedActions' },
        ],
      };
    case 'debate':
      return {
        outputFormat: 'json',
        outputFormatMode: 'prepend',
        outputFormatPrompt:
          [
            '请严格输出合法 JSON，不要输出 Markdown、解释文字或代码块。',
            'JSON 结构固定为：',
            '{',
            '  "coreClaims": string[],',
            '  "disagreements": string[],',
            '  "consensus": string[],',
            '  "evidenceGaps": string[],',
            '  "moderatorSummary": string',
            '}',
          ].join('\n'),
        outputs: [
          { name: 'coreClaims', jsonPath: '$.coreClaims' },
          { name: 'disagreements', jsonPath: '$.disagreements' },
          { name: 'consensus', jsonPath: '$.consensus' },
          { name: 'evidenceGaps', jsonPath: '$.evidenceGaps' },
          { name: 'moderatorSummary', jsonPath: '$.moderatorSummary' },
        ],
      };
    case 'decision':
      return {
        outputFormat: 'json',
        outputFormatMode: 'prepend',
        outputFormatPrompt:
          [
            '请严格输出合法 JSON，不要输出 Markdown、解释文字或代码块。',
            'JSON 结构固定为：',
            '{',
            '  "direction": string,',
            '  "priority": string,',
            '  "executionSteps": string[],',
            '  "dependencies": string[],',
            '  "confidence": string,',
            '  "rationale": string',
            '}',
          ].join('\n'),
        outputs: [
          { name: 'direction', jsonPath: '$.direction' },
          { name: 'priority', jsonPath: '$.priority' },
          { name: 'executionSteps', jsonPath: '$.executionSteps' },
          { name: 'dependencies', jsonPath: '$.dependencies' },
          { name: 'confidence', jsonPath: '$.confidence' },
          { name: 'rationale', jsonPath: '$.rationale' },
        ],
      };
    case 'risk_review':
      return {
        outputFormat: 'json',
        outputFormatMode: 'prepend',
        outputFormatPrompt:
          [
            '请严格输出合法 JSON，不要输出 Markdown、解释文字或代码块。',
            'JSON 结构固定为：',
            '{',
            '  "riskLevel": string,',
            '  "majorRisks": string[],',
            '  "mitigations": string[],',
            '  "vetoItems": string[],',
            '  "proceedRecommendation": string',
            '}',
          ].join('\n'),
        outputs: [
          { name: 'riskLevel', jsonPath: '$.riskLevel' },
          { name: 'majorRisks', jsonPath: '$.majorRisks' },
          { name: 'mitigations', jsonPath: '$.mitigations' },
          { name: 'vetoItems', jsonPath: '$.vetoItems' },
          { name: 'proceedRecommendation', jsonPath: '$.proceedRecommendation' },
        ],
      };
    case 'adjudication':
      return {
        outputFormat: 'json',
        outputFormatMode: 'prepend',
        outputFormatPrompt:
          [
            '请严格输出合法 JSON，不要输出 Markdown、解释文字或代码块。',
            'JSON 结构固定为：',
            '{',
            '  "verdict": string,',
            '  "owner": string,',
            '  "milestones": string[],',
            '  "watchItems": string[],',
            '  "decisionMemo": string',
            '}',
          ].join('\n'),
        outputs: [
          { name: 'verdict', jsonPath: '$.verdict' },
          { name: 'owner', jsonPath: '$.owner' },
          { name: 'milestones', jsonPath: '$.milestones' },
          { name: 'watchItems', jsonPath: '$.watchItems' },
          { name: 'decisionMemo', jsonPath: '$.decisionMemo' },
        ],
      };
    default:
      return null;
  }
}

function createDefaultStep(type: StepType = 'agent', messageTemplate = '{{prev_output}}'): WorkflowStep {
  return {
    id: newStepId(),
    type,
    agentId: type === 'agent' || isSuperStepType(type) ? '' : undefined,
    messageTemplate,
    condition: 'any',
  };
}

function cloneStepForDuplicate(step: WorkflowStep): WorkflowStep {
  return {
    ...step,
    id: newStepId(),
    label: step.label ? `${step.label} 副本` : undefined,
    nextStepId: undefined,
    outputs: step.outputs?.map((output) => ({ ...output })),
    branches: step.branches?.map((branch) => ({ ...branch })),
    participantAgentIds: step.participantAgentIds ? [...step.participantAgentIds] : undefined,
    superNodePrompts: step.superNodePrompts ? [...step.superNodePrompts] : undefined,
  };
}

type StepReadinessPill = {
  label: string;
  tone: 'neutral' | 'good' | 'warn';
};

type StepCompletionMetrics = {
  completed: number;
  total: number;
  percent: number;
  issueCount: number;
};

function buildStepReadinessPills(step: WorkflowStep, locale: Locale = 'zh'): StepReadinessPill[] {
  const type = step.type ?? 'agent';
  const pills: StepReadinessPill[] = [];
  const text =
    locale === 'zh'
      ? {
          coordinatorReady: '已选协调者',
          coordinatorMissing: '待选协调者',
          participants: '参与者',
          participantsMissing: '待配参与者',
          prompts: '视角',
          promptsMissing: '待写视角',
          branches: '分支',
          branchesMissing: '待配分支',
          httpConfigured: '已配置',
          urlMissing: '待填 URL',
          expressionReady: '表达式已填写',
          expressionMissing: '待写表达式',
          taskReady: '任务说明已填写',
          taskMissing: '待写任务说明',
          output: '输出',
          vars: '变量',
          retries: '重试',
        }
      : {
          coordinatorReady: 'Coordinator set',
          coordinatorMissing: 'Coordinator needed',
          participants: 'Participants',
          participantsMissing: 'Participants needed',
          prompts: 'Prompts',
          promptsMissing: 'Prompts needed',
          branches: 'Branches',
          branchesMissing: 'Branches needed',
          httpConfigured: 'configured',
          urlMissing: 'URL needed',
          expressionReady: 'Expression ready',
          expressionMissing: 'Expression needed',
          taskReady: 'Task ready',
          taskMissing: 'Task needed',
          output: 'Output',
          vars: 'Vars',
          retries: 'Retries',
        };

  if (type === 'agent' || isSuperStepType(type)) {
    pills.push({
      label: step.agentId?.trim() ? text.coordinatorReady : text.coordinatorMissing,
      tone: step.agentId?.trim() ? 'good' : 'warn',
    });
  }

  if (isSuperStepType(type)) {
    const participantCount = step.participantAgentIds?.length ?? 0;
    const promptCount = step.superNodePrompts?.length ?? 0;
    pills.push({
      label: participantCount > 0 ? `${text.participants} ${participantCount}` : text.participantsMissing,
      tone: participantCount > 0 ? 'good' : 'warn',
    });
    pills.push({
      label: promptCount > 0 ? `${text.prompts} ${promptCount}` : text.promptsMissing,
      tone: promptCount > 0 ? 'good' : 'warn',
    });
  }

  if (type === 'condition') {
    const branchCount = step.branches?.length ?? 0;
    pills.push({
      label: branchCount > 0 ? `${text.branches} ${branchCount}` : text.branchesMissing,
      tone: branchCount > 0 ? 'good' : 'warn',
    });
  }

  if (type === 'http') {
    pills.push({
      label: step.url?.trim() ? `${step.method ?? 'GET'} ${text.httpConfigured}` : text.urlMissing,
      tone: step.url?.trim() ? 'good' : 'warn',
    });
  }

  if (type === 'transform') {
    pills.push({
      label: step.transformCode?.trim() || step.messageTemplate.trim() ? text.expressionReady : text.expressionMissing,
      tone: step.transformCode?.trim() || step.messageTemplate.trim() ? 'good' : 'warn',
    });
  }

  if (type !== 'condition') {
    pills.push({
      label: step.messageTemplate.trim() ? text.taskReady : text.taskMissing,
      tone: step.messageTemplate.trim() ? 'good' : 'warn',
    });
  }

  if (step.outputFormat) {
    pills.push({
      label: `${text.output}:${step.outputFormat}`,
      tone: 'neutral',
    });
  }

  if ((step.outputs?.length ?? 0) > 0) {
    pills.push({
      label: `${text.vars} ${step.outputs?.length ?? 0}`,
      tone: 'neutral',
    });
  }

  if ((step.maxRetries ?? 0) > 0) {
    pills.push({
      label: `${text.retries} ${step.maxRetries}`,
      tone: 'neutral',
    });
  }

  return pills;
}

function buildStepCompletionMetrics(step: WorkflowStep, issues: string[], locale: Locale = 'zh'): StepCompletionMetrics {
  const pills = buildStepReadinessPills(step, locale);
  const completed = pills.filter((pill) => pill.tone !== 'warn').length;
  const total = pills.length || 1;
  return {
    completed,
    total,
    percent: Math.round((completed / total) * 100),
    issueCount: issues.length,
  };
}

function completionTone(percent: number, issueCount: number): string {
  if (issueCount > 0) {
    return 'text-red-200 bg-red-500/10 ring-red-500/25';
  }
  if (percent >= 80) {
    return 'text-emerald-200 bg-emerald-500/10 ring-emerald-500/25';
  }
  if (percent >= 50) {
    return 'text-amber-200 bg-amber-500/10 ring-amber-500/25';
  }
  return 'text-slate-300 bg-slate-800/70 ring-slate-700/60';
}

type WorkflowStarter = {
  id: string;
  category?: string;
  title: string;
  summary: string;
  steps: WorkflowStep[];
  suggestedName: string;
  suggestedDescription: string;
};

function withStructuredPreset(step: WorkflowStep): WorkflowStep {
  const type = step.type ?? 'agent';
  if (!isSuperStepType(type)) {
    return step;
  }
  const preset = buildSuperStepStructuredPreset(type);
  if (!preset) {
    return step;
  }
  return {
    ...step,
    outputFormat: preset.outputFormat,
    outputFormatMode: preset.outputFormatMode,
    outputFormatPrompt: preset.outputFormatPrompt,
    outputs: preset.outputs,
  };
}

function buildWorkflowStarters(): WorkflowStarter[] {
  const blankAgent = createDefaultStep('agent', '{{input}}');
  blankAgent.label = '起始节点';

  const multiSource = createDefaultStep('multi_source', '{{input}}');
  multiSource.label = '情报采集';
  multiSource.superNodePrompts = ['市场动向', '竞品动作', '用户反馈'];
  multiSource.domainRules = '优先使用最近资料；列出明显冲突信息。';

  const decision = createDefaultStep('decision', '{{prev_output}}');
  decision.label = '决策生成';
  decision.superNodePrompts = ['商业收益', '执行成本'];

  const riskReview = createDefaultStep('risk_review', '{{prev_output}}');
  riskReview.label = '风险审核';
  riskReview.superNodePrompts = ['合规风险', '交付风险'];

  const adjudication = createDefaultStep('adjudication', '{{prev_output}}');
  adjudication.label = '最终裁定';
  adjudication.superNodePrompts = ['负责人视角', '落地节奏'];

  const debate = createDefaultStep('debate', '{{input}}');
  debate.label = '对抗辩论';
  debate.superNodePrompts = ['支持推进', '反对推进'];

  const debateDecision = createDefaultStep('decision', '{{prev_output}}');
  debateDecision.label = '辩后决策';

  const debateRisk = createDefaultStep('risk_review', '{{prev_output}}');
  debateRisk.label = '辩后风控';
  debateRisk.superNodePrompts = ['法律与合规', '资源与时程'];

  const chainMultiSource = createDefaultStep('multi_source', '{{input}}');
  chainMultiSource.label = '多源采集';
  chainMultiSource.superNodePrompts = ['市场情报', '竞品动态', '用户信号'];
  chainMultiSource.domainRules = '优先引用最近资料，保留相互冲突的证据。';

  const chainDebate = createDefaultStep('debate', '{{prev_output}}');
  chainDebate.label = '多维对抗辩论';
  chainDebate.superNodePrompts = ['支持推进', '反对推进', '中立质询'];
  chainDebate.domainRules = '必须互相回应论点，不允许只重复自身立场。';

  const chainDecision = createDefaultStep('decision', '{{prev_output}}');
  chainDecision.label = '决策生成';
  chainDecision.superNodePrompts = ['增长收益', '执行成本', '组织牵引'];
  chainDecision.domainRules = '必须给出优先级、依赖和最小可执行方案。';

  const chainRiskReview = createDefaultStep('risk_review', '{{prev_output}}');
  chainRiskReview.label = '风险审核';
  chainRiskReview.superNodePrompts = ['合规风险', '交付风险', '资源风险'];
  chainRiskReview.domainRules = '高风险项必须附整改建议和否决条件。';

  const chainAdjudication = createDefaultStep('adjudication', '{{prev_output}}');
  chainAdjudication.label = '最终裁定';
  chainAdjudication.superNodePrompts = ['责任归属', '里程碑安排'];
  chainAdjudication.domainRules = '必须明确 owner、milestones 和后续观察项。';

  const agentDraft = createDefaultStep('agent', '{{input}}');
  agentDraft.label = '初稿生成';

  const polish = createDefaultStep('transform', 'prev_output');
  polish.label = '结果整理';
  polish.transformCode = 'prev_output';
  polish.messageTemplate = 'prev_output';

  const gate = createDefaultStep('condition', '{{prev_output}}');
  gate.label = '是否结束';
  gate.branches = [
    { expression: "output.includes('完成')", goto: '$end' },
    { expression: 'output.length > 0', goto: '$end' },
  ];

  return [
    {
      id: 'blank-scene',
      category: '空白起步',
      title: '空白场景模板',
      summary: '仅保留一个空白起始节点，适合完全从零搭建',
      suggestedName: '未命名工作流',
      suggestedDescription: '从空白场景开始，自由拼接所需节点。',
      steps: [blankAgent],
    },
    {
      id: 'full-super-chain',
      category: '完整链路',
      title: '超级节点全链路模板',
      summary: '多源采集 → 多维对抗辩论 → 决策生成 → 风险审核 → 最终裁定',
      suggestedName: '超级节点全链路工作流',
      suggestedDescription: '适合从信息采集一路推进到辩论、决策、风控与最终拍板。',
      steps: [
        withStructuredPreset(chainMultiSource),
        withStructuredPreset(chainDebate),
        withStructuredPreset(chainDecision),
        withStructuredPreset(chainRiskReview),
        withStructuredPreset(chainAdjudication),
      ],
    },
    {
      id: 'intel-decision',
      category: '快速上手',
      title: '情报研判流',
      summary: '多源采集 → 决策生成 → 风险审核 → 最终裁定',
      suggestedName: '情报研判工作流',
      suggestedDescription: '适合从资料采集一路推进到决策与拍板。',
      steps: [
        withStructuredPreset(multiSource),
        withStructuredPreset(decision),
        withStructuredPreset(riskReview),
        withStructuredPreset(adjudication),
      ],
    },
    {
      id: 'debate-review',
      category: '快速上手',
      title: '对抗评审流',
      summary: '对抗辩论 → 决策生成 → 风险审核',
      suggestedName: '对抗评审工作流',
      suggestedDescription: '适合多方意见冲突、需要先辩论再给结论。',
      steps: [
        withStructuredPreset(debate),
        withStructuredPreset(debateDecision),
        withStructuredPreset(debateRisk),
      ],
    },
    {
      id: 'quick-pilot',
      category: '快速上手',
      title: '快速试跑流',
      summary: 'Agent 起草 → Transform 整理 → Condition 收尾',
      suggestedName: '快速试跑工作流',
      suggestedDescription: '适合先验证链路，再逐步替换成超级节点。',
      steps: [agentDraft, polish, gate],
    },
  ];
}

type SuperStepExperiencePreset = {
  id: string;
  title: string;
  summary: string;
  patch: Partial<WorkflowStep>;
};

function buildSuperStepExperiencePresets(type: StepType): SuperStepExperiencePreset[] {
  switch (type) {
    case 'multi_source':
      return [
        {
          id: 'market-scan',
          title: '市场扫描',
          summary: '适合做行业动态、竞品动作和用户反馈并行采集。',
          patch: {
            label: '市场扫描',
            messageTemplate: '{{input}}',
            superNodePrompts: ['行业动态', '竞品动作', '用户反馈'],
            domainRules: '优先使用最近30天信息；保留明显冲突数据。',
          },
        },
        {
          id: 'project-intel',
          title: '项目尽调',
          summary: '适合拉齐商业、技术、交付多维线索。',
          patch: {
            label: '项目尽调',
            messageTemplate: '{{input}}',
            superNodePrompts: ['商业前景', '技术可行性', '交付约束'],
            domainRules: '结论必须标注证据来源和不确定性。',
          },
        },
      ];
    case 'debate':
      return [
        {
          id: 'go-no-go',
          title: '是否推进',
          summary: '适合对一个方案做推进与反对的正面对抗。',
          patch: {
            label: '是否推进',
            messageTemplate: '{{input}}',
            superNodePrompts: ['支持推进', '反对推进'],
            domainRules: '必须指出对方论证中的漏洞，不要重复自己的观点。',
          },
        },
        {
          id: 'plan-a-b',
          title: '方案对抗',
          summary: '适合两个候选方案的优劣辩论。',
          patch: {
            label: '方案对抗',
            messageTemplate: '{{input}}',
            superNodePrompts: ['支持方案A', '支持方案B'],
            domainRules: '必须比较成本、速度、风险，不允许空泛评价。',
          },
        },
      ];
    case 'decision':
      return [
        {
          id: 'business-decision',
          title: '经营决策',
          summary: '适合输出推进方向、优先级、依赖与依据。',
          patch: {
            label: '经营决策',
            messageTemplate: '{{prev_output}}',
            superNodePrompts: ['增长收益', '执行成本'],
            domainRules: '优先给出最小可执行方案，并标明主要依赖。',
          },
        },
        {
          id: 'product-choice',
          title: '产品路线',
          summary: '适合在多个路线中选出优先方向。',
          patch: {
            label: '产品路线',
            messageTemplate: '{{prev_output}}',
            superNodePrompts: ['用户价值', '工程复杂度'],
            domainRules: '必须给出不选其他路线的理由。',
          },
        },
      ];
    case 'risk_review':
      return [
        {
          id: 'launch-audit',
          title: '上线前审核',
          summary: '适合在执行前做合规、质量和资源风险排查。',
          patch: {
            label: '上线前审核',
            messageTemplate: '{{prev_output}}',
            superNodePrompts: ['合规风险', '质量风险', '资源风险'],
            domainRules: '高风险项必须附整改建议和否决条件。',
          },
        },
        {
          id: 'investment-risk',
          title: '投资风控',
          summary: '适合做项目或客户合作前的风控审查。',
          patch: {
            label: '投资风控',
            messageTemplate: '{{prev_output}}',
            superNodePrompts: ['财务风险', '法务风险', '履约风险'],
            domainRules: '必须区分可缓解风险与直接否决项。',
          },
        },
      ];
    case 'adjudication':
      return [
        {
          id: 'final-call',
          title: '最终拍板',
          summary: '适合形成最终 verdict、owner 和 milestones。',
          patch: {
            label: '最终拍板',
            messageTemplate: '{{prev_output}}',
            superNodePrompts: ['负责人视角', '落地节奏'],
            domainRules: '必须明确负责人、时间点和继续观察项。',
          },
        },
        {
          id: 'meeting-ruling',
          title: '会议裁定',
          summary: '适合对会议结论进行定责和排期。',
          patch: {
            label: '会议裁定',
            messageTemplate: '{{prev_output}}',
            superNodePrompts: ['责任归属', '里程碑安排'],
            domainRules: '必须明确谁拍板、谁执行、何时复盘。',
          },
        },
      ];
    default:
      return [];
  }
}

function summarizeStepPreview(step: WorkflowStep, allSteps: WorkflowStep[], locale: Locale): string[] {
  const type = step.type ?? 'agent';
  const lines: string[] = [];
  const text =
    locale === 'zh'
      ? {
          task: '任务',
          participants: '参与者',
          prompts: '视角',
          branchCount: '分支数',
          request: '请求',
          missingUrl: '未填写 URL',
          outputs: '输出变量',
          next: '显式下一步',
          endFlow: '结束流程',
        }
      : {
          task: 'Task',
          participants: 'Participants',
          prompts: 'Prompts',
          branchCount: 'Branches',
          request: 'Request',
          missingUrl: 'URL missing',
          outputs: 'Outputs',
          next: 'Next',
          endFlow: 'End Flow',
        };

  if (step.messageTemplate.trim()) {
    lines.push(`${text.task}: ${step.messageTemplate.trim().replace(/\s+/g, ' ').slice(0, 88)}`);
  }
  if (isSuperStepType(type)) {
    lines.push(`${text.participants}: ${step.participantAgentIds?.length ?? 0} | ${text.prompts}: ${step.superNodePrompts?.length ?? 0}`);
  }
  if (type === 'condition') {
    lines.push(`${text.branchCount}: ${step.branches?.length ?? 0}`);
  }
  if (type === 'http') {
    lines.push(`${text.request}: ${step.method ?? 'GET'} ${step.url ?? text.missingUrl}`);
  }
  if ((step.outputs?.length ?? 0) > 0) {
    lines.push(`${text.outputs}: ${step.outputs?.map((item) => item.name).filter(Boolean).join(', ')}`);
  }
  if (step.nextStepId) {
    const nextStep = allSteps.find((candidate) => candidate.id === step.nextStepId);
    lines.push(`${text.next}: ${step.nextStepId === '$end' ? text.endFlow : nextStep?.label ?? step.nextStepId}`);
  }

  return lines.slice(0, 4);
}

function formatWorkflowStepOptionLabel(step: WorkflowStep, locale: Locale): string {
  return step.label
    ? `${step.label}【${step.id}】`
    : `${getStepTypeLabel(step.type ?? 'agent', locale)}【${step.id}】`;
}

function normalizeStepForType(step: WorkflowStep, nextType: StepType): WorkflowStep {
  if (nextType === 'condition') {
    return { ...step, type: nextType };
  }
  const { branches, ...rest } = step;
  return { ...rest, type: nextType };
}

const inputCls =
  'rounded-lg bg-slate-900/70 ring-1 ring-slate-700 px-2 py-1.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-indigo-500';

function describeGraphDiagnostic(diagnostic: WorkflowGraphDiagnostic, locale: Locale = 'zh'): string {
  if (diagnostic.kind === 'cycle') {
    return locale === 'zh'
      ? `检测到循环路径：${diagnostic.path.join(' → ')}`
      : `Cycle detected: ${diagnostic.path.join(' → ')}`;
  }
  return locale === 'zh'
    ? `存在不可达步骤：${diagnostic.stepIds.join(', ')}`
    : `Unreachable steps: ${diagnostic.stepIds.join(', ')}`;
}

function getDiagnosticStepIds(
  diagnostic: WorkflowGraphDiagnostic | WorkflowValidationDiagnostic,
): string[] {
  if (diagnostic.kind === 'cycle') {
    return Array.from(new Set(diagnostic.path));
  }
  if (diagnostic.kind === 'unreachable') {
    return diagnostic.stepIds;
  }
  if (diagnostic.kind === 'step-validation' || diagnostic.kind === 'step-advisory') {
    return [diagnostic.stepId];
  }
  return [];
}

function collectStepIssueMap(
  diagnosis: WorkflowDiagnoseResult | null,
  locale: Locale = 'zh',
): Record<string, string[]> {
  if (!diagnosis) return {};
  const issueMap: Record<string, string[]> = {};
  const addIssue = (stepId: string, message: string) => {
    if (!issueMap[stepId]) {
      issueMap[stepId] = [];
    }
    if (!issueMap[stepId]?.includes(message)) {
      issueMap[stepId]?.push(message);
    }
  };

  for (const diagnostic of diagnosis.validationDiagnostics) {
    if (diagnostic.kind === 'step-validation' || diagnostic.kind === 'step-advisory') {
      addIssue(diagnostic.stepId, diagnostic.message);
    }
  }

  for (const diagnostic of diagnosis.graphDiagnostics) {
    const summary = describeGraphDiagnostic(diagnostic, locale);
    for (const stepId of getDiagnosticStepIds(diagnostic)) {
      addIssue(stepId, summary);
    }
  }

  return issueMap;
}

function collectWorkflowIssueMessages(diagnosis: WorkflowDiagnoseResult | null): string[] {
  if (!diagnosis) return [];
  return diagnosis.validationDiagnostics
    .filter(
      (
        diagnostic,
      ): diagnostic is Extract<
        WorkflowValidationDiagnostic,
        { kind: 'workflow-validation' | 'workflow-advisory' }
      > => diagnostic.kind === 'workflow-validation' || diagnostic.kind === 'workflow-advisory',
    )
    .map((diagnostic) => diagnostic.message);
}

function getFirstIssueStepId(diagnosis: WorkflowDiagnoseResult | null): string | null {
  if (!diagnosis) return null;
  for (const diagnostic of diagnosis.validationDiagnostics) {
    if (diagnostic.kind === 'step-validation' || diagnostic.kind === 'step-advisory') {
      return diagnostic.stepId;
    }
  }
  for (const diagnostic of diagnosis.graphDiagnostics) {
    const stepId = getDiagnosticStepIds(diagnostic)[0];
    if (stepId) {
      return stepId;
    }
  }
  return null;
}

function scrollToWorkflowStep(stepId: string): void {
  window.requestAnimationFrame(() => {
    document.getElementById(`workflow-step-${stepId}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  });
}

// ── ConditionBranchList ───────────────────────────────────────────────────────

function ConditionBranchList({
  branches,
  steps,
  onChange,
}: {
  branches: ConditionBranch[];
  steps: WorkflowStep[];
  onChange: (b: ConditionBranch[]) => void;
}) {
  const { locale } = useLocale();
  const branchEditorText =
    locale === 'zh'
      ? {
          title: '分支条件',
          addBranch: '+ 添加分支',
          targetPlaceholder: '— 选择目标 —',
          endFlow: '结束流程',
          expressionPlaceholder: "output.includes('yes')",
        }
      : {
          title: 'Branch Conditions',
          addBranch: '+ Add Branch',
          targetPlaceholder: '— Select Target —',
          endFlow: 'End Flow',
          expressionPlaceholder: "output.includes('yes')",
        };
  const updateBranch = (i: number, b: ConditionBranch) =>
    onChange(branches.map((x, j) => (j === i ? b : x)));
  const removeBranch = (i: number) => onChange(branches.filter((_, j) => j !== i));
  const addBranch = () =>
    onChange([...branches, { expression: 'output.includes("yes")', goto: '' }]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-400">{branchEditorText.title}</span>
        <button onClick={addBranch} className="text-xs text-indigo-400 hover:text-indigo-300">
          {branchEditorText.addBranch}
        </button>
      </div>
      {branches.map((b, i) => (
        <div key={i} className="grid grid-cols-[1fr_auto_auto] gap-2 items-start">
          <textarea
            rows={1}
            className={`${inputCls} font-mono text-xs resize-none`}
            placeholder={branchEditorText.expressionPlaceholder}
            value={b.expression}
            onChange={(e) => updateBranch(i, { ...b, expression: e.target.value })}
          />
          <div className="flex items-center gap-1">
            <span className="text-xs text-slate-500">→</span>
            <select
              className={`${inputCls} text-xs`}
              value={b.goto}
              onChange={(e) => updateBranch(i, { ...b, goto: e.target.value })}
            >
              <option value="">{branchEditorText.targetPlaceholder}</option>
              <option value="$end">$end ({branchEditorText.endFlow})</option>
              {steps.map((s) => (
                <option key={s.id} value={s.id}>
                  {formatWorkflowStepOptionLabel(s, locale)}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={() => removeBranch(i)}
            className="text-slate-600 hover:text-red-400 text-sm mt-0.5"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

// ── OutputVarList ─────────────────────────────────────────────────────────────

type VarMethod = 'jsonpath' | 'regex' | 'transform';
function getVarMethod(o: StepOutputVar): VarMethod {
  if (o.transform !== undefined) return 'transform';
  if (o.regex !== undefined) return 'regex';
  return 'jsonpath';
}

function OutputVarList({
  outputs,
  onChange,
}: {
  outputs: StepOutputVar[];
  onChange: (o: StepOutputVar[]) => void;
}) {
  const update = (i: number, o: StepOutputVar) =>
    onChange(outputs.map((x, j) => (j === i ? o : x)));
  const remove = (i: number) => onChange(outputs.filter((_, j) => j !== i));
  const add = () => onChange([...outputs, { name: '', jsonPath: '' }]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-400">命名输出变量</span>
        <button onClick={add} className="text-xs text-indigo-400 hover:text-indigo-300">
          + 添加变量
        </button>
      </div>
      {outputs.map((o, i) => {
        const method = getVarMethod(o);
        return (
          <div key={i} className="flex flex-col gap-1.5">
            <div className="grid grid-cols-[auto_1fr_auto_auto] gap-2 items-center text-xs">
              <span className="text-slate-500">名称</span>
              <input
                className={inputCls}
                placeholder="varName"
                value={o.name}
                onChange={(e) => update(i, { ...o, name: e.target.value })}
              />
              <select
                className={`${inputCls} text-xs`}
                value={method}
                onChange={(e) => {
                  const m = e.target.value as VarMethod;
                  if (m === 'jsonpath') update(i, { name: o.name, jsonPath: '' });
                  else if (m === 'regex') update(i, { name: o.name, regex: '' });
                  else update(i, { name: o.name, transform: '' });
                }}
              >
                <option value="jsonpath">JSONPath</option>
                <option value="regex">Regex</option>
                <option value="transform">Transform</option>
              </select>
              <button onClick={() => remove(i)} className="text-slate-600 hover:text-red-400">
                ✕
              </button>
            </div>
            {method === 'transform' ? (
              <textarea
                rows={2}
                className={`${inputCls} resize-none font-mono text-xs`}
                placeholder="output.match(/(\d+)/)?.[1] ?? ''"
                value={o.transform ?? ''}
                onChange={(e) => update(i, { name: o.name, transform: e.target.value })}
              />
            ) : (
              <input
                className={`${inputCls} font-mono text-xs`}
                placeholder={method === 'jsonpath' ? '$.field.path' : '/pattern(group)/'}
                value={method === 'jsonpath' ? (o.jsonPath ?? '') : (o.regex ?? '')}
                onChange={(e) => {
                  const v = e.target.value;
                  update(
                    i,
                    method === 'jsonpath'
                      ? { name: o.name, jsonPath: v }
                      : { name: o.name, regex: v },
                  );
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── StepRow ───────────────────────────────────────────────────────────────────

function StepRow({
  step,
  index,
  total,
  agents,
  allSteps,
  issues,
  selected,
  collapsed,
  onChange,
  onMoveUp,
  onMoveDown,
  onInsertBelow,
  onDuplicate,
  onRemove,
  onSelect,
  onToggleCollapse,
  showCollapseToggle = true,
}: {
  step: WorkflowStep;
  index: number;
  total: number;
  agents: AgentInfo[];
  allSteps: WorkflowStep[];
  issues: string[];
  selected: boolean;
  collapsed: boolean;
  onChange: (s: WorkflowStep) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onInsertBelow: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onSelect: () => void;
  onToggleCollapse: () => void;
  showCollapseToggle?: boolean;
}) {
  const { locale } = useLocale();
  const type: StepType = step.type ?? 'agent';
  const isSuperNode = isSuperStepType(type);
  const selectedAgent = step.agentId
    ? agents.find((agent) => agent.agentId === step.agentId)
    : undefined;
  const preferredAgent = getPreferredAgent(agents);
  const workflowAgentHint = type === 'agent' || isSuperNode ? getWorkflowAgentHint(step, agents, locale) : null;
  const stepHelp = getStepTypeHelp(type, locale);
  const readinessPills = buildStepReadinessPills(step, locale);
  const experiencePresets = isSuperNode ? buildSuperStepExperiencePresets(type) : [];
  const previewLines = summarizeStepPreview(step, allSteps, locale);
  const completion = buildStepCompletionMetrics(step, issues, locale);
  const recommendedAgents = isSuperNode ? rankSuperStepAgents(type, agents) : null;
  const rowText =
    locale === 'zh'
      ? {
          stepLabelPlaceholder: `Step label (ID: ${step.id})`,
          issueCount: `${issues.length} 个问题`,
          located: '已定位',
          locate: '定位',
          expand: '展开',
          collapse: '折叠',
          nodePurpose: '节点用途',
          completion: `完成度 ${completion.percent}%`,
          defaultNext: '默认顺延',
          endFlow: '结束流程',
        }
      : {
          stepLabelPlaceholder: `Step label (ID: ${step.id})`,
          issueCount: `${issues.length} issues`,
          located: 'Focused',
          locate: 'Locate',
          expand: 'Expand',
          collapse: 'Collapse',
          nodePurpose: 'Node Purpose',
          completion: `Completion ${completion.percent}%`,
          defaultNext: 'Default Next Step',
          endFlow: 'End Flow',
        };

  return (
    <div
      id={`workflow-step-${step.id}`}
      className={`rounded-xl p-4 flex flex-col gap-3 ring-1 transition-colors ${
        selected
          ? 'bg-indigo-500/10 ring-indigo-500/50'
          : issues.length > 0
            ? 'bg-red-500/5 ring-red-500/30'
            : 'bg-slate-800/70 ring-slate-700/60'
      }`}
    >
      {/* Header row */}
      <div className="flex items-center gap-2">
        <span className="w-6 h-6 rounded-full bg-indigo-600/30 ring-1 ring-indigo-500/40 text-indigo-300 text-xs flex items-center justify-center font-mono shrink-0">
          {index + 1}
        </span>

        {/* Step type selector */}
        <select
          className={`rounded-lg ring-1 px-2 py-1.5 text-xs font-medium focus:outline-none ${STEP_TYPE_COLORS[type]}`}
          value={type}
          onChange={(e) => onChange(normalizeStepForType(step, e.target.value as StepType))}
        >
          {(Object.keys(STEP_TYPE_LABELS) as StepType[]).map((t) => (
            <option key={t} value={t}>
              {getStepTypeLabel(t, locale)}
            </option>
          ))}
        </select>

        {/* Step label */}
        <input
          className={`${inputCls} flex-1`}
          placeholder={rowText.stepLabelPlaceholder}
          value={step.label ?? ''}
          onChange={(e) => onChange({ ...step, label: e.target.value || undefined })}
        />

        {issues.length > 0 && (
          <button
            type="button"
            onClick={onSelect}
            className="rounded-lg bg-red-500/10 ring-1 ring-red-500/30 px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/15"
            title={issues.join('\n')}
          >
            {rowText.issueCount}
          </button>
        )}

        <button
          type="button"
          onClick={onSelect}
          className={`rounded-lg px-2 py-1 text-[11px] ring-1 ${
            selected
              ? 'bg-indigo-500/20 ring-indigo-500/40 text-indigo-200'
              : 'bg-slate-900/50 ring-slate-700/60 text-slate-400 hover:text-slate-200'
          }`}
        >
          {selected ? rowText.located : rowText.locate}
        </button>

        {showCollapseToggle && (
          <button
            type="button"
            onClick={onToggleCollapse}
            className="rounded-lg px-2 py-1 text-[11px] ring-1 bg-slate-900/50 ring-slate-700/60 text-slate-400 hover:text-slate-200"
          >
            {collapsed ? rowText.expand : rowText.collapse}
          </button>
        )}

        {/* Move + remove */}
        <div className="flex gap-1 shrink-0">
          <button
            type="button"
            onClick={onInsertBelow}
            className="px-1.5 py-1 rounded text-slate-500 hover:text-indigo-300"
            title="在下方插入同类型步骤"
          >
            ＋
          </button>
          <button
            type="button"
            onClick={onDuplicate}
            className="px-1.5 py-1 rounded text-slate-500 hover:text-sky-300"
            title="复制当前步骤"
          >
            ⧉
          </button>
          <button
            disabled={index === 0}
            onClick={onMoveUp}
            className="px-1.5 py-1 rounded text-slate-500 hover:text-slate-300 disabled:opacity-30"
          >
            ▲
          </button>
          <button
            disabled={index === total - 1}
            onClick={onMoveDown}
            className="px-1.5 py-1 rounded text-slate-500 hover:text-slate-300 disabled:opacity-30"
          >
            ▼
          </button>
          <button
            onClick={onRemove}
            className="px-1.5 py-1 rounded text-slate-500 hover:text-red-400"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="rounded-lg bg-slate-900/35 ring-1 ring-slate-700/40 px-3 py-3 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">{rowText.nodePurpose}</span>
          <span className="text-xs text-slate-200">{stepHelp.summary}</span>
          <span
            className={`rounded-full px-2 py-1 text-[11px] ring-1 ${completionTone(completion.percent, completion.issueCount)}`}
          >
            {rowText.completion}
          </span>
        </div>
        <div className="text-[11px] text-slate-500">{stepHelp.tip}</div>
        <div className="flex flex-wrap gap-2">
          {readinessPills.map((pill) => (
            <span
              key={pill.label}
              className={`rounded-full px-2 py-1 text-[11px] ring-1 ${
                pill.tone === 'good'
                  ? 'bg-emerald-500/10 text-emerald-200 ring-emerald-500/25'
                  : pill.tone === 'warn'
                    ? 'bg-amber-500/10 text-amber-200 ring-amber-500/25'
                    : 'bg-slate-800/80 text-slate-300 ring-slate-700/60'
              }`}
            >
              {pill.label}
            </span>
          ))}
        </div>
        {collapsed && previewLines.length > 0 && (
          <div className="rounded-lg bg-slate-950/35 ring-1 ring-slate-800/50 px-3 py-2 flex flex-col gap-1">
            {previewLines.map((line) => (
              <div key={line} className="text-[11px] text-slate-400">
                {line}
              </div>
            ))}
          </div>
        )}
      </div>

      {collapsed ? null : (
        <>

      {/* Agent selector */}
      {(type === 'agent' || isSuperNode) && (
        <div className="flex flex-col gap-2">
          <label className="text-[11px] text-slate-500">
            {isSuperNode ? (locale === 'zh' ? '协调 / 汇总代理' : 'Coordinator / Synthesizer') : locale === 'zh' ? '执行 Agent' : 'Execution Agent'}
          </label>
          <select
            className={inputCls}
            value={step.agentId ?? ''}
            onChange={(e) => onChange({ ...step, agentId: e.target.value })}
          >
            <option value="">{locale === 'zh' ? '— 选择 Agent —' : '— Select Agent —'}</option>
            {agents.map((a) => (
              <option key={a.agentId} value={a.agentId}>
                {formatAgentOptionLabel(a)}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap gap-2 items-center">
            {selectedAgent?.sandboxProfile === 'readonly-output' && (
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200">
                Readonly
              </span>
            )}
            {selectedAgent?.sandboxProfile && selectedAgent.sandboxProfile !== 'readonly-output' && (
              <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-200">
                sandbox:{selectedAgent.sandboxProfile}
              </span>
            )}
            {preferredAgent && selectedAgent?.agentId === preferredAgent.agentId && (
              <span className="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2 py-1 text-[11px] text-indigo-200">
                {locale === 'zh' ? '首选' : 'Preferred'}
              </span>
            )}
          </div>
          {workflowAgentHint && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200 leading-relaxed">
              {workflowAgentHint}
            </div>
          )}
        </div>
      )}

      {isSuperNode && (
        <div className="flex flex-col gap-3 rounded-lg bg-slate-900/35 ring-1 ring-slate-700/40 p-3">
          {recommendedAgents && (
            <div className="rounded-lg bg-emerald-950/20 ring-1 ring-emerald-900/45 px-3 py-3 flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] uppercase tracking-wider text-emerald-300 font-medium">
                    {locale === 'zh' ? '智能推荐 Agent' : 'Suggested Agents'}
                  </span>
                  <span className="text-[11px] text-slate-400">
                    {locale === 'zh'
                      ? '根据 agent 名称、别名和 sandboxProfile 做轻量推荐，可一键填入。'
                      : 'Lightweight suggestions based on agent names, aliases, and sandboxProfile, with one-click fill.'}
                  </span>
                </div>
                <button
                  type="button"
                  className="rounded-md bg-emerald-500/15 px-3 py-1.5 text-xs text-emerald-300 ring-1 ring-emerald-500/30 hover:bg-emerald-500/20"
                  onClick={() =>
                    onChange({
                      ...step,
                      agentId: recommendedAgents.coordinator?.agent.agentId ?? step.agentId,
                      participantAgentIds:
                        recommendedAgents.participants.length > 0
                          ? recommendedAgents.participants.map((item) => item.agent.agentId)
                          : step.participantAgentIds,
                    })
                  }
                >
                  {locale === 'zh' ? '一键填入推荐' : 'Apply Suggestions'}
                </button>
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-slate-500">{locale === 'zh' ? '推荐协调者' : 'Suggested Coordinator'}</span>
                  {recommendedAgents.coordinator ? (
                    <>
                      <span className="rounded-full bg-slate-900/70 px-2 py-1 text-[11px] text-slate-200 ring-1 ring-slate-700/60">
                        {formatAgentOptionLabel(recommendedAgents.coordinator.agent)}
                      </span>
                      {recommendedAgents.coordinator.reasons.map((reason) => (
                        <span
                          key={reason}
                          className="rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-200 ring-1 ring-emerald-500/20"
                        >
                          {reason}
                        </span>
                      ))}
                      <button
                        type="button"
                        className="rounded-md bg-slate-900/70 px-2 py-1 text-[11px] text-emerald-300 ring-1 ring-emerald-500/25 hover:bg-slate-900"
                        onClick={() => onChange({ ...step, agentId: recommendedAgents.coordinator?.agent.agentId ?? '' })}
                      >
                        {locale === 'zh' ? '使用' : 'Use'}
                      </button>
                    </>
                  ) : (
                    <span className="text-[11px] text-slate-500">{locale === 'zh' ? '暂无推荐' : 'No suggestions'}</span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-slate-500">{locale === 'zh' ? '推荐参与者' : 'Suggested Participants'}</span>
                  {recommendedAgents.participants.length > 0 ? (
                    <>
                      {recommendedAgents.participants.map((item) => (
                        <div key={item.agent.agentId} className="inline-flex items-center gap-1.5 rounded-full bg-slate-900/70 px-2 py-1 ring-1 ring-slate-700/60">
                          <span className="text-[11px] text-slate-200">{formatAgentOptionLabel(item.agent)}</span>
                          {item.reasons.map((reason) => (
                            <span
                              key={`${item.agent.agentId}-${reason}`}
                              className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-200 ring-1 ring-emerald-500/20"
                            >
                              {reason}
                            </span>
                          ))}
                        </div>
                      ))}
                      <button
                        type="button"
                        className="rounded-md bg-slate-900/70 px-2 py-1 text-[11px] text-emerald-300 ring-1 ring-emerald-500/25 hover:bg-slate-900"
                        onClick={() =>
                          onChange({
                            ...step,
                            participantAgentIds: recommendedAgents.participants.map((item) => item.agent.agentId),
                          })
                        }
                      >
                        {locale === 'zh' ? '使用' : 'Use'}
                      </button>
                    </>
                  ) : (
                    <span className="text-[11px] text-slate-500">{locale === 'zh' ? '暂无推荐' : 'No suggestions'}</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {experiencePresets.length > 0 && (
            <div className="rounded-lg bg-cyan-950/25 ring-1 ring-cyan-900/45 px-3 py-3 flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <span className="text-[11px] uppercase tracking-wider text-cyan-300 font-medium">
                  {locale === 'zh' ? '推荐配置' : 'Suggested Presets'}
                </span>
                <span className="text-[11px] text-slate-400">
                  {locale === 'zh'
                    ? '一键填入更贴近业务场景的任务说明、视角与行业规则。'
                    : 'Fill business-ready tasks, perspectives, and rules with one click.'}
                </span>
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
                {experiencePresets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => {
                      const structuredPreset = buildSuperStepStructuredPreset(type);
                      onChange({
                        ...step,
                        ...preset.patch,
                        ...(structuredPreset
                          ? {
                              outputFormat: structuredPreset.outputFormat,
                              outputFormatMode: structuredPreset.outputFormatMode,
                              outputFormatPrompt: structuredPreset.outputFormatPrompt,
                              outputs: structuredPreset.outputs,
                            }
                          : {}),
                      });
                    }}
                    className="rounded-lg bg-slate-900/55 px-3 py-3 ring-1 ring-slate-700/50 hover:ring-cyan-500/35 hover:bg-slate-900/75 transition-colors text-left flex flex-col gap-1"
                  >
                    <span className="text-sm font-medium text-slate-100">{preset.title}</span>
                    <span className="text-[11px] text-slate-400">{preset.summary}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-slate-500">{locale === 'zh' ? '参与 Agent' : 'Participant Agents'}</label>
            <div className="text-[11px] text-slate-600">{superStepParticipantHint(type, locale)}</div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {agents.length === 0 && (
              <div className="text-xs text-slate-500">{locale === 'zh' ? '当前没有可选 Agent。' : 'No agents are available.'}</div>
            )}
            {agents.map((agent) => {
              const checked = (step.participantAgentIds ?? []).includes(agent.agentId);
              const disabled = agent.agentId === (step.agentId ?? '');

              return (
                <label
                  key={agent.agentId}
                  className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm ring-1 transition-colors ${
                    disabled
                      ? 'bg-slate-900/60 ring-slate-800/70 text-slate-600'
                      : 'bg-slate-800/60 ring-slate-700/40 text-slate-300 hover:bg-slate-700/60'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...(step.participantAgentIds ?? []), agent.agentId]
                        : (step.participantAgentIds ?? []).filter((value) => value !== agent.agentId);
                      onChange({
                        ...step,
                        participantAgentIds: next.length > 0 ? Array.from(new Set(next)) : undefined,
                      });
                    }}
                    className="accent-indigo-500"
                  />
                  <span>{formatAgentOptionLabel(agent)}</span>
                  {disabled && <span className="text-[10px] text-slate-500">{locale === 'zh' ? '协调者' : 'Coordinator'}</span>}
                </label>
              );
            })}
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-slate-500">{superStepPromptLabel(type, locale)}</label>
            <textarea
              rows={3}
              className={`${inputCls} resize-none font-mono text-xs`}
              placeholder={locale === 'zh' ? '每行一个并行视角 / 立场 / 维度' : 'One parallel perspective / stance / dimension per line'}
              value={toMultilineItems(step.superNodePrompts)}
              onChange={(e) => {
                const nextPrompts = parseMultilineItems(e.target.value);
                onChange({
                  ...step,
                  superNodePrompts: nextPrompts.length > 0 ? nextPrompts : undefined,
                });
              }}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-slate-500">{locale === 'zh' ? '行业规则 / 约束' : 'Domain Rules / Constraints'}</label>
            <textarea
              rows={3}
              className={`${inputCls} resize-none font-mono text-xs`}
              placeholder={locale === 'zh' ? '例如：合规边界、行业黑名单、预算约束、审批要求' : 'Example: compliance boundaries, blacklists, budget limits, approval rules'}
              value={step.domainRules ?? ''}
              onChange={(e) => onChange({ ...step, domainRules: e.target.value || undefined })}
            />
          </div>

          {(() => {
            const preset = buildSuperStepStructuredPreset(type);
            if (!preset) {
              return null;
            }

            return (
              <div className="rounded-lg bg-indigo-950/30 ring-1 ring-indigo-800/35 px-3 py-3 flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    <span className="text-[11px] uppercase tracking-wider text-indigo-400 font-medium">
                      Structured JSON Template
                    </span>
                    <span className="text-[11px] text-slate-400">
                      {locale === 'zh'
                        ? `一键套用 ${superStepStructuredPresetLabel(type)} 的 JSON 输出约束，并生成可提取字段。`
                        : `Apply the ${superStepStructuredPresetLabel(type)} JSON output constraints and generate extractable fields in one step.`}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="rounded-md bg-indigo-500/15 px-3 py-1.5 text-xs text-indigo-300 ring-1 ring-indigo-500/30 hover:bg-indigo-500/20"
                    onClick={() =>
                      onChange({
                        ...step,
                        outputFormat: preset.outputFormat,
                        outputFormatMode: preset.outputFormatMode,
                        outputFormatPrompt: preset.outputFormatPrompt,
                        outputs: preset.outputs,
                      })
                    }
                  >
                    {locale === 'zh' ? '套用结构化模板' : 'Apply Structured Template'}
                  </button>
                </div>
                <div className="text-[11px] text-slate-500">
                  {locale === 'zh'
                    ? '将自动设置为 JSON + 前置强约束，并写入命名输出变量，后续步骤可直接用 vars.stepId.field 引用。'
                    : 'This sets JSON + prepend constraints automatically and writes named output variables so later steps can reference vars.stepId.field directly.'}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* Message template (agent / http body) */}
      {type !== 'condition' && type !== 'transform' && (
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-slate-500">{superStepMessageLabel(type)}</label>
          <textarea
            rows={2}
            className={`${inputCls} resize-none font-mono text-xs`}
            placeholder="{{input}}, {{prev_output}}, {{vars.stepId.varName}}, {{globals.key}}"
            value={step.messageTemplate}
            onChange={(e) => onChange({ ...step, messageTemplate: e.target.value })}
          />
        </div>
      )}
      {/* Output format constraint — agent steps only */}
      {(type === 'agent' || isSuperNode) && (
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] text-slate-500">输出格式约束</label>
          <select
            className={`${inputCls} text-xs`}
            value={step.outputFormat ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              onChange({
                ...step,
                outputFormat: (v as 'text' | 'json' | 'markdown' | 'custom') || undefined,
                outputFormatPrompt: v !== 'custom' ? undefined : step.outputFormatPrompt,
              });
            }}
          >
            <option value="">— 不限制 —</option>
            <option value="text">纯文本</option>
            <option value="json">JSON</option>
            <option value="markdown">Markdown</option>
            <option value="custom">自定义指令</option>
          </select>
          {step.outputFormat === 'custom' && (
            <textarea
              rows={2}
              className={`${inputCls} resize-none font-mono text-xs`}
              placeholder="例：请以中文回答，分三点总结，每点不超过50字。"
              value={step.outputFormatPrompt ?? ''}
              onChange={(e) => onChange({ ...step, outputFormatPrompt: e.target.value })}
            />
          )}
          {step.outputFormat && (
            <div className="flex items-center gap-4 flex-wrap mt-0.5">
              <span className="text-[11px] text-slate-500">追加方式</span>
              <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                <input
                  type="radio"
                  checked={step.outputFormatMode !== 'prepend'}
                  onChange={() => onChange({ ...step, outputFormatMode: undefined })}
                  className="accent-indigo-500"
                />
                末尾追加（默认）
              </label>
              <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                <input
                  type="radio"
                  checked={step.outputFormatMode === 'prepend'}
                  onChange={() => onChange({ ...step, outputFormatMode: 'prepend' })}
                  className="accent-indigo-500"
                />
                消息前置（严格优先）
              </label>
            </div>
          )}
        </div>
      )}
      {/* Transform code */}
      {type === 'transform' && (
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-slate-500">
            JS 表达式 (receives vars, globals, input, prev_output → returns string)
          </label>
          <textarea
            rows={2}
            className={`${inputCls} resize-none font-mono text-xs`}
            placeholder={'`Summary: ${prev_output.slice(0, 200)}`'}
            value={step.transformCode ?? step.messageTemplate}
            onChange={(e) =>
              onChange({ ...step, transformCode: e.target.value, messageTemplate: e.target.value })
            }
          />
        </div>
      )}

      {/* HTTP fields */}
      {type === 'http' && (
        <div className="grid grid-cols-[auto_1fr] gap-2 items-center">
          <select
            className={`${inputCls} text-xs`}
            value={step.method ?? 'GET'}
            onChange={(e) =>
              onChange({ ...step, method: e.target.value as WorkflowStep['method'] })
            }
          >
            {['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input
            className={inputCls}
            placeholder="https://api.example.com/endpoint"
            value={step.url ?? ''}
            onChange={(e) => onChange({ ...step, url: e.target.value })}
          />
        </div>
      )}

      {/* Condition branches */}
      {type === 'condition' && (
        <ConditionBranchList
          branches={step.branches ?? []}
          steps={allSteps.filter((s) => s.id !== step.id)}
          onChange={(b) => onChange({ ...step, branches: b })}
        />
      )}

      {/* Named output variables */}
      {(type === 'agent' || type === 'http' || isSuperNode) && (
        <OutputVarList
          outputs={step.outputs ?? []}
          onChange={(o) => onChange({ ...step, outputs: o.length ? o : undefined })}
        />
      )}

      {/* Footer: condition + retries */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-slate-500">继续条件</span>
          <select
            className={`${inputCls} text-xs`}
            value={step.condition}
            onChange={(e) =>
              onChange({ ...step, condition: e.target.value as 'any' | 'on_success' })
            }
          >
            <option value="any">始终继续</option>
            <option value="on_success">成功时继续</option>
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-slate-500">重试次数</span>
          <input
            type="number"
            min={0}
            max={10}
            className={`${inputCls} w-16 text-xs`}
            value={step.maxRetries ?? 0}
            onChange={(e) => onChange({ ...step, maxRetries: Number(e.target.value) || undefined })}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-slate-500">下一步</span>
          <select
            className={`${inputCls} text-xs max-w-[220px]`}
            value={step.nextStepId ?? ''}
            onChange={(e) =>
              onChange({
                ...step,
                nextStepId: e.target.value || undefined,
              })
            }
          >
            <option value="">{rowText.defaultNext}</option>
            <option value="$end">$end ({rowText.endFlow})</option>
            {allSteps
              .filter((candidate) => candidate.id !== step.id)
              .map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {formatWorkflowStepOptionLabel(candidate, locale)}
                </option>
              ))}
          </select>
        </div>
      </div>

      {issues.length > 0 && (
        <div className="rounded-lg bg-slate-950/50 ring-1 ring-red-500/20 px-3 py-2 flex flex-col gap-1">
          {issues.map((issue) => (
            <div key={issue} className="text-xs text-red-200">
              {issue}
            </div>
          ))}
        </div>
      )}
        </>
      )}
    </div>
  );
}

// ── WorkflowEditor ────────────────────────────────────────────────────────────

export function WorkflowEditor({
  workflow,
  agents,
  channels,
  onSave,
  onCancel,
}: {
  workflow: WorkflowDef | null;
  agents: AgentInfo[];
  channels: ChannelInfo[];
  onSave: (w: WorkflowDef) => void;
  onCancel: () => void;
}) {
  const { locale } = useLocale();
  const graphText =
    locale === 'zh'
      ? {
          formMode: '当前表单版',
          graphMode: '图形设计器',
          compatibility: '图形设计器与当前 workflow 定义完全兼容，切换后仍保存同一份 steps 配置。',
          canvasEntryEyebrow: '画布入口',
          canvasEntryTitle: '画布版入口就在这里。',
          canvasEntryBody: '适合拖动节点、查看连线、整理阶段布局，再在右侧属性面板继续完成完整配置。',
          openCanvas: '进入画布设计器',
          entryGuide: '查看入口说明',
          canvasTitle: '工作流画布',
          canvasSubtitle: '拖动节点调整布局，选中节点后在右侧属性面板编辑完整配置。',
          fitView: '适配视图',
          autoLayout: '自动排布',
          locateCurrent: '定位当前节点',
          tidySelected: '整理所选节点',
          cancelMainLink: '取消主链连线',
          startMainLink: '从当前节点发起主链',
          sameCardSize: '统一卡片尺寸',
          clickToSelect: '点击节点选中',
          marqueeSelect: '空白处拖拽可框选多个节点',
          dragHandle: '拖动顶部把手改变布局',
          endNodeHint: '右侧终止节点可绑定到 $end',
          selectedMany: '已选择 {count} 个节点，可整体拖动',
          configureNode: '继续配置节点属性',
          runnable: '可运行结构',
          branches: '{count} 分支',
          outputs: '{count} 输出',
          noOutputs: '无输出变量',
          terminal: '终止节点',
          endFlow: '结束流程',
          bindToEnd: '点击绑定当前连线到结束',
          canEnd: '可作为主链或分支终点',
          propertyPanel: '属性面板',
          propertyPanelBody: '选中节点后，在这里继续使用当前完整版配置能力。',
          resetNode: '归位当前节点',
          coordinates: '坐标 {x}, {y}',
          multiMove: '当前处于多节点选择，拖动标题栏会整体移动',
          branchWiring: '分支连线',
          newBranchLink: '+ 新建分支并连线',
          branch: '分支 {index}',
          cancelBind: '取消绑定',
          bindInCanvas: '在画布中绑定目标',
          conditionSummary: '条件摘要',
          branchExpressionPlaceholder: 'branch condition expression',
          branchTarget: '目标: {target}',
          targetUnbound: '尚未绑定',
          bindToFinish: '绑定到结束',
          noBranches: '当前还没有分支。点击上方按钮即可创建并在画布中绑定目标节点。',
          pickNode: '先在左侧画布选择一个节点，再在这里编辑它的详细属性。',
          issueCount: '{count} 个问题',
          linkingMain: '正在从该节点发起主链连线',
          linkingBranch: '正在绑定分支 {index}',
        }
      : {
          formMode: 'Form Editor',
          graphMode: 'Graph Designer',
          compatibility: 'The graph designer is fully compatible with the current workflow definition and saves the same steps config.',
          canvasEntryEyebrow: 'Canvas Entry',
          canvasEntryTitle: 'The canvas designer starts here.',
          canvasEntryBody: 'Use it to drag nodes, inspect links, and tidy stage layouts, then continue full configuration in the property panel.',
          openCanvas: 'Open Canvas Designer',
          entryGuide: 'How to Find It',
          canvasTitle: 'Workflow Canvas',
          canvasSubtitle: 'Drag nodes to adjust layout, then edit the full configuration for the selected node in the property panel.',
          fitView: 'Fit View',
          autoLayout: 'Auto Layout',
          locateCurrent: 'Locate Current Node',
          tidySelected: 'Tidy Selected Nodes',
          cancelMainLink: 'Cancel Main Link',
          startMainLink: 'Start Main Link',
          sameCardSize: 'Uniform card size',
          clickToSelect: 'Click to select nodes',
          marqueeSelect: 'Drag on empty space to marquee-select multiple nodes',
          dragHandle: 'Drag the top handle to move layout',
          endNodeHint: 'Bind links to the $end terminal node on the right',
          selectedMany: '{count} nodes selected, drag any selected handle to move together',
          configureNode: 'Continue configuring this node',
          runnable: 'Runnable structure',
          branches: '{count} branches',
          outputs: '{count} outputs',
          noOutputs: 'No output vars',
          terminal: 'Terminal',
          endFlow: 'End Flow',
          bindToEnd: 'Click to bind the active link to end',
          canEnd: 'Available as a main-path or branch terminal',
          propertyPanel: 'Property Panel',
          propertyPanelBody: 'Select a node to keep editing its full configuration here.',
          resetNode: 'Reset Current Node',
          coordinates: 'Position {x}, {y}',
          multiMove: 'Multi-selection is active. Dragging the header will move the whole group.',
          branchWiring: 'Branch Wiring',
          newBranchLink: '+ Create Branch and Link',
          branch: 'Branch {index}',
          cancelBind: 'Cancel Binding',
          bindInCanvas: 'Bind in Canvas',
          conditionSummary: 'Condition Summary',
          branchExpressionPlaceholder: 'branch condition expression',
          branchTarget: 'Target: {target}',
          targetUnbound: 'unbound',
          bindToFinish: 'Bind to End',
          noBranches: 'No branches yet. Use the button above to create one and bind its target in the canvas.',
          pickNode: 'Select a node in the canvas first, then edit its detailed properties here.',
          issueCount: '{count} issues',
          linkingMain: 'Starting a main-path link from this node',
          linkingBranch: 'Binding branch {index}',
        };
  const formText =
    locale === 'zh'
      ? {
          statSteps: '步骤数',
          statSuperNodes: '超级节点',
          statOutputs: '输出变量',
          statTargets: '传播目标',
          stageSummary: '阶段摘要',
          stageSummaryHint: '按当前步骤自动聚合',
          stageSummaryEmpty: '添加步骤后会自动出现阶段摘要。',
          checklist: '当前待补清单',
          checklistHint: '模板应用后优先补齐这些项',
          healthy: '当前工作流关键配置已基本齐备，可以开始试跑或继续做细节优化。',
          locateStage: '定位阶段',
          tidyStage: '整理阶段',
          stageIssues: '问题',
          stagePending: '待补',
          stageNodes: '个节点',
          stepConfig: '步骤配置',
          expandAll: '全部展开',
          collapseAll: '全部折叠',
          noSteps: '暂无步骤',
          continueConfig: '继续填写节点配置',
          issuePending: '{count} 个问题待处理',
          currentStepEmpty: '当前步骤还没有足够配置，继续在下方填写字段即可。',
        }
      : {
          statSteps: 'Steps',
          statSuperNodes: 'Super Nodes',
          statOutputs: 'Output Vars',
          statTargets: 'Targets',
          stageSummary: 'Stage Summary',
          stageSummaryHint: 'Automatically grouped from current steps',
          stageSummaryEmpty: 'Stage summaries will appear after you add steps.',
          checklist: 'Checklist',
          checklistHint: 'Prioritize these after applying a template',
          healthy: 'The main workflow configuration is in good shape. You can run it or continue refining details.',
          locateStage: 'Locate Stage',
          tidyStage: 'Tidy Stage',
          stageIssues: 'Issues',
          stagePending: 'Pending',
          stageNodes: 'nodes',
          stepConfig: 'Step Configuration',
          expandAll: 'Expand All',
          collapseAll: 'Collapse All',
          noSteps: 'No steps yet',
          continueConfig: 'Continue filling this node',
          issuePending: '{count} issues pending',
          currentStepEmpty: 'This step is not configured enough yet. Continue filling fields below.',
        };
  const diagnosisText =
    locale === 'zh'
      ? {
          title: '工作流诊断',
          subtitle: '保存路径不受影响，这里展示的是实时预诊断结果。',
          loading: '诊断中…',
          stepPrefix: '步骤',
          healthy: '当前工作流结构诊断正常。',
          save: '保存修改',
          create: '创建工作流',
        }
      : {
          title: 'Workflow Diagnostics',
          subtitle: 'Save is not affected. This panel shows live pre-diagnostics.',
          loading: 'Diagnosing…',
          stepPrefix: 'Step',
          healthy: 'Workflow structure looks healthy.',
          save: 'Save Changes',
          create: 'Create Workflow',
        };
  const [name, setName] = useState(workflow?.name ?? '');
  const [description, setDescription] = useState(workflow?.description ?? '');
  const [steps, setSteps] = useState<WorkflowStep[]>(
    workflow?.steps ?? [
      {
        id: newStepId(),
        type: 'agent',
        agentId: '',
        messageTemplate: '{{input}}',
        condition: 'any',
      },
    ],
  );
  const [variables, setVariables] = useState<Record<string, string>>(workflow?.variables ?? {});
  const [showGlobals, setShowGlobals] = useState(Object.keys(workflow?.variables ?? {}).length > 0);
  const [newGlobalKey, setNewGlobalKey] = useState('');
  const [newGlobalVal, setNewGlobalVal] = useState('');
  const [nameError, setNameError] = useState(false);
  const [inputRequired, setInputRequired] = useState(workflow?.inputRequired !== false);
  const [draftId] = useState(() => workflow?.id ?? newStepId());
  const [draftCreatedAt] = useState(() => workflow?.createdAt ?? Date.now());
  const [publicationTargets, setPublicationTargets] = useState<PublicationTargetConfig[]>(
    workflow?.publicationTargets ?? [],
  );
  const [designerLayout, setDesignerLayout] = useState<WorkflowDesignerLayout>(() =>
    normalizeWorkflowDesignerLayout(workflow?.steps ?? [], workflow?.designerLayout),
  );
  const [graphZoom, setGraphZoom] = useState(1);
  const [graphScroll, setGraphScroll] = useState({ x: 0, y: 0 });
  const [liveRun, setLiveRun] = useState<WorkflowRunRecord | null>(null);
  const [editorMode, setEditorMode] = useState<WorkflowEditorMode>(
    workflow?.designerLayout?.preferredMode === 'graph' ? 'graph' : 'form',
  );
  const [connectionState, setConnectionState] = useState<GraphConnectionState | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [graphSelectionStepIds, setGraphSelectionStepIds] = useState<string[]>(
    workflow?.steps[0]?.id ? [workflow.steps[0].id] : [],
  );
  const [graphMarquee, setGraphMarquee] = useState<GraphMarqueeState | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [diagnosis, setDiagnosis] = useState<WorkflowDiagnoseResult | null>(null);
  const [diagnosisLoading, setDiagnosisLoading] = useState(false);
  const [diagnosisError, setDiagnosisError] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(workflow?.steps[0]?.id ?? null);
  const [collapsedStepIds, setCollapsedStepIds] = useState<string[]>([]);
  const workflowStarters = useMemo(() => buildWorkflowStarters(), []);
  const graphViewportRef = useRef<HTMLDivElement | null>(null);
  const [editingLabelStepId, setEditingLabelStepId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [showStageSummary, setShowStageSummary] = useState(false);
  // Undo/redo: positions snapshots (max 20 entries)
  const positionsHistoryRef = useRef<Array<Record<string, WorkflowDesignerPosition>>>([]);
  const positionsHistoryCursorRef = useRef<number>(-1);
  // Stable mutable refs used in event handlers to avoid stale closures
  const graphSelectionStepIdsRef = useRef<string[]>(graphSelectionStepIds);
  graphSelectionStepIdsRef.current = graphSelectionStepIds;
  const stepsRef = useRef<WorkflowStep[]>(steps);
  stepsRef.current = steps;
  const editorModeRef = useRef<WorkflowEditorMode>(editorMode);
  editorModeRef.current = editorMode;
  const graphZoomRef = useRef(graphZoom);
  graphZoomRef.current = graphZoom;

  const stepIssueMap = useMemo(() => collectStepIssueMap(diagnosis, locale), [diagnosis, locale]);
  const workflowIssueMessages = useMemo(() => collectWorkflowIssueMessages(diagnosis), [diagnosis]);
  const issueStepCount = Object.keys(stepIssueMap).length;
  const selectedStep = useMemo(
    () => steps.find((step) => step.id === selectedStepId) ?? null,
    [selectedStepId, steps],
  );
  const superStepCount = useMemo(
    () => steps.filter((step) => isSuperStepType(step.type ?? 'agent')).length,
    [steps],
  );
  const outputVarCount = useMemo(
    () => steps.reduce((sum, step) => sum + (step.outputs?.length ?? 0), 0),
    [steps],
  );
  const workflowStages = useMemo(() => collectWorkflowStages(steps, locale), [locale, steps]);
  const workflowStageSummaries = useMemo(
    () => collectWorkflowStageSummaries(steps, stepIssueMap, locale),
    [locale, stepIssueMap, steps],
  );
  const workflowChecklist = useMemo(
    () => collectWorkflowChecklistItems(name, steps, stepIssueMap, publicationTargets, locale),
    [locale, name, publicationTargets, stepIssueMap, steps],
  );
  const allStepsCollapsed = steps.length > 0 && steps.every((step) => collapsedStepIds.includes(step.id));
  const nodePositions = designerLayout.positions ?? {};
  const graphEdges = useMemo(() => buildWorkflowGraphEdges(steps), [steps]);
  const dataFlowEdges = useMemo(() => buildDataFlowEdges(steps), [steps]);
  const endNodePosition = useMemo(
    () => buildWorkflowGraphEndPosition(steps, nodePositions),
    [nodePositions, steps],
  );
  const graphCanvasMetrics = useMemo(
    () => buildWorkflowGraphCanvasMetrics(steps, nodePositions, endNodePosition),
    [endNodePosition, nodePositions, steps],
  );
  const connectionDescription = useMemo(
    () => describeGraphConnectionState(connectionState, steps, locale),
    [connectionState, locale, steps],
  );

  const buildDraftWorkflow = (): WorkflowDef => ({
    id: draftId,
    name: name.trim(),
    description: description.trim() || undefined,
    steps,
    designerLayout: {
      preferredMode: editorMode,
      positions: nodePositions,
    },
    publicationTargets: publicationTargets.length > 0 ? publicationTargets : undefined,
    variables: Object.keys(variables).length > 0 ? variables : undefined,
    inputRequired: inputRequired ? undefined : false,
    createdAt: draftCreatedAt,
    updatedAt: Date.now(),
  });

  useEffect(() => {
    if (!workflow && !name.trim()) {
      setDiagnosis(null);
      setDiagnosisError(null);
      setDiagnosisLoading(false);
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setDiagnosisLoading(true);
      setDiagnosisError(null);
      void rpc<WorkflowDiagnoseResult>('workflow.diagnose', buildDraftWorkflow(), controller.signal)
        .then((result) => setDiagnosis(result))
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setDiagnosis(null);
          setDiagnosisError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setDiagnosisLoading(false);
          }
        });
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [
    description,
    draftCreatedAt,
    draftId,
    inputRequired,
    name,
    publicationTargets,
    steps,
    variables,
    workflow,
  ]);

  useEffect(() => {
    const stepIds = new Set(steps.map((step) => step.id));
    if (selectedStepId && stepIds.has(selectedStepId)) {
      return;
    }
    setSelectedStepId(getFirstIssueStepId(diagnosis) ?? steps[0]?.id ?? null);
  }, [diagnosis, selectedStepId, steps]);

  useEffect(() => {
    const stepIds = new Set(steps.map((step) => step.id));
    setCollapsedStepIds((current) => current.filter((stepId) => stepIds.has(stepId)));
  }, [steps]);

  useEffect(() => {
    const stepIds = new Set(steps.map((step) => step.id));
    setConnectionState((current) =>
      current && stepIds.has(current.sourceStepId) ? current : null,
    );
    setDragState((current) =>
      current && current.stepIds.every((stepId) => stepIds.has(stepId)) ? current : null,
    );
    setGraphSelectionStepIds((current) => current.filter((stepId) => stepIds.has(stepId)));
  }, [steps]);

  useEffect(() => {
    setDesignerLayout((current) => {
      const normalized = normalizeWorkflowDesignerLayout(steps, current);
      const previousPositions = current.positions ?? {};
      const nextPositions = normalized.positions ?? {};
      const keys = Object.keys(nextPositions);
      const unchanged =
        keys.length === Object.keys(previousPositions).length &&
        keys.every(
          (key) =>
            previousPositions[key]?.x === nextPositions[key]?.x &&
            previousPositions[key]?.y === nextPositions[key]?.y,
        );
      if (unchanged) {
        return current.preferredMode === editorMode ? current : { ...current, preferredMode: editorMode };
      }
      return {
        preferredMode: editorMode,
        positions: nextPositions,
      };
    });
  }, [editorMode, steps]);

  useEffect(() => {
    if (!dragState && !graphMarquee) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (dragState && event.pointerId === dragState.pointerId) {
        const deltaX = event.clientX - dragState.startX;
        const deltaY = event.clientY - dragState.startY;
        setDesignerLayout((current) => {
          const nextPositions = { ...(current.positions ?? {}) };
          dragState.stepIds.forEach((stepId) => {
            const origin = dragState.origins[stepId] ?? { x: 72, y: 72 };
            nextPositions[stepId] = clampDesignerPosition({
              x: origin.x + deltaX / graphZoom,
              y: origin.y + deltaY / graphZoom,
            });
          });
          return {
            preferredMode: current.preferredMode ?? editorMode,
            positions: nextPositions,
          };
        });
      }

      if (graphMarquee && event.pointerId === graphMarquee.pointerId) {
        const viewport = graphViewportRef.current;
        if (!viewport) {
          return;
        }
        const viewportRect = viewport.getBoundingClientRect();
        const nextX = (viewport.scrollLeft + event.clientX - viewportRect.left) / graphZoom;
        const nextY = (viewport.scrollTop + event.clientY - viewportRect.top) / graphZoom;
        setGraphMarquee((current) =>
          current
            ? {
                ...current,
                currentX: nextX,
                currentY: nextY,
              }
            : current,
        );
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (dragState && event.pointerId === dragState.pointerId) {
        // Push current positions to undo history after a drag completes
        setDesignerLayout((current) => {
          const snapshot = { ...(current.positions ?? {}) };
          const history = positionsHistoryRef.current;
          const cursor = positionsHistoryCursorRef.current;
          const trimmed = history.slice(0, cursor + 1);
          const next = [...trimmed, snapshot].slice(-20);
          positionsHistoryRef.current = next;
          positionsHistoryCursorRef.current = next.length - 1;
          return current;
        });
        setDragState(null);
      }

      if (graphMarquee && event.pointerId === graphMarquee.pointerId) {
        const selectionBounds = buildGraphSelectionBounds(graphMarquee);
        const selectedIds =
          selectionBounds.width < 8 && selectionBounds.height < 8
            ? []
            : steps
                .filter((step) =>
                  intersectsGraphSelection(nodePositions[step.id] ?? { x: 72, y: 72 }, selectionBounds),
                )
                .map((step) => step.id);
        setGraphSelectionStepIds(selectedIds);
        if (selectedIds[0]) {
          setSelectedStepId(selectedIds[0]);
        }
        setGraphMarquee(null);
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [dragState, editorMode, graphMarquee, graphZoom, nodePositions, steps]);

  // A5: Poll for the latest workflow run to display live execution state
  useEffect(() => {
    if (!workflow?.id || editorMode !== 'graph') return;
    const workflowId = workflow.id;
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof window.setTimeout>;

    const poll = () => {
      void rpc<{ runs: WorkflowRunRecord[] }>('workflow.history', null, controller.signal).then((data) => {
        if (controller.signal.aborted) return;
        const latest = data.runs.find((r) => r.workflowId === workflowId);
        setLiveRun(latest ?? null);
        if (latest?.status === 'running') {
          timeoutId = window.setTimeout(poll, 1500);
        } else {
          timeoutId = window.setTimeout(poll, 8000);
        }
      }).catch(() => {
        if (!controller.signal.aborted) timeoutId = window.setTimeout(poll, 10000);
      });
    };

    poll();
    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [workflow?.id, editorMode]);

  // A1: Mouse-wheel zoom on the canvas viewport (Ctrl+Wheel = zoom, plain Wheel = native scroll)
  useEffect(() => {
    const viewport = graphViewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const factor = event.deltaY > 0 ? -0.1 : 0.1;
      setGraphZoom((current) => Math.min(2.0, Math.max(0.3, Number((current + factor).toFixed(2)))));
    };
    const handleScroll = () => setGraphScroll({ x: viewport.scrollLeft, y: viewport.scrollTop });
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    viewport.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      viewport.removeEventListener('wheel', handleWheel);
      viewport.removeEventListener('scroll', handleScroll);
    };
  });

  // A2: Global keyboard shortcuts when graph canvas is active
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (editorModeRef.current !== 'graph') return;
      const tag = (event.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      // Escape — cancel wiring / clear label edit
      if (event.key === 'Escape') {
        event.preventDefault();
        setConnectionState(null);
        setEditingLabelStepId(null);
        setGraphSelectionStepIds([]);
        return;
      }

      // Delete / Backspace — remove selected nodes
      if ((event.key === 'Delete' || event.key === 'Backspace') && graphSelectionStepIdsRef.current.length > 0) {
        event.preventDefault();
        // Snapshot current positions for undo
        const idsToRemove = new Set(graphSelectionStepIdsRef.current);
        setDesignerLayout((current) => {
          const snapshot = { ...(current.positions ?? {}) };
          const trimmed = positionsHistoryRef.current.slice(0, positionsHistoryCursorRef.current + 1);
          const next = [...trimmed, snapshot].slice(-20);
          positionsHistoryRef.current = next;
          positionsHistoryCursorRef.current = next.length - 1;
          return current;
        });
        setSteps((current) => current.filter((step) => !idsToRemove.has(step.id)));
        setGraphSelectionStepIds([]);
        return;
      }

      if (event.ctrlKey || event.metaKey) {
        // Ctrl+A — select all nodes
        if (event.key === 'a' || event.key === 'A') {
          event.preventDefault();
          setGraphSelectionStepIds(stepsRef.current.map((step) => step.id));
          return;
        }
        // Ctrl+Z — undo positions, Ctrl+Shift+Z / Ctrl+Y — redo positions
        if (event.key === 'z' || event.key === 'Z') {
          event.preventDefault();
          if (event.shiftKey) {
            // Redo
            const cursor = positionsHistoryCursorRef.current;
            const history = positionsHistoryRef.current;
            if (cursor < history.length - 1) {
              positionsHistoryCursorRef.current = cursor + 1;
              const snapshot = history[positionsHistoryCursorRef.current];
              if (snapshot) setDesignerLayout((current) => ({ ...current, positions: snapshot }));
            }
          } else {
            // Undo
            const cursor = positionsHistoryCursorRef.current;
            const history = positionsHistoryRef.current;
            if (cursor > 0) {
              positionsHistoryCursorRef.current = cursor - 1;
              const snapshot = history[positionsHistoryCursorRef.current];
              if (snapshot) setDesignerLayout((current) => ({ ...current, positions: snapshot }));
            }
          }
          return;
        }
        if (event.key === 'y' || event.key === 'Y') {
          event.preventDefault();
          const cursor = positionsHistoryCursorRef.current;
          const history = positionsHistoryRef.current;
          if (cursor < history.length - 1) {
            positionsHistoryCursorRef.current = cursor + 1;
            const snapshot = history[positionsHistoryCursorRef.current];
            if (snapshot) setDesignerLayout((current) => ({ ...current, positions: snapshot }));
          }
          return;
        }
      }

      // Arrow keys — nudge selected nodes (Shift = ±40px, plain = ±8px)
      if (graphSelectionStepIdsRef.current.length > 0 && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        const delta = event.shiftKey ? 40 : 8;
        const dx = event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0;
        const dy = event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0;
        const ids = graphSelectionStepIdsRef.current;
        setDesignerLayout((current) => {
          const nextPositions = { ...(current.positions ?? {}) };
          ids.forEach((stepId) => {
            const pos = nextPositions[stepId] ?? { x: 72, y: 72 };
            nextPositions[stepId] = clampDesignerPosition({ x: pos.x + dx, y: pos.y + dy });
          });
          return { ...current, positions: nextPositions };
        });
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const focusStep = (stepId: string) => {
    setSelectedStepId(stepId);
    if (editorMode === 'form') {
      scrollToWorkflowStep(stepId);
    }
  };

  const focusGraphRegion = (
    position: WorkflowDesignerPosition,
    size: { width: number; height: number },
  ) => {
    const viewport = graphViewportRef.current;
    if (!viewport) {
      return;
    }
    const targetLeft = position.x * graphZoom - viewport.clientWidth / 2 + (size.width * graphZoom) / 2;
    const targetTop = position.y * graphZoom - viewport.clientHeight / 2 + (size.height * graphZoom) / 2;
    viewport.scrollTo({
      left: Math.max(0, targetLeft),
      top: Math.max(0, targetTop),
      behavior: 'smooth',
    });
  };

  const focusGraphStep = (stepId: string) => {
    const position = nodePositions[stepId];
    if (!position) {
      return;
    }
    window.requestAnimationFrame(() => {
      focusGraphRegion(position, { width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT });
    });
  };

  const revealAndFocusStep = (stepId: string) => {
    setCollapsedStepIds((current) => current.filter((value) => value !== stepId));
    focusStep(stepId);
    if (editorMode === 'graph') {
      focusGraphStep(stepId);
    }
  };

  const beginNodeDrag = (stepId: string, pointerId: number, clientX: number, clientY: number) => {
    const activeStepIds =
      graphSelectionStepIds.includes(stepId) && graphSelectionStepIds.length > 1
        ? graphSelectionStepIds
        : [stepId];
    const origins = Object.fromEntries(
      activeStepIds.map((activeStepId) => [activeStepId, nodePositions[activeStepId] ?? { x: 72, y: 72 }]),
    );
    setGraphSelectionStepIds(activeStepIds);
    setSelectedStepId(stepId);
    setDragState({ stepIds: activeStepIds, pointerId, startX: clientX, startY: clientY, origins });
  };

  const beginGraphMarquee = (pointerId: number, clientX: number, clientY: number) => {
    const viewport = graphViewportRef.current;
    if (!viewport) {
      return;
    }
    const viewportRect = viewport.getBoundingClientRect();
    const startX = (viewport.scrollLeft + clientX - viewportRect.left) / graphZoom;
    const startY = (viewport.scrollTop + clientY - viewportRect.top) / graphZoom;
    setConnectionState(null);
    setGraphMarquee({ pointerId, startX, startY, currentX: startX, currentY: startY });
  };

  const moveNodeTo = (stepId: string, position: WorkflowDesignerPosition) => {
    setDesignerLayout((current) => ({
      preferredMode: current.preferredMode ?? editorMode,
      positions: {
        ...(current.positions ?? {}),
        [stepId]: clampDesignerPosition(position),
      },
    }));
  };

  const connectSelectedNodeTo = (targetStepId: string) => {
    if (!connectionState) {
      return;
    }
    setSteps((current) =>
      current.map((step) => {
        if (step.id !== connectionState.sourceStepId) {
          return step;
        }
        if (connectionState.mode === 'next' && step.type !== 'condition') {
          return { ...step, nextStepId: targetStepId };
        }
        if (connectionState.mode === 'branch' && step.type === 'condition' && typeof connectionState.branchIndex === 'number') {
          const branches = [...(step.branches ?? [])];
          const existing = branches[connectionState.branchIndex] ?? { expression: 'true', goto: '' };
          branches[connectionState.branchIndex] = { ...existing, goto: targetStepId };
          return { ...step, branches };
        }
        return step;
      }),
    );
    setConnectionState(null);
    revealAndFocusStep(targetStepId);
  };

  const connectSelectedNodeToEnd = () => {
    if (!connectionState) {
      return;
    }
    setSteps((current) =>
      current.map((step) => {
        if (step.id !== connectionState.sourceStepId) {
          return step;
        }
        if (connectionState.mode === 'next' && step.type !== 'condition') {
          return { ...step, nextStepId: '$end' };
        }
        if (connectionState.mode === 'branch' && step.type === 'condition' && typeof connectionState.branchIndex === 'number') {
          const branches = [...(step.branches ?? [])];
          const existing = branches[connectionState.branchIndex] ?? { expression: 'true', goto: '' };
          branches[connectionState.branchIndex] = { ...existing, goto: '$end' };
          return { ...step, branches };
        }
        return step;
      }),
    );
    setConnectionState(null);
  };

  const deleteEdge = (edgeId: string) => {
    const parts = edgeId.split(':');
    const sourceId = parts[0];
    if (!sourceId) return;
    setSteps((current) =>
      current.map((step) => {
        if (step.id !== sourceId) return step;
        if (parts[1] === 'next') {
          return { ...step, nextStepId: undefined };
        }
        if (parts[1] === 'branch' && typeof parts[2] === 'string') {
          const branchIdx = parseInt(parts[2], 10);
          if (isNaN(branchIdx)) return step;
          const branches = [...(step.branches ?? [])];
          const existing = branches[branchIdx];
          if (existing) branches[branchIdx] = { ...existing, goto: '' };
          return { ...step, branches };
        }
        return step;
      }),
    );
    setSelectedEdgeId(null);
  };

  const reconnectEdge = (edgeId: string) => {
    const parts = edgeId.split(':');
    const sourceId = parts[0];
    if (!sourceId) return;
    if (parts[1] === 'next') {
      setConnectionState({ sourceStepId: sourceId, mode: 'next' });
    } else if (parts[1] === 'branch' && typeof parts[2] === 'string') {
      const branchIdx = parseInt(parts[2], 10);
      if (!isNaN(branchIdx)) {
        setConnectionState({ sourceStepId: sourceId, mode: 'branch', branchIndex: branchIdx });
      }
    }
    setSelectedEdgeId(null);
  };

  const beginNextConnectionFromStep = (stepId: string) => {
    setConnectionState((current) =>
      current?.sourceStepId === stepId && current.mode === 'next'
        ? null
        : { sourceStepId: stepId, mode: 'next' },
    );
  };

  const beginConditionBranchConnection = (stepId: string, branchIndex: number) => {
    setSteps((current) =>
      current.map((step) => {
        if (step.id !== stepId || step.type !== 'condition') {
          return step;
        }
        const branches = [...(step.branches ?? [])];
        while (branches.length <= branchIndex) {
          branches.push({ expression: `branch_${branches.length + 1}`, goto: '' });
        }
        return { ...step, branches };
      }),
    );
    setConnectionState((current) =>
      current?.sourceStepId === stepId && current.mode === 'branch' && current.branchIndex === branchIndex
        ? null
        : { sourceStepId: stepId, mode: 'branch', branchIndex },
    );
  };

  const adjustGraphZoom = (delta: number) => {
    setGraphZoom((current) => Math.min(1.8, Math.max(0.55, Number((current + delta).toFixed(2)))));
  };

  const resetGraphZoom = () => {
    setGraphZoom(1);
  };

  const fitGraphToView = () => {
    const widthZoom = 1120 / graphCanvasMetrics.width;
    const heightZoom = 680 / graphCanvasMetrics.height;
    const nextZoom = Math.min(1.25, Math.max(0.55, Math.min(widthZoom, heightZoom)));
    setGraphZoom(Number(nextZoom.toFixed(2)));
  };

  const tidyStageNodes = (stageId: string) => {
    const stageSteps = steps.filter((step) => getWorkflowStageMeta(step.type ?? 'agent', locale).id === stageId);
    if (stageSteps.length === 0) {
      return;
    }

    const orderedStageSteps = [...stageSteps].sort((left, right) => {
      const leftPosition = nodePositions[left.id] ?? { x: 72, y: 72 };
      const rightPosition = nodePositions[right.id] ?? { x: 72, y: 72 };
      if (leftPosition.y !== rightPosition.y) {
        return leftPosition.y - rightPosition.y;
      }
      return steps.findIndex((step) => step.id === left.id) - steps.findIndex((step) => step.id === right.id);
    });

    const anchorX = Math.min(...orderedStageSteps.map((step) => nodePositions[step.id]?.x ?? 72));
    const anchorY = Math.min(...orderedStageSteps.map((step) => nodePositions[step.id]?.y ?? 72));

    setDesignerLayout((current) => {
      const nextPositions = { ...(current.positions ?? {}) };
      orderedStageSteps.forEach((step, index) => {
        nextPositions[step.id] = clampDesignerPosition({
          x: anchorX,
          y: anchorY + index * GRAPH_STAGE_GAP_Y,
        });
      });
      return {
        preferredMode: current.preferredMode ?? editorMode,
        positions: nextPositions,
      };
    });

    const firstStepId = orderedStageSteps[0]?.id;
    if (firstStepId) {
      setSelectedStepId(firstStepId);
      window.setTimeout(() => focusGraphStep(firstStepId), 40);
    }
  };

  const tidySelectedNodes = () => {
    if (graphSelectionStepIds.length < 2) {
      return;
    }

    const orderedSelectedIds = [...graphSelectionStepIds].sort((leftId, rightId) => {
      const leftPosition = nodePositions[leftId] ?? { x: 72, y: 72 };
      const rightPosition = nodePositions[rightId] ?? { x: 72, y: 72 };
      if (leftPosition.y !== rightPosition.y) {
        return leftPosition.y - rightPosition.y;
      }
      return steps.findIndex((step) => step.id === leftId) - steps.findIndex((step) => step.id === rightId);
    });

    const anchorX = Math.min(...orderedSelectedIds.map((stepId) => nodePositions[stepId]?.x ?? 72));
    const anchorY = Math.min(...orderedSelectedIds.map((stepId) => nodePositions[stepId]?.y ?? 72));

    setDesignerLayout((current) => {
      const nextPositions = { ...(current.positions ?? {}) };
      orderedSelectedIds.forEach((stepId, index) => {
        nextPositions[stepId] = clampDesignerPosition({
          x: anchorX,
          y: anchorY + index * GRAPH_STAGE_GAP_Y,
        });
      });
      return {
        preferredMode: current.preferredMode ?? editorMode,
        positions: nextPositions,
      };
    });

    if (orderedSelectedIds[0]) {
      window.setTimeout(() => focusGraphStep(orderedSelectedIds[0]), 40);
    }
  };

  const updateStep = (i: number, s: WorkflowStep) =>
    setSteps((p) => p.map((x, j) => (j === i ? s : x)));
  const insertStepAt = (index: number, type: StepType = 'agent') => {
    const step = createDefaultStep(type);
    setSteps((current) => {
      const next = [...current];
      next.splice(index, 0, step);
      return next;
    });
    setSelectedStepId(step.id);
  };
  const moveUp = (i: number) =>
    setSteps((p) => {
      const a = [...p];
      [a[i - 1], a[i]] = [a[i]!, a[i - 1]!];
      return a;
    });
  const moveDown = (i: number) =>
    setSteps((p) => {
      const a = [...p];
      [a[i], a[i + 1]] = [a[i + 1]!, a[i]!];
      return a;
    });
  const removeStep = (i: number) => setSteps((p) => p.filter((_, j) => j !== i));
  const addStep = (type: StepType = 'agent') =>
    setSteps((p) => {
      const step = createDefaultStep(type);
      setSelectedStepId(step.id);
      return [...p, step];
    });
  const duplicateStepAt = (index: number) => {
    setSteps((current) => {
      const next = [...current];
      const duplicated = cloneStepForDuplicate(current[index]!);
      next.splice(index + 1, 0, duplicated);
      setSelectedStepId(duplicated.id);
      return next;
    });
  };
  const applyWorkflowStarter = (starter: WorkflowStarter) => {
    setName(starter.suggestedName);
    setDescription(starter.suggestedDescription);
    setSteps(starter.steps);
    setSelectedStepId(starter.steps[0]?.id ?? null);
    setInputRequired(true);
    setCollapsedStepIds([]);
  };
  const toggleStepCollapse = (stepId: string) => {
    setCollapsedStepIds((current) =>
      current.includes(stepId) ? current.filter((value) => value !== stepId) : [...current, stepId],
    );
  };
  const setAllStepsCollapsed = (collapsed: boolean) => {
    setCollapsedStepIds(collapsed ? steps.map((step) => step.id) : []);
  };

  const handleSave = () => {
    if (!name.trim()) {
      setNameError(true);
      return;
    }
    setNameError(false);
    onSave(buildDraftWorkflow());
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-100">
          {workflow ? '编辑工作流' : '新建工作流'}
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowHelp((v) => !v)}
            className={`px-2.5 py-1 text-xs rounded-lg transition-colors ring-1 ${
              showHelp
                ? 'bg-indigo-600/30 ring-indigo-500/50 text-indigo-200'
                : 'ring-slate-700/60 text-slate-400 hover:text-slate-200 hover:ring-slate-600'
            }`}
            title="查看使用说明"
          >
            📖 使用说明
          </button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            取消
          </Button>
        </div>
      </div>

      {/* Inline usage guide */}
      {showHelp && <WorkflowGuide onClose={() => setShowHelp(false)} />}

      {/* Name + description */}
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-400">名称 *</label>
          <input
            className={`${inputCls} ${nameError ? 'ring-red-500' : ''}`}
            placeholder="我的工作流"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (e.target.value.trim()) setNameError(false);
            }}
          />
          {nameError && <span className="text-xs text-red-400 mt-0.5">请先输入工作流名称</span>}
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-400">描述</label>
          <input
            className={inputCls}
            placeholder="这个工作流做什么？"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {[
          { label: formText.statSteps, value: String(steps.length) },
          { label: formText.statSuperNodes, value: String(superStepCount) },
          { label: formText.statOutputs, value: String(outputVarCount) },
          { label: formText.statTargets, value: String(publicationTargets.length) },
        ].map((item) => (
          <div
            key={item.label}
            className="flex items-center gap-1.5 rounded-lg bg-slate-800/45 ring-1 ring-slate-700/50 px-3 py-1"
          >
            <span className="text-[11px] text-slate-500">{item.label}</span>
            <span className="text-sm font-semibold text-slate-100">{item.value}</span>
          </div>
        ))}
      </div>

      {!workflow && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">从场景模板起步</span>
            <span className="text-[11px] text-slate-500">先铺好骨架，再替换 agent 与提示词</span>
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
            {workflowStarters.map((starter) => (
              <button
                key={starter.id}
                type="button"
                onClick={() => applyWorkflowStarter(starter)}
                className="rounded-xl bg-slate-800/55 ring-1 ring-slate-700/50 px-4 py-4 text-left hover:bg-slate-800/75 hover:ring-indigo-500/35 transition-colors flex flex-col gap-2"
              >
                {starter.category && (
                  <span className="inline-flex w-fit rounded-full bg-slate-900/70 px-2 py-1 text-[10px] uppercase tracking-wider text-slate-400 ring-1 ring-slate-700/60">
                    {starter.category}
                  </span>
                )}
                <span className="text-sm font-semibold text-slate-100">{starter.title}</span>
                <span className="text-xs text-slate-400">{starter.summary}</span>
                <span className="text-[11px] text-slate-500">{starter.suggestedDescription}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={() => setShowStageSummary((v) => !v)}
          className="mb-2 flex items-center gap-2 text-xs text-slate-400 hover:text-slate-200"
        >
          <span className="text-slate-600">{showStageSummary ? '▼' : '▶'}</span>
          <span>{formText.stageSummary}</span>
          {workflowStageSummaries.length > 0 && (
            <span className="text-slate-500">{workflowStageSummaries.length} {locale === 'zh' ? '个阶段' : 'stages'}</span>
          )}
          {workflowChecklist.length > 0 && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-200 ring-1 ring-amber-500/25">
              {workflowChecklist.length} {locale === 'zh' ? '待处理' : 'pending'}
            </span>
          )}
        </button>
        {showStageSummary && (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-3">
        <div className="rounded-2xl bg-slate-800/45 ring-1 ring-slate-700/50 px-4 py-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-slate-400">{formText.stageSummary}</span>
            <span className="text-[11px] text-slate-500">{formText.stageSummaryHint}</span>
          </div>
          {workflowStageSummaries.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {workflowStageSummaries.map((summary) => (
                <div
                  key={summary.stage.id}
                  className="rounded-xl bg-slate-900/55 ring-1 ring-slate-800/70 px-3 py-3 flex flex-col gap-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`rounded-full px-2 py-1 text-[10px] ring-1 ${summary.stage.accent}`}>
                      {summary.stage.title}
                    </span>
                    <span className={`rounded-full px-2 py-1 text-[10px] ring-1 ${completionTone(summary.avgCompletion, summary.issueCount)}`}>
                      {summary.avgCompletion}%
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400">{summary.stepCount} {formText.stageNodes}</div>
                  <div className="flex flex-wrap gap-2 text-[11px]">
                    <span className="rounded-full bg-slate-800/80 px-2 py-1 text-slate-300 ring-1 ring-slate-700/60">
                      {formText.stageIssues} {summary.issueCount}
                    </span>
                    <span className="rounded-full bg-slate-800/80 px-2 py-1 text-slate-300 ring-1 ring-slate-700/60">
                      {formText.stagePending} {summary.waitingCount}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {summary.firstStepId && (
                      <button
                        type="button"
                        onClick={() => revealAndFocusStep(summary.firstStepId!)}
                        className="rounded-lg bg-slate-800/80 px-2.5 py-1 text-[11px] text-slate-200 ring-1 ring-slate-700/60 hover:bg-slate-800"
                      >
                        {formText.locateStage}
                      </button>
                    )}
                    {editorMode === 'graph' && summary.stepCount > 1 && (
                      <button
                        type="button"
                        onClick={() => tidyStageNodes(summary.stage.id)}
                        className="rounded-lg bg-fuchsia-500/10 px-2.5 py-1 text-[11px] text-fuchsia-200 ring-1 ring-fuchsia-500/20 hover:bg-fuchsia-500/15"
                      >
                        {formText.tidyStage}
                      </button>
                    )}
                    {summary.actions.map((action) => (
                      <button
                        key={action.id}
                        type="button"
                        onClick={() => revealAndFocusStep(action.stepId)}
                        className="rounded-lg bg-cyan-500/10 px-2.5 py-1 text-[11px] text-cyan-200 ring-1 ring-cyan-500/20 hover:bg-cyan-500/15"
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-slate-500">{formText.stageSummaryEmpty}</div>
          )}
        </div>

        <div className="rounded-2xl bg-slate-800/45 ring-1 ring-slate-700/50 px-4 py-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-slate-400">{formText.checklist}</span>
            <span className="text-[11px] text-slate-500">{formText.checklistHint}</span>
          </div>
          {workflowChecklist.length > 0 ? (
            <div className="flex flex-col gap-2">
              {workflowChecklist.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    if (item.stepId) {
                      revealAndFocusStep(item.stepId);
                    }
                  }}
                  className={`rounded-xl px-3 py-3 text-left ring-1 transition-colors ${
                    item.tone === 'warn'
                      ? 'bg-amber-500/10 ring-amber-500/20 text-amber-100 hover:bg-amber-500/15'
                      : 'bg-slate-900/55 ring-slate-800/70 text-slate-300 hover:bg-slate-900/75'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs">{item.message}</span>
                    {item.stepId && <span className="text-[10px] text-slate-500 font-mono">{item.stepId}</span>}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-xl bg-emerald-500/10 ring-1 ring-emerald-500/20 px-3 py-3 text-xs text-emerald-200">
              {formText.healthy}
            </div>
          )}
        </div>
      </div>
        )}
      </div>

      {/* Input mode toggle */}
      <label className="flex items-center gap-2.5 cursor-pointer select-none">
        <div
          className={`w-9 h-5 rounded-full transition-colors ring-1 ${
            inputRequired ? 'bg-indigo-600 ring-indigo-500/60' : 'bg-slate-700 ring-slate-600'
          }`}
          onClick={() => setInputRequired((v) => !v)}
        >
          <span
            className={`block w-3.5 h-3.5 rounded-full bg-white mt-[3px] transition-transform ${
              inputRequired ? 'translate-x-[18px]' : 'translate-x-[3px]'
            }`}
          />
        </div>
        <span className="text-xs text-slate-400">
          {inputRequired
            ? '运行时需要初始输入 — 可在消息模板中使用 {{input}}'
            : '无需初始输入 — 可直接运行，不显示输入框'}
        </span>
      </label>

      {/* Global variables */}
      <div className="flex flex-col gap-2">
        <button
          onClick={() => setShowGlobals((v) => !v)}
          className="text-xs text-slate-500 hover:text-slate-300 text-left"
        >
          {showGlobals ? '▼' : '▶'} 全局变量 {'{{globals.key}}'}{' '}
          {Object.keys(variables).length > 0 && `(${Object.keys(variables).length})`}
        </button>
        {showGlobals && (
          <div className="rounded-xl bg-slate-800/50 ring-1 ring-slate-700/40 p-3 flex flex-col gap-2">
            {Object.entries(variables).map(([k, v]) => (
              <div key={k} className="grid grid-cols-[1fr_1fr_auto] gap-2 text-xs items-center">
                <span className="font-mono text-slate-400">{k}</span>
                <input
                  className={inputCls}
                  value={v}
                  onChange={(e) => setVariables((prev) => ({ ...prev, [k]: e.target.value }))}
                />
                <button
                  onClick={() =>
                    setVariables((prev) => {
                      const n = { ...prev };
                      delete n[k];
                      return n;
                    })
                  }
                  className="text-slate-600 hover:text-red-400"
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="grid grid-cols-[1fr_1fr_auto] gap-2 text-xs items-center">
              <input
                className={inputCls}
                placeholder="变量名"
                value={newGlobalKey}
                onChange={(e) => setNewGlobalKey(e.target.value)}
              />
              <input
                className={inputCls}
                placeholder="值"
                value={newGlobalVal}
                onChange={(e) => setNewGlobalVal(e.target.value)}
              />
              <button
                onClick={() => {
                  if (!newGlobalKey.trim()) return;
                  setVariables((prev) => ({ ...prev, [newGlobalKey.trim()]: newGlobalVal }));
                  setNewGlobalKey('');
                  setNewGlobalVal('');
                }}
                className="text-indigo-400 hover:text-indigo-300 text-sm"
              >
                ＋
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-400">交付物传播渠道</span>
          <span className="text-[11px] text-slate-500">
            {publicationTargets.length > 0
              ? `已配置 ${publicationTargets.length} 个目标`
              : '未选择时将展示所有可用渠道'}
          </span>
        </div>
        <div className="rounded-xl bg-slate-800/50 ring-1 ring-slate-700/40 p-3 flex flex-col gap-2">
          {channels.length === 0 ? (
            <span className="text-xs text-slate-500">当前没有已注册渠道</span>
          ) : (
            <>
              {publicationTargets.map((target, index) => (
                <div
                  key={`${target.channelId}:${target.threadKey}:${index}`}
                  className="grid grid-cols-[minmax(0,160px)_minmax(0,1fr)_minmax(0,160px)_auto] gap-2 items-center"
                >
                  <select
                    value={target.channelId}
                    onChange={(e) =>
                      setPublicationTargets((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, channelId: e.target.value } : item,
                        ),
                      )
                    }
                    className="rounded-lg bg-slate-900/70 ring-1 ring-slate-700 px-2 py-1.5 text-sm text-slate-100"
                  >
                    {channels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        {channel.name}
                      </option>
                    ))}
                  </select>
                  <input
                    className={`${inputCls} font-mono text-xs`}
                    placeholder="threadKey"
                    value={target.threadKey}
                    onChange={(e) =>
                      setPublicationTargets((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, threadKey: e.target.value } : item,
                        ),
                      )
                    }
                  />
                  <input
                    className={inputCls}
                    placeholder="agentId (optional)"
                    value={target.agentId ?? ''}
                    onChange={(e) =>
                      setPublicationTargets((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, agentId: e.target.value || undefined }
                            : item,
                        ),
                      )
                    }
                  />
                  <button
                    onClick={() =>
                      setPublicationTargets((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                    className="text-slate-600 hover:text-red-400 text-sm"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                onClick={() =>
                  setPublicationTargets((current) => [
                    ...current,
                    {
                      channelId: channels[0]?.id ?? '',
                      threadKey: '',
                    },
                  ])
                }
                className="text-xs text-indigo-400 hover:text-indigo-300 text-left"
              >
                + 添加传播目标
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 rounded-2xl bg-slate-900/50 p-1 ring-1 ring-slate-700/60">
          <button
            type="button"
            onClick={() => {
              setEditorMode('form');
              setConnectionState(null);
            }}
            className={`rounded-xl px-3 py-2 text-xs transition-colors ${
              editorMode === 'form'
                ? 'bg-indigo-500/20 text-indigo-100 ring-1 ring-indigo-500/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {graphText.formMode}
          </button>
          <button
            type="button"
            onClick={() => setEditorMode('graph')}
            className={`rounded-xl px-3 py-2 text-xs transition-colors ${
              editorMode === 'graph'
                ? 'bg-cyan-500/20 text-cyan-100 ring-1 ring-cyan-500/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {graphText.graphMode}
          </button>
        </div>
        <div className="text-[11px] text-slate-500">
          {graphText.compatibility}
        </div>
      </div>

      {editorMode === 'graph' && (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.7fr)_420px] gap-4">
          <div className="rounded-[28px] overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.12),transparent_38%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,0.98))] ring-1 ring-slate-700/60 shadow-[0_20px_80px_rgba(2,6,23,0.45)]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/70 px-4 py-4">
              <div className="flex flex-col gap-1">
                <span className="text-xs uppercase tracking-[0.18em] text-cyan-300">{graphText.canvasTitle}</span>
                <span className="text-sm text-slate-300">{graphText.canvasSubtitle}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1 rounded-xl bg-slate-950/65 px-2 py-1 ring-1 ring-slate-700/60">
                  <button
                    type="button"
                    onClick={() => adjustGraphZoom(-0.1)}
                    className="rounded-lg px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800/80"
                  >
                    －
                  </button>
                  <button
                    type="button"
                    onClick={resetGraphZoom}
                    className="rounded-lg px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800/80"
                  >
                    {Math.round(graphZoom * 100)}%
                  </button>
                  <button
                    type="button"
                    onClick={() => adjustGraphZoom(0.1)}
                    className="rounded-lg px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800/80"
                  >
                    ＋
                  </button>
                  <button
                    type="button"
                    onClick={fitGraphToView}
                    className="rounded-lg px-2 py-1 text-[11px] text-cyan-200 hover:bg-slate-800/80"
                  >
                    {graphText.fitView}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setDesignerLayout({
                      preferredMode: 'graph',
                      positions: buildDefaultWorkflowDesignerPositions(steps),
                    });
                    setConnectionState(null);
                  }}
                  className="rounded-xl bg-slate-900/70 px-3 py-2 text-[11px] text-slate-200 ring-1 ring-slate-700/60 hover:bg-slate-900"
                >
                  {graphText.autoLayout}
                </button>
                {selectedStep && (
                  <button
                    type="button"
                    onClick={() => focusGraphStep(selectedStep.id)}
                    className="rounded-xl bg-slate-900/70 px-3 py-2 text-[11px] text-slate-200 ring-1 ring-slate-700/60 hover:bg-slate-900"
                  >
                    {graphText.locateCurrent}
                  </button>
                )}
                {graphSelectionStepIds.length > 1 && (
                  <button
                    type="button"
                    onClick={tidySelectedNodes}
                    className="rounded-xl bg-fuchsia-500/10 px-3 py-2 text-[11px] text-fuchsia-100 ring-1 ring-fuchsia-500/25 hover:bg-fuchsia-500/15"
                  >
                    {graphText.tidySelected}
                  </button>
                )}
                {selectedStep && selectedStep.type !== 'condition' && (
                  <button
                    type="button"
                    onClick={() => beginNextConnectionFromStep(selectedStep.id)}
                    className={`rounded-xl px-3 py-2 text-[11px] ring-1 transition-colors ${
                      connectionState?.sourceStepId === selectedStep.id && connectionState.mode === 'next'
                        ? 'bg-cyan-500/20 text-cyan-100 ring-cyan-500/30'
                        : 'bg-slate-900/70 text-slate-200 ring-slate-700/60 hover:bg-slate-900'
                    }`}
                  >
                    {connectionState?.sourceStepId === selectedStep.id && connectionState.mode === 'next'
                      ? graphText.cancelMainLink
                      : graphText.startMainLink}
                  </button>
                )}
                {(Object.keys(STEP_TYPE_LABELS) as StepType[]).map((type) => (
                  <button
                    key={`graph-add-${type}`}
                    type="button"
                    onClick={() => {
                      addStep(type);
                      setEditorMode('graph');
                    }}
                    className="rounded-xl bg-slate-900/70 px-3 py-2 text-[11px] text-slate-300 ring-1 ring-slate-700/60 hover:text-slate-100"
                  >
                    + {getStepTypeLabel(type, locale)}
                  </button>
                ))}
              </div>
            </div>

            <div className="border-b border-slate-800/70 px-4 py-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
              <span className="rounded-full bg-slate-900/70 px-2.5 py-1 ring-1 ring-slate-700/60">{graphText.sameCardSize}</span>
              <span className="rounded-full bg-slate-900/70 px-2.5 py-1 ring-1 ring-slate-700/60">{graphText.clickToSelect}</span>
              <span className="rounded-full bg-slate-900/70 px-2.5 py-1 ring-1 ring-slate-700/60">{graphText.marqueeSelect}</span>
              <span className="rounded-full bg-slate-900/70 px-2.5 py-1 ring-1 ring-slate-700/60">{graphText.dragHandle}</span>
              <span className="rounded-full bg-slate-900/70 px-2.5 py-1 ring-1 ring-slate-700/60">{graphText.endNodeHint}</span>
              {graphSelectionStepIds.length > 1 && (
                <span className="rounded-full bg-fuchsia-500/10 px-2.5 py-1 text-fuchsia-200 ring-1 ring-fuchsia-500/20">
                  {graphText.selectedMany.replace('{count}', String(graphSelectionStepIds.length))}
                </span>
              )}
              {connectionDescription && (
                <span className="rounded-full bg-cyan-500/10 px-2.5 py-1 text-cyan-200 ring-1 ring-cyan-500/20">
                  {connectionDescription}
                </span>
              )}
            </div>

            <div ref={graphViewportRef} className="relative min-h-[720px] overflow-auto bg-[linear-gradient(rgba(51,65,85,0.18)_1px,transparent_1px),linear-gradient(90deg,rgba(51,65,85,0.18)_1px,transparent_1px)] [background-size:24px_24px]">
              <div
                className="relative"
                style={{
                  width: `${Math.ceil(graphCanvasMetrics.width * graphZoom)}px`,
                  height: `${Math.ceil(graphCanvasMetrics.height * graphZoom)}px`,
                }}
              >
              <svg
                className="absolute left-0 top-0 pointer-events-none"
                style={{
                  width: `${graphCanvasMetrics.width}px`,
                  height: `${graphCanvasMetrics.height}px`,
                  transform: `scale(${graphZoom})`,
                  transformOrigin: 'top left',
                }}
              >
                <defs>
                  <marker id="arrow-default" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="userSpaceOnUse">
                    <path d="M 0 0 L 8 3 L 0 6 z" fill="rgba(56,189,248,0.85)" />
                  </marker>
                  <marker id="arrow-branch" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="userSpaceOnUse">
                    <path d="M 0 0 L 8 3 L 0 6 z" fill="rgba(244,114,182,0.85)" />
                  </marker>
                  <marker id="arrow-default-sel" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="userSpaceOnUse">
                    <path d="M 0 0 L 8 3 L 0 6 z" fill="rgba(56,189,248,1)" />
                  </marker>
                  <marker id="arrow-branch-sel" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="userSpaceOnUse">
                    <path d="M 0 0 L 8 3 L 0 6 z" fill="rgba(244,114,182,1)" />
                  </marker>
                </defs>
                {graphEdges.map((edge) => {
                  const from = nodePositions[edge.fromStepId];
                  const to =
                    edge.toStepId === GRAPH_END_NODE_ID
                      ? endNodePosition
                      : nodePositions[edge.toStepId];
                  if (!from || !to) {
                    return null;
                  }
                  const startX = from.x + GRAPH_NODE_WIDTH;
                  const startY = from.y + GRAPH_NODE_HEIGHT / 2;
                  const endX = edge.toStepId === GRAPH_END_NODE_ID ? to.x : to.x;
                  const endY =
                    edge.toStepId === GRAPH_END_NODE_ID
                      ? to.y + GRAPH_END_NODE_HEIGHT / 2
                      : to.y + GRAPH_NODE_HEIGHT / 2;
                  const delta = Math.max(72, Math.abs(endX - startX) / 2);
                  const path = `M ${startX} ${startY} C ${startX + delta} ${startY}, ${endX - delta} ${endY}, ${endX} ${endY}`;
                  const labelX = (startX + endX) / 2;
                  const labelY = (startY + endY) / 2;
                  const labelWidth = Math.max(56, (edge.label?.length ?? 0) * 8 + 18);
                  const isSelected = selectedEdgeId === edge.id;
                  const arrowId = isSelected
                    ? `arrow-${edge.tone}-sel`
                    : `arrow-${edge.tone}`;
                  return (
                    <g
                      key={edge.id}
                      style={{ pointerEvents: 'all', cursor: 'pointer' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedEdgeId((prev) => (prev === edge.id ? null : edge.id));
                      }}
                    >
                      {/* Wide transparent hit area for easy clicking */}
                      <path d={path} fill="none" stroke="transparent" strokeWidth={16} />
                      {/* Visible edge path */}
                      <path
                        d={path}
                        fill="none"
                        stroke={
                          isSelected
                            ? edge.tone === 'branch' ? 'rgba(244,114,182,1)' : 'rgba(56,189,248,1)'
                            : edge.tone === 'branch' ? 'rgba(244,114,182,0.75)' : 'rgba(56,189,248,0.7)'
                        }
                        strokeWidth={isSelected ? 3 : edge.tone === 'branch' ? 2 : 2.5}
                        strokeDasharray={edge.tone === 'branch' ? '7 6' : undefined}
                        markerEnd={`url(#${arrowId})`}
                      />
                      {/* Label or action buttons */}
                      {isSelected ? (
                        <g>
                          <g
                            style={{ cursor: 'pointer' }}
                            onClick={(e) => { e.stopPropagation(); deleteEdge(edge.id); }}
                          >
                            <rect x={labelX - 20} y={labelY - 12} width={40} height={24} rx={7}
                              fill="rgba(239,68,68,0.18)" stroke="rgba(239,68,68,0.55)" strokeWidth={1} />
                            <text x={labelX} y={labelY + 5} textAnchor="middle" fontSize="12"
                              fill="rgba(252,165,165,0.95)" fontWeight="700" style={{ userSelect: 'none' }}>✕</text>
                          </g>
                          <g
                            style={{ cursor: 'pointer' }}
                            onClick={(e) => { e.stopPropagation(); reconnectEdge(edge.id); }}
                          >
                            <rect x={labelX + 24} y={labelY - 12} width={48} height={24} rx={7}
                              fill="rgba(56,189,248,0.12)" stroke="rgba(56,189,248,0.45)" strokeWidth={1} />
                            <text x={labelX + 48} y={labelY + 5} textAnchor="middle" fontSize="11"
                              fill="rgba(147,210,249,0.95)" fontWeight="600" style={{ userSelect: 'none' }}>重连</text>
                          </g>
                        </g>
                      ) : edge.label ? (
                        <g>
                          <rect
                            x={labelX - labelWidth / 2}
                            y={labelY - 10}
                            width={labelWidth}
                            height={20}
                            rx={10}
                            fill="rgba(15,23,42,0.92)"
                            stroke="rgba(244,114,182,0.35)"
                          />
                          <text
                            x={labelX}
                            y={labelY + 3}
                            textAnchor="middle"
                            fontSize="10"
                            fill="rgba(251,207,232,0.92)"
                          >
                            {edge.label}
                          </text>
                        </g>
                      ) : null}
                    </g>
                  );
                })}
                {/* A5: Variable data-flow dependency edges (dashed orange) */}
                {dataFlowEdges.map((edge, idx) => {
                  const from = nodePositions[edge.fromStepId];
                  const to =
                    edge.toStepId === GRAPH_END_NODE_ID
                      ? endNodePosition
                      : nodePositions[edge.toStepId];
                  if (!from || !to) return null;
                  const startX = from.x + GRAPH_NODE_WIDTH / 2;
                  const startY = from.y + GRAPH_NODE_HEIGHT;
                  const endX = to.x + GRAPH_NODE_WIDTH / 2;
                  const endY =
                    edge.toStepId === GRAPH_END_NODE_ID
                      ? to.y + GRAPH_END_NODE_HEIGHT / 2
                      : to.y;
                  const delta = Math.max(48, Math.abs(endY - startY) / 2);
                  const path = `M ${startX} ${startY} C ${startX} ${startY + delta}, ${endX} ${endY - delta}, ${endX} ${endY}`;
                  return (
                    <path
                      key={`df-${idx}`}
                      d={path}
                      fill="none"
                      stroke="rgba(251,146,60,0.5)"
                      strokeWidth={1.5}
                      strokeDasharray="5 4"
                    />
                  );
                })}
              </svg>

              <div
                className="relative"
                style={{
                  width: `${graphCanvasMetrics.width}px`,
                  height: `${graphCanvasMetrics.height}px`,
                  transform: `scale(${graphZoom})`,
                  transformOrigin: 'top left',
                }}
                onPointerDown={(event) => {
                  if (event.target !== event.currentTarget) {
                    return;
                  }
                  setSelectedEdgeId(null);
                  beginGraphMarquee(event.pointerId, event.clientX, event.clientY);
                }}
              >
                {graphMarquee && (() => {
                  const selectionBounds = buildGraphSelectionBounds(graphMarquee);
                  return (
                    <div
                      className="absolute rounded-lg border border-cyan-300/70 bg-cyan-400/10"
                      style={{
                        left: `${selectionBounds.left}px`,
                        top: `${selectionBounds.top}px`,
                        width: `${selectionBounds.width}px`,
                        height: `${selectionBounds.height}px`,
                      }}
                    />
                  );
                })()}
                {steps.map((step) => {
                  const position = nodePositions[step.id] ?? { x: 72, y: 72 };
                  const type = step.type ?? 'agent';
                  const issues = stepIssueMap[step.id] ?? [];
                  const completion = buildStepCompletionMetrics(step, issues);
                  const preview = summarizeStepPreview(step, steps, locale).slice(0, 2);
                  const stage = getWorkflowStageMeta(type, locale);
                  const isSelected = selectedStepId === step.id;
                  const isGroupSelected = graphSelectionStepIds.includes(step.id);
                  const isConnectSource = connectionState?.sourceStepId === step.id;
                  const branchCount = step.type === 'condition' ? step.branches?.length ?? 0 : 0;

                  return (
                    <button
                      key={step.id}
                      type="button"
                      onClick={(event) => {
                        if (connectionState && connectionState.sourceStepId !== step.id) {
                          connectSelectedNodeTo(step.id);
                          return;
                        }
                        setConnectionState(null);
                        if (event.metaKey || event.ctrlKey || event.shiftKey) {
                          setGraphSelectionStepIds((current) => {
                            const exists = current.includes(step.id);
                            return exists ? current.filter((value) => value !== step.id) : [...current, step.id];
                          });
                          setSelectedStepId(step.id);
                          return;
                        }
                        setGraphSelectionStepIds([step.id]);
                        focusStep(step.id);
                      }}
                      className={`absolute rounded-[22px] text-left transition-all ${
                        isSelected
                          ? 'ring-2 ring-cyan-300/80 shadow-[0_0_0_1px_rgba(34,211,238,0.35),0_24px_60px_rgba(8,145,178,0.24)]'
                          : isGroupSelected
                            ? 'ring-2 ring-fuchsia-300/70 shadow-[0_0_0_1px_rgba(217,70,239,0.26),0_18px_36px_rgba(88,28,135,0.2)]'
                          : isConnectSource
                            ? 'ring-2 ring-fuchsia-300/80 shadow-[0_0_0_1px_rgba(244,114,182,0.35),0_20px_40px_rgba(131,24,67,0.32)]'
                            : 'ring-1 ring-slate-700/70 hover:ring-slate-500/80 hover:-translate-y-0.5'
                      }`}
                      style={{
                        width: `${GRAPH_NODE_WIDTH}px`,
                        height: `${GRAPH_NODE_HEIGHT}px`,
                        left: `${position.x}px`,
                        top: `${position.y}px`,
                        background:
                          'linear-gradient(160deg, rgba(15,23,42,0.98), rgba(30,41,59,0.92) 62%, rgba(15,23,42,0.98))',
                      }}
                    >
                      {/* A5: Execution status badge overlay */}
                      {(() => {
                        if (!liveRun) return null;
                        const result = liveRun.stepResults?.find((r) => r.stepId === step.id);
                        const isActive = liveRun.status === 'running' && !result?.finishedAt;
                        const badge = result?.error
                          ? { color: 'bg-red-500', label: '✗' }
                          : result?.finishedAt
                            ? { color: 'bg-emerald-500', label: '✓' }
                            : isActive
                              ? { color: 'bg-amber-400 animate-pulse', label: '⬤' }
                              : null;
                        if (!badge) return null;
                        return (
                          <span
                            className={`absolute top-2 right-2 z-10 w-5 h-5 rounded-full text-[9px] flex items-center justify-center text-white font-bold ${badge.color}`}
                            title={result?.error ?? (result?.finishedAt ? '已完成' : '执行中…')}
                          >
                            {badge.label}
                          </span>
                        );
                      })()}
                      <div
                        className="flex items-center justify-between rounded-t-[22px] border-b border-slate-800/80 px-4 py-3 cursor-grab active:cursor-grabbing"
                        onPointerDown={(event) => {
                          event.preventDefault();
                          beginNodeDrag(step.id, event.pointerId, event.clientX, event.clientY);
                        }}
                      >
                        <span className={`rounded-full px-2 py-1 text-[10px] ring-1 ${stage.accent}`}>
                          {getStepTypeLabel(type, locale)}
                        </span>
                        <span className={`rounded-full px-2 py-1 text-[10px] ring-1 ${completionTone(completion.percent, completion.issueCount)}`}>
                          {completion.percent}%
                        </span>
                      </div>
                      <div className="flex h-[calc(100%-53px)] flex-col justify-between px-4 py-3">
                        <div>
                          {editingLabelStepId === step.id ? (
                            <input
                              autoFocus
                              className="w-full rounded-md bg-slate-700/80 px-2 py-0.5 text-sm font-semibold text-slate-100 ring-1 ring-cyan-400/60 outline-none"
                              defaultValue={step.label ?? step.id}
                              onBlur={(e) => {
                                const next = e.target.value.trim();
                                if (next && next !== step.id) {
                                  const idx = stepsRef.current.findIndex((s) => s.id === step.id);
                                  if (idx >= 0) updateStep(idx, { ...stepsRef.current[idx]!, label: next });
                                }
                                setEditingLabelStepId(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                if (e.key === 'Escape') setEditingLabelStepId(null);
                                e.stopPropagation();
                              }}
                              onClick={(e) => e.stopPropagation()}
                            />
                          ) : (
                            <div
                              className="truncate text-sm font-semibold text-slate-100 cursor-pointer"
                              title={locale === 'zh' ? '双击编辑名称' : 'Double-click to edit name'}
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                setEditingLabelStepId(step.id);
                              }}
                            >
                              {step.label ?? step.id}
                            </div>
                          )}
                          <div className="mt-1 text-[11px] text-slate-500 font-mono truncate">{step.id}</div>
                        </div>
                        <div className="flex flex-col gap-1">
                          {preview.length > 0 ? (
                            preview.map((line) => (
                              <div key={line} className="truncate text-[11px] text-slate-400">
                                {line}
                              </div>
                            ))
                          ) : (
                            <div className="text-[11px] text-slate-500">{graphText.configureNode}</div>
                          )}
                        </div>
                        <div className="flex items-center justify-between pt-2 text-[10px] text-slate-500">
                          <span>{issues.length > 0 ? graphText.issueCount.replace('{count}', String(issues.length)) : graphText.runnable}</span>
                          <span>
                            {step.type === 'condition'
                              ? graphText.branches.replace('{count}', String(branchCount))
                              : (step.outputs?.length ?? 0) > 0
                                ? graphText.outputs.replace('{count}', String(step.outputs?.length ?? 0))
                                : graphText.noOutputs}
                          </span>
                        </div>
                      </div>
                    </button>
                  );
                })}

                <button
                  type="button"
                  onClick={() => {
                    if (connectionState) {
                      connectSelectedNodeToEnd();
                    }
                  }}
                  className={`absolute rounded-[22px] text-left transition-all ${
                    connectionState
                      ? 'ring-2 ring-amber-300/80 shadow-[0_0_0_1px_rgba(251,191,36,0.35),0_20px_40px_rgba(120,53,15,0.3)]'
                      : 'ring-1 ring-slate-700/70'
                  }`}
                  style={{
                    width: `${GRAPH_END_NODE_WIDTH}px`,
                    height: `${GRAPH_END_NODE_HEIGHT}px`,
                    left: `${endNodePosition.x}px`,
                    top: `${endNodePosition.y}px`,
                    background:
                      'linear-gradient(160deg, rgba(120,53,15,0.95), rgba(146,64,14,0.88) 60%, rgba(15,23,42,0.96))',
                  }}
                >
                  <div className="flex h-full flex-col justify-between px-4 py-3">
                    <span className="w-fit rounded-full bg-amber-500/15 px-2 py-1 text-[10px] text-amber-100 ring-1 ring-amber-500/30">
                      {graphText.terminal}
                    </span>
                    <div>
                      <div className="text-sm font-semibold text-amber-50">{graphText.endFlow}</div>
                      <div className="mt-1 text-[11px] text-amber-100/80">$end</div>
                    </div>
                    <div className="text-[10px] text-amber-100/70">
                      {connectionState ? graphText.bindToEnd : graphText.canEnd}
                    </div>
                  </div>
                </button>
              </div>
              </div>
              {/* A4: Minimap — sticky bottom-right overview */}
              {(() => {
                const MM_W = 130;
                const MM_H = 90;
                const cw = Math.max(graphCanvasMetrics.width, 1);
                const ch = Math.max(graphCanvasMetrics.height, 1);
                const mmScale = Math.min(MM_W / cw, MM_H / ch);
                const viewport = graphViewportRef.current;
                const vpW = viewport?.clientWidth ?? 800;
                const vpH = viewport?.clientHeight ?? 600;
                const vpRectW = Math.min(MM_W, (vpW / graphZoom) * mmScale);
                const vpRectH = Math.min(MM_H, (vpH / graphZoom) * mmScale);
                const vpRectX = (graphScroll.x / graphZoom) * mmScale;
                const vpRectY = (graphScroll.y / graphZoom) * mmScale;
                return (
                  <div
                    className="sticky bottom-3 z-10 -mt-28 flex justify-end pr-3 pointer-events-none"
                    style={{ height: `${MM_H + 12}px` }}
                  >
                    <svg
                      width={MM_W + 4}
                      height={MM_H + 4}
                      className="rounded-xl ring-1 ring-slate-600/70 bg-slate-900/85 backdrop-blur-sm pointer-events-auto cursor-pointer"
                      title={locale === 'zh' ? '点击跳转到该区域' : 'Click to navigate'}
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const cx = (e.clientX - rect.left - 2) / mmScale;
                        const cy = (e.clientY - rect.top - 2) / mmScale;
                        const vp = graphViewportRef.current;
                        if (!vp) return;
                        vp.scrollTo({
                          left: cx * graphZoom - vp.clientWidth / 2,
                          top: cy * graphZoom - vp.clientHeight / 2,
                          behavior: 'smooth',
                        });
                      }}
                    >
                      <g transform="translate(2,2)">
                        {/* node blobs */}
                        {steps.map((step) => {
                          const pos = nodePositions[step.id] ?? { x: 72, y: 72 };
                          return (
                            <rect
                              key={step.id}
                              x={pos.x * mmScale}
                              y={pos.y * mmScale}
                              width={Math.max(4, GRAPH_NODE_WIDTH * mmScale)}
                              height={Math.max(3, GRAPH_NODE_HEIGHT * mmScale)}
                              rx={2}
                              fill={
                                graphSelectionStepIds.includes(step.id)
                                  ? 'rgba(34,211,238,0.7)'
                                  : 'rgba(100,116,139,0.55)'
                              }
                            />
                          );
                        })}
                        {/* end node blob */}
                        <rect
                          x={endNodePosition.x * mmScale}
                          y={endNodePosition.y * mmScale}
                          width={Math.max(4, GRAPH_END_NODE_WIDTH * mmScale)}
                          height={Math.max(3, GRAPH_END_NODE_HEIGHT * mmScale)}
                          rx={2}
                          fill="rgba(245,158,11,0.5)"
                        />
                        {/* viewport indicator */}
                        <rect
                          x={vpRectX}
                          y={vpRectY}
                          width={vpRectW}
                          height={vpRectH}
                          rx={2}
                          fill="rgba(34,211,238,0.07)"
                          stroke="rgba(34,211,238,0.55)"
                          strokeWidth={1}
                        />
                      </g>
                    </svg>
                  </div>
                );
              })()}
            </div>
          </div>

          <div className="rounded-[28px] bg-slate-900/75 ring-1 ring-slate-700/60 p-4 flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs uppercase tracking-[0.18em] text-slate-500">{graphText.propertyPanel}</span>
                <span className="text-sm text-slate-200">{graphText.propertyPanelBody}</span>
              </div>
              {selectedStep && (
                <button
                  type="button"
                  onClick={() => moveNodeTo(selectedStep.id, buildDefaultWorkflowDesignerPositions([selectedStep])[selectedStep.id] ?? { x: 72, y: 72 })}
                  className="rounded-xl bg-slate-800/80 px-3 py-2 text-[11px] text-slate-200 ring-1 ring-slate-700/60 hover:bg-slate-800"
                >
                  {graphText.resetNode}
                </button>
              )}
            </div>

            {selectedStep ? (
              <>
                <div className="rounded-2xl bg-[linear-gradient(135deg,rgba(6,182,212,0.12),rgba(15,23,42,0.9))] ring-1 ring-cyan-500/15 px-4 py-4 flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-lg px-2.5 py-1 text-xs font-medium ring-1 ${STEP_TYPE_COLORS[selectedStep.type ?? 'agent']}`}>
                      {getStepTypeLabel(selectedStep.type ?? 'agent', locale)}
                    </span>
                    <span className="text-sm font-semibold text-slate-100">{selectedStep.label ?? selectedStep.id}</span>
                  </div>
                  <div className="text-xs text-slate-400">
                    {getStepTypeHelp(selectedStep.type ?? 'agent', locale).summary}
                  </div>
                  <div className="flex flex-wrap gap-2 text-[11px]">
                    <span className="rounded-full bg-slate-900/70 px-2.5 py-1 text-slate-300 ring-1 ring-slate-700/60">
                      {graphText.coordinates
                        .replace('{x}', String(Math.round(nodePositions[selectedStep.id]?.x ?? 0)))
                        .replace('{y}', String(Math.round(nodePositions[selectedStep.id]?.y ?? 0)))}
                    </span>
                    {graphSelectionStepIds.length > 1 && graphSelectionStepIds.includes(selectedStep.id) && (
                      <span className="rounded-full bg-fuchsia-500/10 px-2.5 py-1 text-fuchsia-200 ring-1 ring-fuchsia-500/20">
                        {graphText.multiMove}
                      </span>
                    )}
                    {connectionState?.sourceStepId === selectedStep.id && (
                      <span className="rounded-full bg-fuchsia-500/10 px-2.5 py-1 text-fuchsia-200 ring-1 ring-fuchsia-500/20">
                        {connectionState.mode === 'next'
                          ? graphText.linkingMain
                          : graphText.linkingBranch.replace('{index}', String((connectionState.branchIndex ?? 0) + 1))}
                      </span>
                    )}
                  </div>
                </div>
                {selectedStep.type === 'condition' && (
                  <div className="rounded-2xl bg-slate-800/55 ring-1 ring-slate-700/50 px-4 py-4 flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs uppercase tracking-[0.16em] text-slate-500">{graphText.branchWiring}</span>
                      <button
                        type="button"
                        onClick={() => beginConditionBranchConnection(selectedStep.id, selectedStep.branches?.length ?? 0)}
                        className="rounded-xl bg-fuchsia-500/10 px-3 py-2 text-[11px] text-fuchsia-200 ring-1 ring-fuchsia-500/20 hover:bg-fuchsia-500/15"
                      >
                        {graphText.newBranchLink}
                      </button>
                    </div>
                    {(selectedStep.branches ?? []).length > 0 ? (
                      <div className="flex flex-col gap-2">
                        {(selectedStep.branches ?? []).map((branch, branchIndex) => (
                          <div
                            key={`${selectedStep.id}-branch-${branchIndex}`}
                            className="rounded-xl bg-slate-900/65 ring-1 ring-slate-700/60 px-3 py-3 flex flex-col gap-2"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs text-slate-200">{graphText.branch.replace('{index}', String(branchIndex + 1))}</span>
                              <button
                                type="button"
                                onClick={() => beginConditionBranchConnection(selectedStep.id, branchIndex)}
                                className={`rounded-lg px-2.5 py-1 text-[11px] ring-1 ${
                                  connectionState?.sourceStepId === selectedStep.id &&
                                  connectionState.mode === 'branch' &&
                                  connectionState.branchIndex === branchIndex
                                    ? 'bg-fuchsia-500/20 text-fuchsia-100 ring-fuchsia-500/30'
                                    : 'bg-slate-800/80 text-slate-300 ring-slate-700/60 hover:bg-slate-800'
                                }`}
                              >
                                {connectionState?.sourceStepId === selectedStep.id &&
                                connectionState.mode === 'branch' &&
                                connectionState.branchIndex === branchIndex
                                  ? graphText.cancelBind
                                  : graphText.bindInCanvas}
                              </button>
                            </div>
                            <div className="text-[11px] text-slate-400 break-all">
                              {graphText.conditionSummary}
                            </div>
                            <input
                              className={`${inputCls} text-xs font-mono`}
                              placeholder={graphText.branchExpressionPlaceholder}
                              value={branch.expression}
                              onChange={(event) => {
                                const nextExpression = event.target.value;
                                setSteps((current) =>
                                  current.map((step) => {
                                    if (step.id !== selectedStep.id || step.type !== 'condition') {
                                      return step;
                                    }
                                    const branches = [...(step.branches ?? [])];
                                    const existing = branches[branchIndex] ?? { expression: '', goto: '' };
                                    branches[branchIndex] = { ...existing, expression: nextExpression };
                                    return { ...step, branches };
                                  }),
                                );
                              }}
                            />
                            <div className="text-[11px] text-slate-500 break-all">
                              {graphText.branchTarget.replace('{target}', branch.goto || graphText.targetUnbound)}
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                const branchIndexToEnd = branchIndex;
                                setSteps((current) =>
                                  current.map((step) => {
                                    if (step.id !== selectedStep.id || step.type !== 'condition') {
                                      return step;
                                    }
                                    const branches = [...(step.branches ?? [])];
                                    const existing = branches[branchIndexToEnd] ?? { expression: 'true', goto: '' };
                                    branches[branchIndexToEnd] = { ...existing, goto: '$end' };
                                    return { ...step, branches };
                                  }),
                                );
                                setConnectionState(null);
                              }}
                              className="w-fit rounded-lg bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-200 ring-1 ring-amber-500/20 hover:bg-amber-500/15"
                            >
                              {graphText.bindToFinish}
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-slate-500">{graphText.noBranches}</div>
                    )}
                  </div>
                )}
                <div className="max-h-[920px] overflow-auto pr-1">
                  <StepRow
                    step={selectedStep}
                    index={Math.max(steps.findIndex((step) => step.id === selectedStep.id), 0)}
                    total={steps.length}
                    agents={agents}
                    allSteps={steps}
                    issues={stepIssueMap[selectedStep.id] ?? []}
                    selected={true}
                    collapsed={false}
                    onChange={(updated) => {
                      const index = steps.findIndex((step) => step.id === selectedStep.id);
                      if (index >= 0) {
                        updateStep(index, updated);
                      }
                    }}
                    onMoveUp={() => {
                      const index = steps.findIndex((step) => step.id === selectedStep.id);
                      if (index > 0) {
                        moveUp(index);
                      }
                    }}
                    onMoveDown={() => {
                      const index = steps.findIndex((step) => step.id === selectedStep.id);
                      if (index >= 0 && index < steps.length - 1) {
                        moveDown(index);
                      }
                    }}
                    onInsertBelow={() => {
                      const index = steps.findIndex((step) => step.id === selectedStep.id);
                      if (index >= 0) {
                        insertStepAt(index + 1, selectedStep.type ?? 'agent');
                      }
                    }}
                    onDuplicate={() => {
                      const index = steps.findIndex((step) => step.id === selectedStep.id);
                      if (index >= 0) {
                        duplicateStepAt(index);
                      }
                    }}
                    onRemove={() => {
                      const index = steps.findIndex((step) => step.id === selectedStep.id);
                      if (index >= 0) {
                        removeStep(index);
                      }
                    }}
                    onSelect={() => setSelectedStepId(selectedStep.id)}
                    onToggleCollapse={() => undefined}
                    showCollapseToggle={false}
                  />
                </div>
              </>
            ) : (
              <div className="rounded-2xl bg-slate-800/55 ring-1 ring-slate-700/50 px-4 py-6 text-sm text-slate-400">
                {graphText.pickNode}
              </div>
            )}
          </div>
        </div>
      )}

      {editorMode === 'form' && (
      <>
      {/* Pipeline visualizer */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-slate-400">流程结构</span>
          <span className="text-[11px] text-slate-500">
            {issueStepCount > 0
              ? `${issueStepCount} 个步骤存在诊断问题，可点击节点或下方面板快速定位`
              : '当前未发现可定位的步骤级问题'}
          </span>
        </div>
        {workflowStages.length > 1 && (
          <div className="flex flex-wrap gap-2">
            {workflowStages.map((stage) => (
              <span key={stage.id} className={`rounded-full px-2.5 py-1 text-[11px] ring-1 ${stage.accent}`}>
                {stage.title}
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {steps.map((s, i) => {
          const t: StepType = s.type ?? 'agent';
          const stepIssues = stepIssueMap[s.id] ?? [];
          const selected = selectedStepId === s.id;
          const completion = buildStepCompletionMetrics(s, stepIssues, locale);
          const preview = summarizeStepPreview(s, steps, locale)[0];
          return (
            <div key={s.id} className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => focusStep(s.id)}
                className={`rounded-xl px-3 py-2 text-left min-w-[148px] ring-1 transition-colors ${STEP_TYPE_COLORS[t]} ${
                  selected
                    ? 'ring-2 ring-offset-2 ring-offset-slate-950 ring-white/80'
                    : stepIssues.length > 0
                      ? 'shadow-[0_0_0_1px_rgba(239,68,68,0.45)]'
                      : ''
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-current">{s.label ?? s.id}</span>
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] ring-1 ${completionTone(completion.percent, completion.issueCount)}`}>
                    {completion.percent}%
                  </span>
                </div>
                <div className="mt-1 text-[10px] opacity-80">{getStepTypeLabel(t, locale)}</div>
                <div className="mt-1 text-[10px] opacity-75 truncate">{preview ?? formText.continueConfig}</div>
                {stepIssues.length > 0 && (
                  <div className="mt-1 text-[10px] text-red-100">{formText.issuePending.replace('{count}', String(stepIssues.length))}</div>
                )}
              </button>
              {i < steps.length - 1 && <span className="text-slate-600">→</span>}
            </div>
          );
        })}
        {steps.length === 0 && <span className="text-xs text-slate-600">{formText.noSteps}</span>}
        </div>
        {selectedStep && (
          <div className="rounded-2xl bg-[linear-gradient(135deg,rgba(15,23,42,0.95),rgba(30,41,59,0.86))] ring-1 ring-slate-700/50 px-4 py-4 flex flex-col gap-3 shadow-[0_12px_40px_rgba(15,23,42,0.2)]">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-lg px-2.5 py-1 text-xs font-medium ring-1 ${STEP_TYPE_COLORS[selectedStep.type ?? 'agent']}`}>
                {getStepTypeLabel(selectedStep.type ?? 'agent', locale)}
              </span>
              <span className="text-sm font-semibold text-slate-100">
                {selectedStep.label ?? selectedStep.id}
              </span>
              <span className="text-[11px] text-slate-500 font-mono">{selectedStep.id}</span>
            </div>
            <div className="text-xs text-slate-400">{getStepTypeHelp(selectedStep.type ?? 'agent', locale).summary}</div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
              {summarizeStepPreview(selectedStep, steps, locale).map((line) => (
                <div
                  key={line}
                  className="rounded-lg bg-slate-900/55 px-3 py-2 text-xs text-slate-300 ring-1 ring-slate-800/70"
                >
                  {line}
                </div>
              ))}
              {summarizeStepPreview(selectedStep, steps, locale).length === 0 && (
                <div className="rounded-lg bg-slate-900/40 px-3 py-2 text-xs text-slate-500 ring-1 ring-slate-800/70">
                  {formText.currentStepEmpty}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Steps */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-slate-400">{formText.stepConfig}</span>
          <button
            type="button"
            onClick={() => setAllStepsCollapsed(!allStepsCollapsed)}
            className="rounded-lg bg-slate-900/50 px-3 py-1.5 text-[11px] text-slate-300 ring-1 ring-slate-700/60 hover:text-slate-100"
          >
            {allStepsCollapsed ? formText.expandAll : formText.collapseAll}
          </button>
        </div>
        {steps.map((s, i) => {
          const stage = getWorkflowStageMeta(s.type ?? 'agent', locale);
          const prevStage = i > 0 ? getWorkflowStageMeta(steps[i - 1]?.type ?? 'agent', locale) : null;
          const showStageHeader = i === 0 || prevStage?.id !== stage.id;
          return (
            <div key={s.id} className="flex flex-col gap-2">
              {showStageHeader && (
                <div className="flex items-center gap-3 px-1 pt-1">
                  <span className={`rounded-full px-2.5 py-1 text-[11px] ring-1 ${stage.accent}`}>
                    {stage.title}
                  </span>
                  <div className="h-px flex-1 bg-slate-800/80" />
                </div>
              )}
              <StepRow
                step={s}
                index={i}
                total={steps.length}
                agents={agents}
                allSteps={steps}
                issues={stepIssueMap[s.id] ?? []}
                selected={selectedStepId === s.id}
                collapsed={collapsedStepIds.includes(s.id)}
                onChange={(updated) => updateStep(i, updated)}
                onMoveUp={() => moveUp(i)}
                onMoveDown={() => moveDown(i)}
                onInsertBelow={() => insertStepAt(i + 1, s.type ?? 'agent')}
                onDuplicate={() => duplicateStepAt(i)}
                onRemove={() => removeStep(i)}
                onSelect={() => focusStep(s.id)}
                onToggleCollapse={() => toggleStepCollapse(s.id)}
              />
            </div>
          );
        })}

        {/* Add step buttons */}
        <div className="flex gap-2 flex-wrap">
          {(Object.keys(STEP_TYPE_LABELS) as StepType[]).map((t) => (
            <button
              key={t}
              onClick={() => addStep(t)}
              className={
                'rounded-lg border border-dashed px-3 py-2 text-xs transition-colors border-slate-700 hover:border-indigo-500/40 text-slate-500 hover:text-slate-300'
              }
            >
              + {getStepTypeLabel(t, locale)}
            </button>
          ))}
        </div>
      </div>
      </>
      )}

      {(diagnosisLoading ||
        diagnosisError ||
        diagnosis?.validationError ||
        diagnosis?.validationDiagnostics.length ||
        diagnosis?.graphDiagnostics.length) && (
        <div
          className={`rounded-xl px-4 py-3 flex flex-col gap-2 ring-1 ${
            diagnosisError || diagnosis?.validationError
              ? 'bg-red-500/10 ring-red-500/30'
              : 'bg-amber-500/10 ring-amber-500/30'
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <div
                className={`text-sm font-medium ${
                  diagnosisError || diagnosis?.validationError ? 'text-red-300' : 'text-amber-300'
                }`}
              >
                {diagnosisText.title}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                {diagnosisText.subtitle}
              </div>
            </div>
            {diagnosisLoading && <span className="text-xs text-slate-400">{diagnosisText.loading}</span>}
          </div>

          {diagnosisError && <div className="text-xs text-red-400">{diagnosisError}</div>}
          {!diagnosisError && diagnosis?.validationError && (
            <div className="text-xs text-red-300">{diagnosis.validationError}</div>
          )}
          {!diagnosisError && workflowIssueMessages.length > 0 && (
            <div className="flex flex-col gap-1">
              {workflowIssueMessages.map((message) => (
                <div
                  key={message}
                  className="text-xs text-amber-100 rounded-lg bg-slate-900/40 px-3 py-2"
                >
                  {message}
                </div>
              ))}
            </div>
          )}
          {!diagnosisError &&
            diagnosis &&
            diagnosis.validationDiagnostics
              .filter(
                (diagnostic) =>
                  diagnostic.kind === 'step-validation' || diagnostic.kind === 'step-advisory',
              )
              .map((diagnostic) => (
                <button
                  key={`${diagnostic.stepId}:${diagnostic.message}`}
                  type="button"
                  onClick={() => focusStep(diagnostic.stepId)}
                  className={`text-left text-xs rounded-lg bg-slate-900/40 px-3 py-2 hover:bg-slate-900/70 ${
                    diagnostic.kind === 'step-validation' ? 'text-red-100' : 'text-amber-100'
                  }`}
                >
                  <span
                    className={`font-medium mr-2 ${
                      diagnostic.kind === 'step-validation' ? 'text-red-300' : 'text-amber-300'
                    }`}
                  >
                    {diagnosisText.stepPrefix} {diagnostic.stepId}
                  </span>
                  {diagnostic.message}
                </button>
              ))}
          {!diagnosisError && diagnosis && diagnosis.graphDiagnostics.length > 0 && (
            <div className="flex flex-col gap-1">
              {diagnosis.graphDiagnostics.map((diagnostic, index) => (
                <div
                  key={`${diagnostic.kind}:${index}`}
                  className="text-xs text-slate-300 rounded-lg bg-slate-900/40 px-3 py-2 flex flex-col gap-2"
                >
                  <div>{describeGraphDiagnostic(diagnostic, locale)}</div>
                  <div className="flex flex-wrap gap-2">
                    {getDiagnosticStepIds(diagnostic).map((stepId) => (
                      <button
                        key={`${diagnostic.kind}:${index}:${stepId}`}
                        type="button"
                        onClick={() => focusStep(stepId)}
                        className="rounded-lg bg-slate-800/90 px-2 py-1 text-[11px] text-slate-200 ring-1 ring-slate-700/60 hover:ring-indigo-500/40"
                      >
                        {stepId}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {!diagnosisError &&
            diagnosis &&
            !diagnosis.validationError &&
            diagnosis.validationDiagnostics.length === 0 &&
            diagnosis.graphDiagnostics.length === 0 &&
            !diagnosisLoading && (
            <div className="text-xs text-emerald-400">{diagnosisText.healthy}</div>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <Button size="sm" variant="primary" onClick={handleSave}>
          {workflow ? diagnosisText.save : diagnosisText.create}
        </Button>
      </div>
    </div>
  );
}
