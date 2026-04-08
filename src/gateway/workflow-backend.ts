/**
 * Server-side workflow engine.
 *
 * Workflows are persisted to `<dataDir>/workflows.json`.
 * Run records are persisted to `<dataDir>/workflow-runs.json` (last 100 runs).
 * In-progress runs are read directly from workflow-kernel live snapshots.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../core/logger.js';
import { publishDeliverableTargets } from './deliverable-publication.js';
import {
  type DeliverablePublicationTarget,
  buildWorkflowDeliverable,
  findRecentArtifacts,
} from './deliverables.js';
import type { RpcContext } from './rpc.js';
import { WorkflowKernelService } from './workflow-kernel.js';

const logger = createLogger('gateway:workflow');

// ── Domain types (shared with frontend via types.ts) ─────────────────────────

/** Supported node types. */
export type StepType = 'agent' | 'transform' | 'condition' | 'http';

/**
 * A named variable extracted from a step's output.
 * After the step runs, `{{vars.<stepId>.<name>}}` is substituted in later templates.
 */
export interface StepOutputVar {
  /** Variable name, referenced as {{vars.<stepId>.<name>}} */
  name: string;
  /** JSONPath expression to extract from JSON output (e.g. "$.result") */
  jsonPath?: string;
  /** Regex: first capture group from the step's output text */
  regex?: string;
  /** JS expression body: receives (output, vars, globals) and must return string. */
  transform?: string;
}

/**
 * One branch in a 'condition' step.
 * `expression` is a JS snippet evaluated with `vars` in scope (return truthy to match).
 * `goto` is a step id or the special token '$end' to finish the workflow.
 */
export interface ConditionBranch {
  expression: string;
  goto: string;
}

export interface WorkflowStep {
  id: string;
  /** Node type — defaults to 'agent' for backward compatibility. */
  type?: StepType;
  /** Explicit next step id or '$end'; falls back to array order when omitted. */
  nextStepId?: string;
  /** Required for 'agent' steps. */
  agentId?: string;
  label?: string;
  /**
   * Template / body string.
   * For 'agent': message sent to the agent.
   * For 'transform': JS expression body → `(vars) => <expression>` (must return string).
   * For 'http': body template (JSON string).
   * Supported placeholders: {{input}}, {{prev_output}}, {{step_N_output}}, {{vars.<id>.<name>}}
   */
  messageTemplate: string;
  /** 'any' = run always; 'on_success' = halt pipeline on error */
  condition: 'any' | 'on_success';
  /** Max automatic retries on error (default 0). */
  maxRetries?: number;
  /** Named variables extracted from this step's output. */
  outputs?: StepOutputVar[];
  /**
   * Branches for 'condition' steps.
   * Evaluated top-to-bottom; first matching branch wins.
   * Falls through to the next step in array order if no branch matches.
   */
  branches?: ConditionBranch[];
  // ── 'http' step fields ──────────────────────────────────────────────────
  url?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  /** Template for the HTTP request body (same placeholder support as messageTemplate). */
  bodyTemplate?: string;
  // ── 'transform' step fields ─────────────────────────────────────────────
  /** JS expression body for transform steps. Replaces messageTemplate for 'transform' type. */
  transformCode?: string;
  // ── output format constraint (agent steps) ───────────────────────────────
  /** Preset format or 'custom' for a user-defined instruction appended to the message. */
  outputFormat?: 'text' | 'json' | 'markdown' | 'custom';
  /** Appended verbatim to the agent message when outputFormat === 'custom'. */
  outputFormatPrompt?: string;
  /** How the format instruction is applied: 'append' (default) adds at end; 'prepend' adds before message. */
  outputFormatMode?: 'append' | 'prepend';
}

