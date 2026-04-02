/**
 * Server-side workflow engine.
 *
 * Workflows are persisted to `<dataDir>/workflows.json`.
 * Run records are persisted to `<dataDir>/workflow-runs.json` (last 100 runs).
 * In-progress runs are also tracked in `activeWorkflowRuns` for live polling.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { createLogger } from '../core/logger.js';
import type { RpcContext } from './rpc.js';

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
}

// ── In-memory active runs (cleared on gateway restart) ────────────────────────

const activeWorkflowRuns = new Map<string, WorkflowRunRecord>();

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

// ── Template interpolation ────────────────────────────────────────────────────

/** Named variable values collected across steps: stepId → varName → value */
type StepVarMap = Map<string, Map<string, string>>;

/**
 * Interpolate a template string.
 *
 * Supported placeholders:
 *   {{input}}                  — original top-level user input
 *   {{prev_output}}            — output of the immediately preceding step
 *   {{step_N_output}}          — output of step N (1-based)
 *   {{vars.<stepId>.<name>}}   — named variable extracted from a previous step
 *   {{globals.<key>}}          — workflow-level constant from WorkflowDef.variables
 */
function interpolate(
  template: string,
  input: string,
  prevOutputs: string[],
  stepVars: StepVarMap,
  globals: Record<string, string>,
): string {
  return template
    .replace(/\{\{input\}\}/g, input)
    .replace(/\{\{prev_output\}\}/g, prevOutputs[prevOutputs.length - 1] ?? '')
    .replace(/\{\{step_(\d+)_output\}\}/g, (_, n: string) => prevOutputs[Number(n) - 1] ?? '')
    .replace(/\{\{vars\.([^.}]+)\.([^}]+)\}\}/g, (_, stepId: string, varName: string) => {
      return stepVars.get(stepId)?.get(varName) ?? '';
    })
    .replace(/\{\{globals\.([^}]+)\}\}/g, (_, key: string) => globals[key] ?? '');
}

/**
 * Extract named output variables from a step's text output.
 * Tries JSON paths first, then regex patterns, then JS transform expressions.
 */
function extractStepVars(
  output: string,
  stepId: string,
  step: WorkflowStep,
  stepVars: StepVarMap,
  globals: Record<string, string>,
): void {
  if (!step.outputs?.length) return;
  const vars = stepVars.get(stepId) ?? new Map<string, string>();

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    /* not JSON */
  }

  for (const def of step.outputs) {
    let value = '';
    if (def.transform) {
      // JS expression: receives (output, vars, globals) → string
      try {
        const varsFlat: Record<string, Record<string, string>> = {};
        for (const [sid, vmap] of stepVars) varsFlat[sid] = Object.fromEntries(vmap);
        // eslint-disable-next-line no-new-func
        value = String(
          new Function('output', 'vars', 'globals', `return (${def.transform})`)(
            output,
            varsFlat,
            globals,
          ) ?? '',
        );
      } catch {
        value = '';
      }
    } else if (def.jsonPath && parsed !== undefined) {
      // Simple JSONPath: support "$.field" and "$.a.b" only (no arrays)
      const pathParts = def.jsonPath.replace(/^\$\.?/, '').split('.');
      let node: unknown = parsed;
      for (const part of pathParts) {
        if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
          node = (node as Record<string, unknown>)[part];
        } else {
          node = undefined;
          break;
        }
      }
      if (node !== undefined) value = String(node);
    } else if (def.regex) {
      const m = new RegExp(def.regex, 's').exec(output);
      if (m?.[1] !== undefined) value = m[1];
    }
    vars.set(def.name, value);
  }
  stepVars.set(stepId, vars);
}

