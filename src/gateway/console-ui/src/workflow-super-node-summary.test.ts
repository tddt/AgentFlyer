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
  });

  it('returns null for non-json or non-super-node outputs', () => {
    expect(parseWorkflowSuperNodeStructuredSummary('agent', '{"ok":true}')).toBeNull();
    expect(parseWorkflowSuperNodeStructuredSummary('debate', 'not-json')).toBeNull();
  });
});