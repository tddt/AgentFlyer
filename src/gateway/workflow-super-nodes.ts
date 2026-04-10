export type WorkflowSuperNodeType =
  | 'multi_source'
  | 'debate'
  | 'decision'
  | 'risk_review'
  | 'adjudication';

export interface WorkflowSuperNodeStepLike {
  id: string;
  type?: string;
  label?: string;
  messageTemplate: string;
  agentId?: string;
  participantAgentIds?: string[];
  superNodePrompts?: string[];
  domainRules?: string;
}

export interface WorkflowSuperNodeParticipantResult {
  agentId: string;
  prompt: string;
  output?: string;
  error?: string;
}

const DEFAULT_PROMPTS: Record<WorkflowSuperNodeType, string[]> = {
  multi_source: ['政策与监管', '市场与竞争', '资本与财务', '用户与渠道'],
  debate: ['支持推进', '谨慎反对', '中立校准'],
  decision: ['目标拆解', '资源约束', '执行节奏'],
  risk_review: ['合规风险', '经营风险', '执行风险'],
  adjudication: ['战略优先级', '资源配置', '责任落位'],
};

export function isWorkflowSuperNodeType(type?: string): type is WorkflowSuperNodeType {
  return (
    type === 'multi_source' ||
    type === 'debate' ||
    type === 'decision' ||
    type === 'risk_review' ||
    type === 'adjudication'
  );
}