/** Evaluate a condition branch expression safely. Returns false on error. */
function evalBranchExpression(
  expression: string,
  output: string,
  stepVars: StepVarMap,
  globals: Record<string, string>,
): boolean {
  try {
    // Build a vars-compatible flat object for easy access in expressions
    const vars: Record<string, Record<string, string>> = {};
    for (const [sid, vmap] of stepVars) {
      vars[sid] = Object.fromEntries(vmap);
    }
    // eslint-disable-next-line no-new-func
    return Boolean(
      new Function('output', 'vars', 'globals', `return (${expression});`)(output, vars, globals),
    );
  } catch {
    return false;
  }
}
// ── Format instruction presets ────────────────────────────────────────────────
const FORMAT_INSTRUCTIONS: Record<string, string> = {
  text: '\n\n请以纯文本格式回答，不要使用任何 Markdown 标记。',
  json: '\n\n请严格以合法 JSON 格式输出，不要包含说明文字或 Markdown 代码块，只输出 JSON。',
  markdown: '\n\n请以 Markdown 格式输出，合理使用标题（##）、列表、代码块（```）等格式。',
};

/** Build a flat snapshot of all named variables accumulated so far: "stepId.varName" → value */
function snapshotVars(stepVars: StepVarMap): Record<string, string> {
  const snap: Record<string, string> = {};
  for (const [sid, vmap] of stepVars) {
    for (const [name, val] of vmap) snap[`${sid}.${name}`] = val;
  }
  return snap;
}
// ── Background pipeline executor ─────────────────────────────────────────────