export interface WorkflowDef {
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  publicationTargets?: Array<{
    channelId: string;
    threadKey: string;
    agentId?: string;
  }>;
  publicationChannels?: string[];
  /** Global constants available as {{globals.<key>}} in any template. */
  variables?: Record<string, string>;
  /** ID of the first step to execute (defaults to steps[0].id). */
  entryStepId?: string;
  /** When explicitly false, the run panel skips the input form and allows direct execution. */
  inputRequired?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowStepResult {
  stepId: string;
  /** Streaming-in-progress or final output text. */
  output?: string;
  error?: string;
  /** Flat snapshot of ALL named variables accumulated up to this step: "stepId.varName" → value */
  varsSnapshot?: Record<string, string>;
}

export interface WorkflowRunRecord {
  runId: string;
  workflowId: string;
  workflowName: string;
  input: string;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'done' | 'error' | 'cancelled';
  stepResults: WorkflowStepResult[];
  latestDeliverableId?: string;
}

const workflowKernelServices = new WeakMap<RpcContext, Promise<WorkflowKernelService>>();

// ── File helpers ─────────────────────────────────────────────────────────────

function workflowsFile(dataDir: string): string {
  return join(dataDir, 'workflows.json');
}

function workflowRunsFile(dataDir: string): string {
  return join(dataDir, 'workflow-runs.json');
}

export async function readWorkflowsFile(dataDir: string): Promise<WorkflowDef[]> {
  const f = workflowsFile(dataDir);
  if (!existsSync(f)) return [];
  try {
    return JSON.parse(await readFile(f, 'utf-8')) as WorkflowDef[];
  } catch {
    return [];
  }
}

async function writeWorkflowsFile(dataDir: string, workflows: WorkflowDef[]): Promise<void> {
  await writeFile(workflowsFile(dataDir), JSON.stringify(workflows, null, 2), 'utf-8');
}

async function readWorkflowRunsFile(dataDir: string): Promise<WorkflowRunRecord[]> {
  const f = workflowRunsFile(dataDir);
  if (!existsSync(f)) return [];
  try {
    return JSON.parse(await readFile(f, 'utf-8')) as WorkflowRunRecord[];
  } catch {
    return [];
  }
}

async function writeWorkflowRunsFile(dataDir: string, runs: WorkflowRunRecord[]): Promise<void> {
  await writeFile(workflowRunsFile(dataDir), JSON.stringify(runs, null, 2), 'utf-8');
}

/** Upsert run into the persistent runs file and cap at 100 records. */
async function persistRun(dataDir: string, run: WorkflowRunRecord): Promise<void> {
  const existing = await readWorkflowRunsFile(dataDir);
  const filtered = existing.filter((r) => r.runId !== run.runId);
  const updated = [run, ...filtered].slice(0, 100);
  await writeWorkflowRunsFile(dataDir, updated);
}

async function createWorkflowDeliverableRecord(
  ctx: RpcContext,
  workflow: WorkflowDef,
  run: WorkflowRunRecord,
): Promise<void> {
  if (run.latestDeliverableId) return;

  const finishedAt = run.finishedAt ?? Date.now();
  const agentIds = Array.from(
    new Set(
      workflow.steps.map((step) => step.agentId).filter((agentId): agentId is string => !!agentId),
    ),
  );
  const contentItems = agentIds.length > 0 ? await ctx.contentStore.list() : [];
  const fileArtifacts = findRecentArtifacts(contentItems, agentIds, run.startedAt, finishedAt);
  const publicationTargets = workflow.publicationTargets;
  const publicationChannelIds = workflow.publicationChannels;
  const configuredTargets =
    publicationTargets?.flatMap((target) => {
      const channel = ctx.channels.get(target.channelId);
      return channel ? [{ target, channel }] : [];
    }) ?? [];
  const publications: DeliverablePublicationTarget[] =
    configuredTargets.length > 0
      ? configuredTargets.map(({ target, channel }) => ({
          id: `channel:${channel.id}:${target.threadKey}`,
          kind: 'channel',
          targetId: channel.id,
          label: `${channel.name} · ${target.threadKey}`,
          mode: fileArtifacts.length > 0 && channel.sendAttachment ? 'artifact' : 'summary',
          status: 'planned',
          threadKey: target.threadKey,
          agentId: target.agentId,
          detail: target.agentId
            ? `Planned for thread ${target.threadKey} using agent ${target.agentId}.`
            : `Planned for thread ${target.threadKey}.`,
        }))
      : (publicationChannelIds && publicationChannelIds.length > 0
          ? publicationChannelIds
              .map((channelId) => ctx.channels.get(channelId))
              .filter((channel): channel is NonNullable<typeof channel> => !!channel)
          : Array.from(ctx.channels.values())
        ).map((channel) => ({
          id: `channel:${channel.id}`,
          kind: 'channel',
          targetId: channel.id,
          label: channel.name,
          mode: fileArtifacts.length > 0 && channel.sendAttachment ? 'artifact' : 'summary',
          status:
            publicationChannelIds && publicationChannelIds.length > 0 ? 'planned' : 'available',
          detail:
            fileArtifacts.length > 0 && !channel.sendAttachment
              ? 'This channel can receive a summary, but attachment upload is not implemented.'
              : fileArtifacts.length > 0
                ? 'This channel can receive workflow artifacts.'
                : 'This channel can receive a summary view of the workflow deliverable.',
        }));
  const deliverable = await ctx.deliverableStore.upsert(
    buildWorkflowDeliverable(workflow, run, fileArtifacts, publications),
  );
  await publishDeliverableTargets(ctx, deliverable);
  const latestDeliverable = (await ctx.deliverableStore.get(deliverable.id)) ?? deliverable;
  ctx.inboxBroadcaster?.publish({
    kind: 'deliverable',
    title: `${workflow.name} deliverable ready`,
    text: latestDeliverable.summary || latestDeliverable.previewText || latestDeliverable.title,
    deliverableId: latestDeliverable.id,
    publicationSummary: latestDeliverable.publications
      ?.map((item) => `${item.label}:${item.status}`)
      .join(' · '),
  });
  run.latestDeliverableId = deliverable.id;
}

function cloneWorkflowRun(run: WorkflowRunRecord): WorkflowRunRecord {
  return {
    ...run,
    stepResults: run.stepResults.map((step) => ({
      ...step,
      varsSnapshot: step.varsSnapshot ? { ...step.varsSnapshot } : undefined,
    })),
  };
}

function validateWorkflowTarget(
  stepIds: ReadonlySet<string>,
  sourceStepId: string,
  target: string | undefined,
  label: string,
): string | null {
  if (target === undefined) return null;
  if (!target.trim()) {
    return `${label} for step '${sourceStepId}' cannot be blank`;
  }
  if (target === '$end') return null;
  if (target === sourceStepId) {
    return `${label} for step '${sourceStepId}' cannot target itself`;
  }
  if (!stepIds.has(target)) {
    return `${label} for step '${sourceStepId}' targets unknown step '${target}'`;
  }
  return null;
}

function validateWorkflowExpression(
  expression: string,
  args: string[],
  label: string,
): string | null {
  try {
    new Function(...args, `return (${expression});`);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `${label} is invalid: ${message}`;
  }
}

function validateWorkflowOutputVar(stepId: string, output: StepOutputVar): string | null {
  const name = output.name.trim();
  if (!name) {
    return `output variable for step '${stepId}' requires name`;
  }

  const configuredExtractors = [
    output.jsonPath !== undefined ? 'jsonPath' : null,
    output.regex !== undefined ? 'regex' : null,
    output.transform !== undefined ? 'transform' : null,
  ].filter((value): value is 'jsonPath' | 'regex' | 'transform' => value !== null);

  if (configuredExtractors.length === 0) {
    return `output variable '${name}' for step '${stepId}' requires one extractor`;
  }
  if (configuredExtractors.length > 1) {
    return `output variable '${name}' for step '${stepId}' must use exactly one extractor`;
  }

  if (output.jsonPath !== undefined && !output.jsonPath.trim()) {
    return `output variable '${name}' for step '${stepId}' has blank jsonPath`;
  }
  if (output.regex !== undefined) {
    if (!output.regex.trim()) {
      return `output variable '${name}' for step '${stepId}' has blank regex`;
    }
    try {
      new RegExp(output.regex, 's');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `output regex '${name}' for step '${stepId}' is invalid: ${message}`;
    }
  }
  if (output.transform !== undefined && !output.transform.trim()) {
    return `output variable '${name}' for step '${stepId}' has blank transform`;
  }

  return null;
}

function normalizeWorkflowBooleanLiteral(expression: string): boolean | null {
  const normalized = expression.trim();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
}

function validateWorkflowPublicationChannels(channelIds: string[] | undefined): string | null {
  if (!channelIds) return null;
  const seenChannelIds = new Set<string>();
  for (const rawChannelId of channelIds) {
    const channelId = rawChannelId.trim();
    if (!channelId) {
      return 'workflow publicationChannels contains blank channelId';
    }
    if (seenChannelIds.has(channelId)) {
      return `workflow publicationChannels contains duplicate channelId '${channelId}'`;
    }
    seenChannelIds.add(channelId);
  }
  return null;
}

function validateWorkflowPublicationTargets(
  targets: WorkflowDef['publicationTargets'],
): string | null {
  if (!targets) return null;
  const seenTargets = new Set<string>();
  for (const target of targets) {
    const channelId = target.channelId.trim();
    const threadKey = target.threadKey.trim();
    if (!channelId) {
      return 'workflow publication target requires channelId';
    }
    if (!threadKey) {
      return `workflow publication target '${channelId}' requires threadKey`;
    }
    if (target.agentId !== undefined && !target.agentId.trim()) {
      return `workflow publication target '${channelId}:${threadKey}' has blank agentId`;
    }
    const dedupeKey = `${channelId}:${threadKey}`;
    if (seenTargets.has(dedupeKey)) {
      return `workflow publicationTargets contains duplicate target '${dedupeKey}'`;
    }
    seenTargets.add(dedupeKey);
  }
  return null;
}

function collectWorkflowEdges(workflow: WorkflowDef): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (let index = 0; index < workflow.steps.length; index += 1) {
    const step = workflow.steps[index];
    if (!step) continue;
    const nextTarget = step.nextStepId ?? workflow.steps[index + 1]?.id;
    const targets = new Set<string>();
    if (step.type === 'condition') {
      for (const branch of step.branches ?? []) {
        if (branch.goto && branch.goto !== '$end') targets.add(branch.goto);
      }
    }
    if (nextTarget && nextTarget !== '$end') targets.add(nextTarget);
    edges.set(step.id, [...targets]);
  }
  return edges;
}