export function normalizeWorkflowSuperNodePrompts(
  type: WorkflowSuperNodeType,
  prompts: string[] | undefined,
): string[] {
  const normalized = (prompts ?? []).map((item) => item.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : DEFAULT_PROMPTS[type];
}

export function requiresWorkflowSuperNodeParticipants(type: WorkflowSuperNodeType): boolean {
  return type === 'multi_source' || type === 'debate' || type === 'risk_review';
}

export function minimumWorkflowSuperNodeParticipants(type: WorkflowSuperNodeType): number {
  if (type === 'debate') {
    return 2;
  }
  return requiresWorkflowSuperNodeParticipants(type) ? 1 : 0;
}

function describeSuperNodeRole(
  type: WorkflowSuperNodeType,
  rolePrompt: string,
  index: number,
): string {
  switch (type) {
    case 'multi_source':
      return `信息采集维度 ${index + 1}: ${rolePrompt}`;
    case 'debate':
      return `辩论立场 ${index + 1}: ${rolePrompt}`;
    case 'decision':
      return `决策补充视角 ${index + 1}: ${rolePrompt}`;
    case 'risk_review':
      return `风险审核视角 ${index + 1}: ${rolePrompt}`;
    case 'adjudication':
      return `裁定参考视角 ${index + 1}: ${rolePrompt}`;
  }
}

export function buildWorkflowSuperNodeParticipantPrompt(params: {
  type: WorkflowSuperNodeType;
  baseMessage: string;
  rolePrompt: string;
  index: number;
  total: number;
  domainRules?: string;
}): string {
  const { type, baseMessage, rolePrompt, index, total, domainRules } = params;
  const role = describeSuperNodeRole(type, rolePrompt, index);
  const domainRuleBlock = domainRules?.trim() ? `\n行业规则 / 约束:\n${domainRules.trim()}\n` : '';

  switch (type) {
    case 'multi_source':
      return `你正在执行“多源信息采集节点”的子任务。\n${role}\n总参与智能体数: ${total}\n${domainRuleBlock}\n主任务:\n${baseMessage}\n\n请只从当前维度出发，输出结构化采集结果，至少包含:\n1. 核心数据\n2. 趋势信号\n3. 异常点\n4. 对业务判断的影响\n\n请不要重复其它维度的结论。`;
    case 'debate':
      return `你正在执行“多维对抗辩论节点”的子任务。\n${role}\n总参与智能体数: ${total}\n${domainRuleBlock}\n辩题 / 议题:\n${baseMessage}\n\n请从该立场出发进行有攻击性的论证，但必须基于证据，输出:\n1. 核心观点\n2. 对其他立场最强反驳\n3. 自身立场的前提条件\n4. 不可忽略的风险或机会`;
    case 'decision':
      return `你正在执行“决策生成节点”的并行补充分析。\n${role}\n总参与智能体数: ${total}\n${domainRuleBlock}\n主任务:\n${baseMessage}\n\n请围绕落地方案给出结构化建议，至少包含:\n1. 方向\n2. 优先级\n3. 执行步骤\n4. 关键依赖\n5. 置信度判断依据`;
    case 'risk_review':
      return `你正在执行“风险审核节点”的子任务。\n${role}\n总参与智能体数: ${total}\n${domainRuleBlock}\n待审核方案:\n${baseMessage}\n\n请输出:\n1. 风险等级\n2. 风险触发条件\n3. 整改建议\n4. 否决项（如存在）`;
    case 'adjudication':
      return `你正在执行“裁定节点”的参考分析子任务。\n${role}\n总参与智能体数: ${total}\n${domainRuleBlock}\n待裁定事项:\n${baseMessage}\n\n请输出:\n1. 建议拍板方向\n2. 资源与责任倾向\n3. 关键落地节点\n4. 不拍板的代价`;
  }
}

export function buildWorkflowSuperNodeCoordinatorPrompt(params: {
  step: WorkflowSuperNodeStepLike;
  participantResults: WorkflowSuperNodeParticipantResult[];
  baseMessage: string;
  previousOutput: string;
}): string {
  const { step, participantResults, baseMessage, previousOutput } = params;
  const type = step.type;
  if (!isWorkflowSuperNodeType(type)) {
    return baseMessage;
  }

  const evidence = participantResults
    .map(
      (item, index) =>
        `### 子结果 ${index + 1}\nagentId: ${item.agentId}\nrole: ${item.prompt}\nstatus: ${item.error ? 'error' : 'ok'}\n\n${item.error ?? item.output ?? ''}`,
    )
    .join('\n\n');
  const domainRuleBlock = step.domainRules?.trim()
    ? `\n行业规则 / 约束:\n${step.domainRules.trim()}\n`
    : '';
  const previousOutputBlock = previousOutput.trim()
    ? `\n上一步输出:\n${previousOutput.trim()}\n`
    : '';

  switch (type) {
    case 'multi_source':
      return `你正在作为“多源信息采集节点”的总协调者。\n请整合以下多维采集结果，输出“行业信息整合包”。${domainRuleBlock}${previousOutputBlock}\n主任务:\n${baseMessage}\n\n最终结果必须覆盖：核心数据、趋势信号、异常点、综合判断。请遵循当前节点已经配置的输出格式要求。\n\n以下是各子结果:\n${evidence}`;
    case 'debate':
      return `你正在作为“多维对抗辩论节点”的主持与纪要整理者。\n请综合各立场辩论结果，输出“对抗辩论纪要”。${domainRuleBlock}${previousOutputBlock}\n辩题:\n${baseMessage}\n\n最终结果必须覆盖：核心观点、分歧点、共识结论、待补证据。请遵循当前节点已经配置的输出格式要求。\n\n以下是各子结果:\n${evidence}`;
    case 'decision':
      return `你正在执行“决策生成节点”。\n请结合辩论结论、补充分析与行业规则，输出“结构化决策方案”。${domainRuleBlock}${previousOutputBlock}\n任务:\n${baseMessage}\n\n最终结果必须覆盖：方向、优先级、执行步骤、关键依赖、置信度。请遵循当前节点已经配置的输出格式要求。\n\n以下是可用输入:\n${evidence || '（无额外并行子结果）'}`;
    case 'risk_review':
      return `你正在作为“风险审核节点”的总协调者。\n请基于并行风险审核结果与行业规则，输出“风险审核报告”。${domainRuleBlock}${previousOutputBlock}\n待审核方案:\n${baseMessage}\n\n最终结果必须覆盖：风险等级、主要风险、整改建议、否决项、是否建议进入裁定。请遵循当前节点已经配置的输出格式要求。\n\n以下是各子结果:\n${evidence}`;
    case 'adjudication':
      return `你正在执行“裁定节点”，需要基于全局视角做最终拍板。\n请综合风控结果、参考分析与行业规则，输出“最终执行方案”。${domainRuleBlock}${previousOutputBlock}\n待裁定事项:\n${baseMessage}\n\n最终结果必须覆盖：拍板结果、责任分配、落地节点、继续观察项。请遵循当前节点已经配置的输出格式要求。\n\n以下是各子结果:\n${evidence || '（无额外并行子结果）'}`;
  }
}
