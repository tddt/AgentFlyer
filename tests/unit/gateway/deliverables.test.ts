import { describe, expect, it } from 'vitest';
import type { ContentItem } from '../../../src/gateway/content-store.js';
import {
  DeliverableStore,
  buildDeliverableStats,
  buildSchedulerDeliverable,
  buildWorkflowDeliverable,
  createTextArtifact,
  findRecentArtifacts,
  makeSchedulerRunKey,
} from '../../../src/gateway/deliverables.js';

describe('gateway deliverables', () => {
  it('builds a workflow deliverable with text and file artifacts', () => {
    const deliverable = buildWorkflowDeliverable(
      {
        id: 'wf-1',
        name: 'Research Flow',
        steps: [{ id: 'step-1', messageTemplate: 'hi', condition: 'any', agentId: 'main' }],
        createdAt: 1,
        updatedAt: 1,
      },
      {
        runId: 'run-1',
        workflowId: 'wf-1',
        workflowName: 'Research Flow',
        input: 'topic',
        startedAt: 10,
        finishedAt: 20,
        status: 'done',
        stepResults: [{ stepId: 'step-1', output: '# Report\n\nDone.' }],
      },
      [createTextArtifact('notes.md', '# Notes', 20, 'markdown')],
      [
        {
          id: 'channel:feishu',
          kind: 'channel',
          targetId: 'feishu',
          label: 'Feishu',
          mode: 'artifact',
          status: 'available',
        },
      ],
    );

    expect(deliverable.source.kind).toBe('workflow_run');
    expect(deliverable.artifacts).toHaveLength(3);
    expect(deliverable.primaryArtifactId).toBe(deliverable.artifacts[0]?.id);
    expect(deliverable.artifacts[1]?.role).toBe('step-output');
    expect(deliverable.publications).toHaveLength(1);
    expect(deliverable.summary.length).toBeGreaterThan(0);
  });

  it('filters recent content items into artifact refs', () => {
    const items: ContentItem[] = [
      {
        id: 'a',
        agentId: 'main',
        name: 'report.md',
        filePath: '/tmp/report.md',
        mimeType: 'text/markdown',
        type: 'file',
        size: 120,
        createdAt: 1_500,
      },
      {
        id: 'b',
        agentId: 'other',
        name: 'ignore.txt',
        filePath: '/tmp/ignore.txt',
        mimeType: 'text/plain',
        type: 'file',
        size: 30,
        createdAt: 1_500,
      },
    ];

    const artifacts = findRecentArtifacts(items, ['main'], 1_000, 2_000);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.contentItemId).toBe('a');
  });

  it('persists deliverable records newest first', async () => {
    const dataDir = await import('node:fs/promises').then((fs) =>
      fs.mkdtemp(`${process.cwd().replace(/\\/g, '/')}/tmp-deliverables-`),
    );
    const store = new DeliverableStore(dataDir);

    const first = await store.create(
      buildSchedulerDeliverable({
        task: {
          id: 'task-1',
          name: 'Daily Brief',
          message: 'run',
          cronExpr: '0 * * * *',
          createdAt: 1,
          runCount: 0,
        },
        startedAt: 100,
        finishedAt: 200,
        ok: true,
        result: 'done',
        fileArtifacts: [],
        publications: [
          {
            id: 'system:logs',
            kind: 'system',
            targetId: 'logs',
            label: 'Gateway Logs',
            mode: 'summary',
            status: 'planned',
          },
        ],
      }),
    );
    const second = await store.create(
      buildSchedulerDeliverable({
        task: {
          id: 'task-2',
          name: 'Nightly Brief',
          message: 'run',
          cronExpr: '0 * * * *',
          createdAt: 1,
          runCount: 0,
        },
        startedAt: 300,
        finishedAt: 400,
        ok: false,
        result: 'Error: failed',
        fileArtifacts: [],
      }),
    );

    const all = await store.list();
    expect(all[0]?.id).toBe(second.id);
    expect(await store.get(first.id)).not.toBeNull();

    await import('node:fs/promises').then((fs) => fs.rm(dataDir, { recursive: true, force: true }));
  });

  it('upserts by source fingerprint instead of duplicating the same run', async () => {
    const dataDir = await import('node:fs/promises').then((fs) =>
      fs.mkdtemp(`${process.cwd().replace(/\\/g, '/')}/tmp-deliverables-upsert-`),
    );
    const store = new DeliverableStore(dataDir);

    const first = await store.upsert(
      buildSchedulerDeliverable({
        task: {
          id: 'task-1',
          name: 'Daily Brief',
          message: 'run',
          cronExpr: '0 * * * *',
          createdAt: 1,
          runCount: 0,
        },
        startedAt: 100,
        finishedAt: 200,
        ok: true,
        result: 'done',
        fileArtifacts: [],
        publications: [
          {
            id: 'system:logs',
            kind: 'system',
            targetId: 'logs',
            label: 'Gateway Logs',
            mode: 'summary',
            status: 'planned',
          },
        ],
      }),
    );

    const second = await store.upsert({
      ...buildSchedulerDeliverable({
        task: {
          id: 'task-1',
          name: 'Daily Brief',
          message: 'run',
          cronExpr: '0 * * * *',
          createdAt: 1,
          runCount: 0,
        },
        startedAt: 100,
        finishedAt: 240,
        ok: true,
        result: 'done again',
        fileArtifacts: [],
      }),
      previewText: 'changed',
    });

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(first.id).toBe(second.id);
    expect(all[0]?.source.kind).toBe('scheduler_task_run');
    expect(all[0]?.publications?.[0]?.targetId).toBe('logs');
    expect(all[0]?.source.kind === 'scheduler_task_run' ? all[0].source.runKey : '').toBe(
      makeSchedulerRunKey('task-1', 100),
    );

    await import('node:fs/promises').then((fs) => fs.rm(dataDir, { recursive: true, force: true }));
  });

  it('builds deliverable stats for workflow and scheduler runs', () => {
    const stats = buildDeliverableStats([
      {
        id: 'd1',
        title: 'Workflow Deliverable',
        summary: 'workflow',
        previewText: 'workflow',
        status: 'ready',
        source: {
          kind: 'workflow_run',
          workflowId: 'wf-1',
          workflowName: 'Research Flow',
          runId: 'run-1',
        },
        artifacts: [createTextArtifact('workflow.txt', 'hello', 10)],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'd2',
        title: 'Scheduler Deliverable',
        summary: 'scheduler',
        previewText: 'scheduler',
        status: 'error',
        source: {
          kind: 'scheduler_task_run',
          taskId: 'task-1',
          taskName: 'Daily Brief',
          runKey: 'task-1:100',
          startedAt: 100,
          finishedAt: 200,
        },
        artifacts: [
          {
            id: 'a1',
            name: 'report.md',
            format: 'markdown',
            filePath: '/tmp/report.md',
            createdAt: 10,
          },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

    expect(stats.total).toBe(2);
    expect(stats.ready).toBe(1);
    expect(stats.error).toBe(1);
    expect(stats.workflowRuns).toBe(1);
    expect(stats.schedulerRuns).toBe(1);
    expect(stats.totalArtifacts).toBe(2);
    expect(stats.textualArtifacts).toBe(1);
    expect(stats.fileArtifacts).toBe(1);
  });
});