function findWorkflowCycle(workflow: WorkflowDef): string | null {
  const entryStepId = workflow.entryStepId ?? workflow.steps[0]?.id;
  if (!entryStepId) return null;
  const edges = collectWorkflowEdges(workflow);
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (stepId: string): string | null => {
    if (visiting.has(stepId)) return stepId;
    if (visited.has(stepId)) return null;
    visiting.add(stepId);
    for (const target of edges.get(stepId) ?? []) {
      const cycleAt = visit(target);
      if (cycleAt) return cycleAt;
    }
    visiting.delete(stepId);
    visited.add(stepId);
    return null;
  };

  return visit(entryStepId);
}

function findUnreachableWorkflowStepIds(workflow: WorkflowDef): string[] {
  const entryStepId = workflow.entryStepId ?? workflow.steps[0]?.id;
  if (!entryStepId) return [];

  const edges = collectWorkflowEdges(workflow);
  const reachable = new Set<string>();
  const pending = [entryStepId];

  while (pending.length > 0) {
    const stepId = pending.pop();
    if (!stepId || reachable.has(stepId)) continue;
    reachable.add(stepId);
    for (const target of edges.get(stepId) ?? []) {
      if (!reachable.has(target)) pending.push(target);
    }
  }

  return workflow.steps.map((step) => step.id).filter((stepId) => !reachable.has(stepId));
}

