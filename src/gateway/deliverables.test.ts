import { describe, expect, it } from 'vitest';
import { type ArtifactRef, buildWorkflowDeliverable } from './deliverables.js';
import type { WorkflowDef, WorkflowRunRecord } from './workflow-backend.js';

function createWorkflow(overrides?: Partial<WorkflowDef>): WorkflowDef {
  return {
    id: 'wf-deliverable',
    name: 'Deliverable Workflow',
    steps: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function createRun(overrides?: Partial<WorkflowRunRecord>): WorkflowRunRecord {
  return {
    runId: 'run-deliverable',
    workflowId: 'wf-deliverable',
    workflowName: 'Deliverable Workflow',
    input: 'input',
    startedAt: 10,
    finishedAt: 20,
    status: 'done',
    stepResults: [],
    ...overrides,
  };
}

describe('buildWorkflowDeliverable', () => {
  it('uses structured super node summary for workflow deliverables when final output is json', () => {
    const workflow = createWorkflow({
      steps: [
        {
          id: 'decision-step',
          type: 'decision',
          agentId: 'coordinator-agent',
          messageTemplate: '生成决策',
          condition: 'on_success',
        },
      ],
    });
    const run = createRun({
      stepResults: [
        {
          stepId: 'decision-step',
          output: JSON.stringify({
            direction: '优先推进华东渠道扩张',
            priority: 'P0',
            executionSteps: ['锁定代理商', '签订季度目标'],
            dependencies: ['区域预算审批'],
            confidence: '高',
            rationale: '需求验证充分，供应链容量可支撑。',
          }),
        },
      ],
    });

    const deliverable = buildWorkflowDeliverable(workflow, run, []);

    expect(deliverable.summary).toContain('结构化决策方案');
    expect(deliverable.summary).toContain('方向:优先推进华东渠道扩张');
    expect(deliverable.previewText).toContain('决策依据: 需求验证充分，供应链容量可支撑。');
    expect(deliverable.previewText).toContain('执行步骤: 锁定代理商 / 签订季度目标');
    expect(deliverable.metadata?.structuredSummary).toBe('true');
  });

  it('mentions missing fields in structured risk review deliverable preview', () => {
    const workflow = createWorkflow({
      steps: [
        {
          id: 'risk-step',
          type: 'risk_review',
          agentId: 'coordinator-agent',
          messageTemplate: '审核风险',
          condition: 'on_success',
        },
      ],
    });
    const run = createRun({
      stepResults: [
        {
          stepId: 'risk-step',
          output: JSON.stringify({
            riskLevel: '高',
            majorRisks: ['核心供应商单点依赖'],
          }),
        },
      ],
    });

    const deliverable = buildWorkflowDeliverable(workflow, run, []);

    expect(deliverable.summary).toContain('风险审核报告');
    expect(deliverable.previewText).toContain('缺失字段: 是否建议继续、整改建议、否决项');
  });

  it('falls back to raw last step text for non-super-node workflows', () => {
    const workflow = createWorkflow({
      steps: [
        {
          id: 'agent-step',
          type: 'agent',
          agentId: 'agent-main',
          messageTemplate: 'hello',
          condition: 'on_success',
        },
      ],
    });
    const run = createRun({
      stepResults: [{ stepId: 'agent-step', output: 'plain text result' }],
    });

    const deliverable = buildWorkflowDeliverable(workflow, run, [] as ArtifactRef[]);

    expect(deliverable.summary).toBe('plain text result');
    expect(deliverable.metadata?.structuredSummary).toBe('false');
  });
});
