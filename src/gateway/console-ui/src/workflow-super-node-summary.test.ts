import { describe, expect, it } from 'vitest';
import { parseWorkflowSuperNodeStructuredSummary } from './workflow-super-node-summary.js';

describe('parseWorkflowSuperNodeStructuredSummary', () => {
  it('extracts multi_source structured sections from JSON output', () => {
    const summary = parseWorkflowSuperNodeStructuredSummary(
      'multi_source',
      JSON.stringify({
        coreData: ['订单增长 24%', '客单价提升 8%'],
        signals: ['渠道转化率回升'],
        anomalies: ['华东退货率偏高'],
        synthesis: '当前增长来自促销与新品双轮驱动。',
        recommendedActions: ['追踪高退货 SKU', '加码复购运营'],
      }),
    );

    expect(summary).toEqual({
      title: '行业信息整合包',
      highlights: [],
      texts: [{ label: '综合判断', value: '当前增长来自促销与新品双轮驱动。' }],
      lists: [
        { label: '核心数据', items: ['订单增长 24%', '客单价提升 8%'] },
        { label: '趋势信号', items: ['渠道转化率回升'] },
        { label: '异常点', items: ['华东退货率偏高'] },
        { label: '建议动作', items: ['追踪高退货 SKU', '加码复购运营'] },
      ],
      missingFields: [],
    });
  });

  it('extracts decision highlights and lists from JSON output', () => {
    const summary = parseWorkflowSuperNodeStructuredSummary(
      'decision',
      JSON.stringify({
        direction: '优先推进华东渠道扩张',
        priority: 'P0',
        executionSteps: ['锁定代理商', '签订季度目标'],
        dependencies: ['区域预算审批'],
        confidence: '高',
        rationale: '需求验证充分，供应链容量可支撑。',
      }),
    );

    expect(summary?.title).toBe('结构化决策方案');
    expect(summary?.highlights).toEqual([
      { label: '方向', value: '优先推进华东渠道扩张' },
      { label: '优先级', value: 'P0' },
      { label: '置信度', value: '高' },
    ]);
    expect(summary?.texts).toEqual([{ label: '决策依据', value: '需求验证充分，供应链容量可支撑。' }]);
    expect(summary?.lists).toEqual([
      { label: '执行步骤', items: ['锁定代理商', '签订季度目标'] },
      { label: '关键依赖', items: ['区域预算审批'] },
    ]);
    expect(summary?.missingFields).toEqual([]);
  });

  it('reports missing structured fields when json is incomplete', () => {
    const summary = parseWorkflowSuperNodeStructuredSummary(
      'risk_review',
      JSON.stringify({
        riskLevel: '高',
        majorRisks: ['核心供应商单点依赖'],
      }),
    );

    expect(summary?.title).toBe('风险审核报告');
    expect(summary?.highlights).toEqual([{ label: '风险等级', value: '高' }]);
    expect(summary?.lists).toEqual([{ label: '主要风险', items: ['核心供应商单点依赖'] }]);
    expect(summary?.missingFields).toEqual(['是否建议继续', '整改建议', '否决项']);
  });

  it('adds collaboration execution summary when super node trace is provided', () => {
    const summary = parseWorkflowSuperNodeStructuredSummary(
      'decision',
      JSON.stringify({
        direction: '优先推进华东渠道扩张',
        priority: 'P0',
        executionSteps: ['锁定代理商'],
        dependencies: ['区域预算审批'],
        confidence: '高',
        rationale: '需求验证充分。',
      }),
      {
        type: 'decision',
        parentRunId: 'run-1',
        parentStepId: 'decide',
        participantExecution: 'reused',
        coordinatorAttempt: 2,
        coordinatorAgentId: 'coordinator-agent',
        coordinatorLineage: {
          parentRunId: 'run-1',
          parentStepId: 'decide',
          childStepId: 'decide:coordinator',
          threadKey: 'workflow:run-1:step0:coordinator',
          role: 'coordinator',
        },
        coordinatorStatus: 'done',
        coordinatorStartedAt: 1000,
        coordinatorFinishedAt: 1800,
        participantResults: [
          {
            agentId: 'planner-a',
            prompt: '目标拆解',
            status: 'done',
            startedAt: 100,
            finishedAt: 600,
            lineage: {
              parentRunId: 'run-1',
              parentStepId: 'decide',
              childStepId: 'decide:participant:1',
              threadKey: 'workflow:run-1:step0:participant-1',
              role: 'participant',
              participantIndex: 1,
            },
            output: 'ok',
          },
          {
            agentId: 'planner-b',
            prompt: '资源约束',
            status: 'error',
            startedAt: 120,
            finishedAt: 420,
            lineage: {
              parentRunId: 'run-1',
              parentStepId: 'decide',
              childStepId: 'decide:participant:2',
              threadKey: 'workflow:run-1:step0:participant-2',
              role: 'participant',
              participantIndex: 2,
            },
            error: 'budget missing',
          },
        ],
      },
    );

    expect(summary?.highlights).toEqual([
      { label: '参与者', value: '1/2 完成' },
      { label: '参与者执行', value: '复用' },
      { label: '协调尝试', value: '第 2 次' },
      { label: '失败数', value: '1' },
      { label: '协调器', value: '已完成' },
      { label: '方向', value: '优先推进华东渠道扩张' },
      { label: '优先级', value: 'P0' },
      { label: '置信度', value: '高' },
    ]);
    expect(summary?.texts).toEqual([
      {
        label: '协作执行',
        value: '参与者完成 1/2，失败 1，复用上次参与者结果，协调器第 2 次尝试，协调器已完成，耗时区间 300ms - 800ms。',
      },
      { label: '决策依据', value: '需求验证充分。' },
    ]);
  });

  it('returns null for non-json or non-super-node outputs', () => {
    expect(parseWorkflowSuperNodeStructuredSummary('agent', '{"ok":true}')).toBeNull();
    expect(parseWorkflowSuperNodeStructuredSummary('debate', 'not-json')).toBeNull();
  });
});