export function validateWorkflowDef(workflow: WorkflowDef): string | null {
  if (!workflow.id.trim()) return 'workflow id is required';
  if (!workflow.name.trim()) return 'workflow name is required';
  if (workflow.steps.length === 0) return 'workflow must contain at least one step';

  const publicationChannelsError = validateWorkflowPublicationChannels(
    workflow.publicationChannels,
  );
  if (publicationChannelsError) return publicationChannelsError;

  const publicationTargetsError = validateWorkflowPublicationTargets(workflow.publicationTargets);
  if (publicationTargetsError) return publicationTargetsError;

  const seenStepIds = new Set<string>();
  for (const step of workflow.steps) {
    if (!step.id.trim()) return 'workflow step id is required';
    if (seenStepIds.has(step.id)) {
      return `workflow contains duplicate step id '${step.id}'`;
    }
    seenStepIds.add(step.id);
  }

  if (workflow.entryStepId && !seenStepIds.has(workflow.entryStepId)) {
    return `workflow entryStepId targets unknown step '${workflow.entryStepId}'`;
  }

  for (const step of workflow.steps) {
    const type = step.type ?? 'agent';
    if (type === 'agent' && !step.agentId?.trim()) {
      return `agent step '${step.id}' requires agentId`;
    }
    if (type === 'http' && !step.url?.trim()) {
      return `http step '${step.id}' requires url`;
    }

    const nextTargetError = validateWorkflowTarget(
      seenStepIds,
      step.id,
      step.nextStepId,
      'nextStepId',
    );
    if (nextTargetError) return nextTargetError;

    if (type === 'transform') {
      const transformExpression = step.transformCode ?? step.messageTemplate;
      const transformError = validateWorkflowExpression(
        transformExpression,
        ['vars', 'globals', 'input', 'prev_output'],
        `transformCode for step '${step.id}'`,
      );
      if (transformError) return transformError;
    }

    const seenOutputNames = new Set<string>();
    for (const output of step.outputs ?? []) {
      const outputVarError = validateWorkflowOutputVar(step.id, output);
      if (outputVarError) return outputVarError;

      const outputName = output.name.trim();
      if (seenOutputNames.has(outputName)) {
        return `step '${step.id}' contains duplicate output variable '${outputName}'`;
      }
      seenOutputNames.add(outputName);

      if (output.transform !== undefined) {
        const outputTransformError = validateWorkflowExpression(
          output.transform,
          ['output', 'vars', 'globals'],
          `output transform '${output.name}' for step '${step.id}'`,
        );
        if (outputTransformError) return outputTransformError;
      }
    }

    for (const branch of step.branches ?? []) {
      const branchExpressionError = validateWorkflowExpression(
        branch.expression,
        ['output', 'vars', 'globals'],
        `branch expression for step '${step.id}'`,
      );
      if (branchExpressionError) return branchExpressionError;

      const branchTargetError = validateWorkflowTarget(
        seenStepIds,
        step.id,
        branch.goto,
        'branch goto',
      );
      if (branchTargetError) return branchTargetError;
    }

    let branchIndex = 0;
    let matchedTerminalBranch = false;
    for (const branch of step.branches ?? []) {
      branchIndex += 1;
      if (matchedTerminalBranch) {
        return `condition step '${step.id}' contains unreachable branch #${branchIndex} after an always-true branch`;
      }
      const literalValue = normalizeWorkflowBooleanLiteral(branch.expression);
      if (literalValue === false) {
        return `condition step '${step.id}' contains branch #${branchIndex} that can never match`;
      }
      if (literalValue === true) {
        matchedTerminalBranch = true;
      }
    }
  }

  const cycleAt = findWorkflowCycle(workflow);
  if (cycleAt) {
    return `workflow graph contains a cycle at step '${cycleAt}'`;
  }

  const unreachableStepIds = findUnreachableWorkflowStepIds(workflow);
  if (unreachableStepIds.length > 0) {
    return `workflow graph contains unreachable steps: ${unreachableStepIds.join(', ')}`;
  }

  return null;
}

