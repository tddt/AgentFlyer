import type { WorkflowStep } from './workflow-backend.js';

/** Named variable values collected across steps: stepId → varName → value */
export type StepVarMap = Map<string, Map<string, string>>;

export type SerializedStepVars = Record<string, Record<string, string>>;

export const FORMAT_INSTRUCTIONS: Record<string, string> = {
  text: '\n\n请以纯文本格式回答，不要使用任何 Markdown 标记。',
  json: '\n\n请严格以合法 JSON 格式输出，不要包含说明文字或 Markdown 代码块，只输出 JSON。',
  markdown: '\n\n请以 Markdown 格式输出，合理使用标题（##）、列表、代码块（```）等格式。',
};

export function buildWorkflowStepIndexMap(workflow: { steps: WorkflowStep[] }): Map<
  string,
  number
> {
  return new Map(workflow.steps.map((step, index) => [step.id, index]));
}

export function resolveWorkflowEntryStepIndex(workflow: {
  steps: WorkflowStep[];
  entryStepId?: string;
}): number {
  if (workflow.entryStepId === undefined) return 0;
  return buildWorkflowStepIndexMap(workflow).get(workflow.entryStepId) ?? 0;
}

export function resolveWorkflowStepId(
  workflow: { steps: WorkflowStep[] },
  stepIndex: number,
): string | undefined {
  return workflow.steps[stepIndex]?.id;
}

export function resolveWorkflowStepIndex(
  workflow: { steps: WorkflowStep[] },
  currentStepId: string | undefined,
  fallbackIndex: number,
): number {
  if (currentStepId !== undefined) {
    const resolved = buildWorkflowStepIndexMap(workflow).get(currentStepId);
    if (resolved !== undefined) return resolved;
  }
  if (fallbackIndex < 0) return 0;
  if (fallbackIndex > workflow.steps.length) return workflow.steps.length;
  return fallbackIndex;
}

export function resolveWorkflowNextStepIndex(
  workflow: { steps: WorkflowStep[] },
  step: Pick<WorkflowStep, 'nextStepId'>,
  currentStepIndex: number,
): number {
  if (step.nextStepId === '$end') {
    return workflow.steps.length;
  }
  if (step.nextStepId) {
    const resolved = buildWorkflowStepIndexMap(workflow).get(step.nextStepId);
    if (resolved !== undefined) return resolved;
  }
  return currentStepIndex + 1;
}

export function serializeStepVars(stepVars: StepVarMap): SerializedStepVars {
  const out: SerializedStepVars = {};
  for (const [stepId, vars] of stepVars) {
    out[stepId] = Object.fromEntries(vars);
  }
  return out;
}

export function deserializeStepVars(payload: SerializedStepVars): StepVarMap {
  const out: StepVarMap = new Map();
  for (const [stepId, vars] of Object.entries(payload)) {
    out.set(stepId, new Map(Object.entries(vars)));
  }
  return out;
}

export function interpolate(
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

export function extractStepVars(
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
      try {
        const varsFlat: Record<string, Record<string, string>> = {};
        for (const [sid, vmap] of stepVars) varsFlat[sid] = Object.fromEntries(vmap);
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
      const match = new RegExp(def.regex, 's').exec(output);
      if (match?.[1] !== undefined) value = match[1];
    }
    vars.set(def.name, value);
  }
  stepVars.set(stepId, vars);
}

export function evalBranchExpression(
  expression: string,
  output: string,
  stepVars: StepVarMap,
  globals: Record<string, string>,
): boolean {
  try {
    const vars: Record<string, Record<string, string>> = {};
    for (const [sid, vmap] of stepVars) {
      vars[sid] = Object.fromEntries(vmap);
    }
    return Boolean(
      new Function('output', 'vars', 'globals', `return (${expression});`)(output, vars, globals),
    );
  } catch {
    return false;
  }
}

export function snapshotVars(stepVars: StepVarMap): Record<string, string> {
  const snap: Record<string, string> = {};
  for (const [sid, vmap] of stepVars) {
    for (const [name, value] of vmap) {
      snap[`${sid}.${name}`] = value;
    }
  }
  return snap;
}

export function applyFormatInstruction(step: WorkflowStep, message: string): string {
  const formatInstruction = step.outputFormatPrompt
    ? step.outputFormatPrompt
    : step.outputFormat
      ? (FORMAT_INSTRUCTIONS[step.outputFormat] ?? '')
      : '';
  if (!formatInstruction) return message;
  if (step.outputFormatMode === 'prepend') {
    return `${formatInstruction.trimStart()}\n\n${message}`;
  }
  return `${message}\n\n${formatInstruction.trimStart()}`;
}