async function executeWorkflowBackground(
  ctx: RpcContext,
  workflow: WorkflowDef,
  run: WorkflowRunRecord,
): Promise<void> {
  const prevOutputs: string[] = [];
  const stepVars: StepVarMap = new Map();
  const globals: Record<string, string> = workflow.variables ?? {};

  // Build id → array-index map for O(1) lookup.
  const stepIndexMap = new Map<string, number>(workflow.steps.map((s, i) => [s.id, i]));

  // Pointer into workflow.steps — may jump (condition branches).
  let stepIdx =
    workflow.entryStepId !== undefined ? (stepIndexMap.get(workflow.entryStepId) ?? 0) : 0;

  // Guard: at most steps.length * (maxRetries+1) + 1 iterations to prevent infinite loops
  const maxIter = workflow.steps.length * 10 + 1;

  for (let iter = 0; iter < maxIter; iter++) {
    if (stepIdx >= workflow.steps.length) break;

    // Check cancellation
    if (activeWorkflowRuns.get(run.runId)?.status === 'cancelled') {
      run.status = 'cancelled';
      run.finishedAt = Date.now();
      activeWorkflowRuns.set(run.runId, { ...run });
      await persistRun(ctx.dataDir, run);
      return;
    }

    const step = workflow.steps[stepIdx];
    if (!step) {
      throw new Error(`Workflow step index out of range: ${stepIdx}`);
    }
    const resultSlot = run.stepResults.length; // where we'll write this step's result

    // Push a "started" entry
    run.stepResults = [...run.stepResults, { stepId: step.id }];
    activeWorkflowRuns.set(run.runId, { ...run });

    const maxRetries = step.maxRetries ?? 0;
    let lastError = '';
    let succeeded = false;
    let stepOutput = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const type = step.type ?? 'agent';
        const message = interpolate(
          step.messageTemplate,
          run.input,
          prevOutputs,
          stepVars,
          globals,
        );

        if (type === 'agent') {
          const runner = ctx.runners.get(step.agentId ?? '');
          if (!runner) throw new Error(`Agent not found: ${step.agentId}`);

          // Append output format instructions to the agent message if configured
          let agentMsg = message;
          const formatInstruction = step.outputFormatPrompt
            ? step.outputFormatPrompt
            : step.outputFormat
              ? (FORMAT_INSTRUCTIONS[step.outputFormat] ?? '')
              : '';
          if (formatInstruction) {
            if (step.outputFormatMode === 'prepend') {
              // RATIONALE: prepend mode places the format requirement as the primary directive
              // so the agent treats it with higher priority than a trailing hint.
              agentMsg = `${formatInstruction.trimStart()}\n\n${message}`;
            } else {
              // append (default)
              agentMsg = `${message}\n\n${formatInstruction.trimStart()}`;
            }
          }

          runner.setThread(`workflow:${run.runId}:step${stepIdx}`);
          let output = '';
          for await (const chunk of runner.turn(agentMsg)) {
            if ((chunk as { type: string; text?: string }).type === 'text_delta') {
              output += (chunk as { type: string; text?: string }).text ?? '';
              run.stepResults[resultSlot] = { stepId: step.id, output };
              activeWorkflowRuns.set(run.runId, { ...run, stepResults: [...run.stepResults] });
            }
          }
          stepOutput = output.trim();
        } else if (type === 'transform') {
          // RATIONALE: transform steps run a tiny JS snippet so non-LLM data transformation
          // is cheap and does not consume API tokens. Code runs in a limited Function scope.
          // eslint-disable-next-line no-new-func
          const result = new Function(
            'vars',
            'globals',
            'input',
            'prev_output',
            `return (${step.transformCode ?? message});`,
          )(
            Object.fromEntries([...stepVars.entries()].map(([k, v]) => [k, Object.fromEntries(v)])),
            globals,
            run.input,
            prevOutputs[prevOutputs.length - 1] ?? '',
          );
          stepOutput = String(result ?? '');
        } else if (type === 'http') {
          const url = interpolate(step.url ?? '', run.input, prevOutputs, stepVars, globals);
          const body = step.bodyTemplate
            ? interpolate(step.bodyTemplate, run.input, prevOutputs, stepVars, globals)
            : undefined;
          const resp = await fetch(url, {
            method: step.method ?? 'GET',
            headers: step.headers,
            body: body,
          });
          stepOutput = await resp.text();
        } else if (type === 'condition') {
          // Condition steps evaluate the most recent output to choose a branch.
          const testOutput = prevOutputs[prevOutputs.length - 1] ?? '';
          stepOutput = testOutput; // condition step passes through as-is
          // Determine next step via branches
          if (step.branches?.length) {
            for (const branch of step.branches) {
              if (evalBranchExpression(branch.expression, testOutput, stepVars, globals)) {
                if (branch.goto === '$end') {
                  // Finish pipeline immediately
                  const snapEnd = snapshotVars(stepVars);
                  run.stepResults[resultSlot] = {
                    stepId: step.id,
                    output: '→ $end',
                    ...(Object.keys(snapEnd).length ? { varsSnapshot: snapEnd } : {}),
                  };
                  prevOutputs.push(stepOutput);
                  run.status = 'done';
                  run.finishedAt = Date.now();
                  activeWorkflowRuns.set(run.runId, { ...run });
                  await persistRun(ctx.dataDir, run);
                  logger.info('Workflow ended via condition branch', { runId: run.runId });
                  return;
                }
                const targetIdx = stepIndexMap.get(branch.goto);
                if (targetIdx !== undefined) {
                  extractStepVars(stepOutput, step.id, step, stepVars, globals);
                  const snapBranch = snapshotVars(stepVars);
                  run.stepResults[resultSlot] = {
                    stepId: step.id,
                    output: `→ ${branch.goto}`,
                    ...(Object.keys(snapBranch).length ? { varsSnapshot: snapBranch } : {}),
                  };
                  prevOutputs.push(stepOutput);
                  activeWorkflowRuns.set(run.runId, { ...run, stepResults: [...run.stepResults] });
                  stepIdx = targetIdx;
                  succeeded = true;
                  break;
                }
              }
            }
            if (succeeded) break; // jump already set — skip normal advance
          }
        }

        succeeded = true;
        break; // out of retry loop
      } catch (err) {
        lastError = String(err);
        if (attempt < maxRetries) {
          logger.warn('Workflow step error, retrying', {
            runId: run.runId,
            step: stepIdx,
            attempt,
            error: lastError,
          });
        }
      }
    }

    if (!succeeded) {
      logger.warn('Workflow step failed', { runId: run.runId, step: stepIdx, error: lastError });
      run.stepResults[resultSlot] = { stepId: step.id, error: lastError };
      prevOutputs.push('');
      activeWorkflowRuns.set(run.runId, { ...run, stepResults: [...run.stepResults] });

      if (step.condition === 'on_success') {
        run.status = 'error';
        run.finishedAt = Date.now();
        activeWorkflowRuns.set(run.runId, { ...run });
        await persistRun(ctx.dataDir, run);
        return;
      }
      // Advance to next step after failure
      stepIdx += 1;
      continue;
    }

    // Condition type already advanced stepIdx via branch — skip normal advance
    if ((step.type ?? 'agent') !== 'condition') {
      extractStepVars(stepOutput, step.id, step, stepVars, globals);
      const snap = snapshotVars(stepVars);
      run.stepResults[resultSlot] = {
        stepId: step.id,
        output: stepOutput,
        ...(Object.keys(snap).length ? { varsSnapshot: snap } : {}),
      };
      prevOutputs.push(stepOutput);
      activeWorkflowRuns.set(run.runId, { ...run, stepResults: [...run.stepResults] });
      stepIdx += 1;
    }
  }

  run.status = run.status === 'cancelled' ? 'cancelled' : 'done';
  run.finishedAt = Date.now();
  activeWorkflowRuns.set(run.runId, { ...run });
  await persistRun(ctx.dataDir, run);
  logger.info('Workflow completed', { runId: run.runId, status: run.status });
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
): Promise<string> {
  const workflows = await readWorkflowsFile(ctx.dataDir);
  const workflow = workflows.find((w) => w.id === workflowId);
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);

  const runId = ulid();
  const run: WorkflowRunRecord = {
    runId,
    workflowId,
    workflowName: workflow.name,
    input,
    startedAt: Date.now(),
    status: 'running',
    stepResults: [],
  };
  activeWorkflowRuns.set(runId, run);

  await executeWorkflowBackground(ctx, workflow, run);

  const final = activeWorkflowRuns.get(runId) ?? run;
  if (final.status === 'error') {
    const lastErr = final.stepResults.find((r) => r.error)?.error;
    throw new Error(lastErr ?? 'Workflow execution failed');
  }
  const lastStep = final.stepResults[final.stepResults.length - 1];
  return lastStep?.output ?? '(workflow completed)';
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

      const runId = ulid();
      const run: WorkflowRunRecord = {
        runId,
        workflowId,
        workflowName: workflow.name,
        input: input ?? '',
        startedAt: Date.now(),
        status: 'running',
        stepResults: [],
      };
      activeWorkflowRuns.set(runId, run);

      // Fire off background execution — errors are caught inside the function
      void executeWorkflowBackground(ctx, workflow, run).catch((e) => {
        logger.error('Workflow background executor crashed', { runId, error: String(e) });
        const r = activeWorkflowRuns.get(runId);
        if (r?.status === 'running') {
          r.status = 'error';
          r.finishedAt = Date.now();
          activeWorkflowRuns.set(runId, r);
          void persistRun(ctx.dataDir, r).catch(() => undefined);
        }
      });

      return ok(id, { runId });
    }

    case 'workflow.runStatus': {
      const { runId } = (params ?? {}) as { runId?: string };
      if (!runId) return err(id, -32602, 'runId is required');
      const inMemory = activeWorkflowRuns.get(runId);
      if (inMemory) return ok(id, inMemory);
      const history = await readWorkflowRunsFile(ctx.dataDir);
      const found = history.find((r) => r.runId === runId);
      return ok(id, found ?? null);
    }

    case 'workflow.cancel': {
      const { runId } = (params ?? {}) as { runId?: string };
      if (!runId) return err(id, -32602, 'runId is required');
      const run = activeWorkflowRuns.get(runId);
      if (!run) return err(id, 404, `Run not found: ${runId}`);
      if (run.status !== 'running') {
        return ok(id, { cancelled: false, reason: `Run status is already '${run.status}'` });
      }
      run.status = 'cancelled';
      run.finishedAt = Date.now();
      activeWorkflowRuns.set(runId, { ...run });
      await persistRun(ctx.dataDir, run);
      return ok(id, { cancelled: true, runId });
    }

    case 'workflow.history': {
      const history = await readWorkflowRunsFile(ctx.dataDir);
      // RATIONALE: Merge in-memory active runs so clients can detect currently-running
      // workflows before they finish (persistence only happens on completion/cancel).
      const activeRuns = Array.from(activeWorkflowRuns.values());
      const activeIds = new Set(activeRuns.map((r) => r.runId));
      const merged = [...activeRuns, ...history.filter((r) => !activeIds.has(r.runId))].slice(
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