async function getWorkflowKernelService(ctx: RpcContext): Promise<WorkflowKernelService> {
  const existing = workflowKernelServices.get(ctx);
  if (existing) {
    return existing;
  }
  const created = (async () => {
    const service = new WorkflowKernelService({
      dataDir: ctx.dataDir,
      runners: ctx.runners,
      callbacks: {
        async onRunComplete(workflow, run) {
          const finalRun = cloneWorkflowRun(run);
          await createWorkflowDeliverableRecord(ctx, workflow, finalRun);
          await persistRun(ctx.dataDir, finalRun);
          logger.info('Workflow completed', {
            runId: finalRun.runId,
            status: finalRun.status,
          });
        },
        async findArchivedRun(runId) {
          const history = await readWorkflowRunsFile(ctx.dataDir);
          return history.find((run) => run.runId === runId) ?? null;
        },
      },
    });
    await service.initialize();
    return service;
  })();
  workflowKernelServices.set(ctx, created);
  return created;
}

// ── Scheduler integration ─────────────────────────────────────────────────────

/**
 * Run a workflow synchronously and return the final output text.
 * Designed for use by the scheduler when a task targets a workflow rather than an agent.
 */
export async function runWorkflowForScheduler(
  ctx: RpcContext,
  workflowId: string,
  input: string,
): Promise<{ workflowRunId: string; output: string; deliverableId?: string }> {
  const workflows = await readWorkflowsFile(ctx.dataDir);
  const workflow = workflows.find((w) => w.id === workflowId);
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);

  const service = await getWorkflowKernelService(ctx);
  const started = await service.startWorkflow(workflow, input);
  const final = await service.waitForCompletion(started.runId);
  if (final.status === 'error') {
    const lastErr = final.stepResults.find((r) => r.error)?.error;
    throw new Error(lastErr ?? 'Workflow execution failed');
  }
  if (final.status === 'cancelled') {
    throw new Error('Workflow execution was cancelled');
  }
  const lastStep = final.stepResults[final.stepResults.length - 1];
  return {
    workflowRunId: final.runId,
    output: lastStep?.output ?? '(workflow completed)',
    deliverableId: final.latestDeliverableId,
  };
}

// ── RPC dispatch ─────────────────────────────────────────────────────────────

export type WorkflowRpcMethod =
  | 'workflow.list'
  | 'workflow.save'
  | 'workflow.delete'
  | 'workflow.run'
  | 'workflow.runStatus'
  | 'workflow.cancel'
  | 'workflow.history';

interface RpcResponse {
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function ok(id: string | number, result: unknown): RpcResponse {
  return { id, result };
}

function err(id: string | number, code: number, message: string): RpcResponse {
  return { id, error: { code, message } };
}

export async function dispatchWorkflowRpc(
  method: WorkflowRpcMethod,
  id: string | number,
  params: unknown,
  ctx: RpcContext,
): Promise<RpcResponse> {
  switch (method) {
    case 'workflow.list': {
      const workflows = await readWorkflowsFile(ctx.dataDir);
      return ok(id, { workflows });
    }

    case 'workflow.save': {
      const workflow = params as WorkflowDef | null;
      if (!workflow?.id || !workflow?.name) {
        return err(id, -32602, 'id and name are required');
      }
      const validationError = validateWorkflowDef(workflow);
      if (validationError) {
        return err(id, -32602, validationError);
      }
      const workflows = await readWorkflowsFile(ctx.dataDir);
      const idx = workflows.findIndex((w) => w.id === workflow.id);
      if (idx >= 0) workflows[idx] = workflow;
      else workflows.push(workflow);
      await writeWorkflowsFile(ctx.dataDir, workflows);
      return ok(id, { workflow });
    }

    case 'workflow.delete': {
      const { workflowId } = (params ?? {}) as { workflowId?: string };
      if (!workflowId) return err(id, -32602, 'workflowId is required');
      const workflows = await readWorkflowsFile(ctx.dataDir);
      await writeWorkflowsFile(
        ctx.dataDir,
        workflows.filter((w) => w.id !== workflowId),
      );
      return ok(id, { deleted: true, workflowId });
    }

    case 'workflow.run': {
      const { workflowId, input } = (params ?? {}) as {
        workflowId?: string;
        input?: string;
      };
      if (!workflowId) return err(id, -32602, 'workflowId is required');

      const workflows = await readWorkflowsFile(ctx.dataDir);
      const workflow = workflows.find((w) => w.id === workflowId);
      if (!workflow) return err(id, 404, `Workflow not found: ${workflowId}`);
      const validationError = validateWorkflowDef(workflow);
      if (validationError) return err(id, 400, `Invalid workflow definition: ${validationError}`);

      const service = await getWorkflowKernelService(ctx);
      const run = await service.startWorkflow(workflow, input ?? '');
      return ok(id, { runId: run.runId });
    }

    case 'workflow.runStatus': {
      const { runId } = (params ?? {}) as { runId?: string };
      if (!runId) return err(id, -32602, 'runId is required');
      const service = await getWorkflowKernelService(ctx);
      const live = service.getRun(runId);
      if (live) {
        return ok(id, live);
      }
      const history = await readWorkflowRunsFile(ctx.dataDir);
      const found = history.find((r) => r.runId === runId);
      return ok(id, found ?? null);
    }

    case 'workflow.cancel': {
      const { runId } = (params ?? {}) as { runId?: string };
      if (!runId) return err(id, -32602, 'runId is required');
      const service = await getWorkflowKernelService(ctx);
      const liveRun = service.getRun(runId);
      if (!liveRun) return err(id, 404, `Run not found: ${runId}`);
      if (liveRun.status !== 'running') {
        return ok(id, { cancelled: false, reason: `Run status is already '${liveRun.status}'` });
      }
      await service.cancelRun(runId);
      return ok(id, { cancelled: true, runId });
    }

    case 'workflow.history': {
      const service = await getWorkflowKernelService(ctx);
      const liveRuns = service.listRuns();
      const history = await readWorkflowRunsFile(ctx.dataDir);
      // RATIONALE: Merge kernel-visible live runs so clients can observe current
      // running/cancelled overlays before the final archived record is read back.
      const liveRunIds = new Set(liveRuns.map((r) => r.runId));
      const merged = [...liveRuns, ...history.filter((r) => !liveRunIds.has(r.runId))].slice(
        0,
        100,
      );
      return ok(id, { runs: merged });
    }

    default: {
      const _exhaust: never = method;
      return err(id, -32601, `Unknown workflow method: ${String(_exhaust)}`);
    }
  }
}
