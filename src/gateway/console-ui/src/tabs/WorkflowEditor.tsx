/**
 * WorkflowEditor — form for creating and editing workflow definitions.
 * Supports agent / transform / condition / http step types.
 */
import { useState } from 'react';
import { Button } from '../components/Button.js';
import type {
  ConditionBranch,
  StepOutputVar,
  StepType,
  WorkflowDef,
  WorkflowStep,
} from '../types.js';

// ── WorkflowGuide ─────────────────────────────────────────────────────────────

function WorkflowGuide({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'overview' | 'steps' | 'vars' | 'format'>('overview');
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
        <span className="text-sm font-semibold text-slate-100">📖 工作流使用说明</span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-sm">
          ✕
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 px-4 pt-3">
        <button className={tabCls('overview')} onClick={() => setTab('overview')}>
          概览
        </button>
        <button className={tabCls('steps')} onClick={() => setTab('steps')}>
          步骤类型
        </button>
        <button className={tabCls('vars')} onClick={() => setTab('vars')}>
          变量系统
        </button>
        <button className={tabCls('format')} onClick={() => setTab('format')}>
          输出格式
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
};

const STEP_TYPE_COLORS: Record<StepType, string> = {
  agent: 'bg-indigo-600/20 ring-indigo-500/40 text-indigo-300',
  transform: 'bg-amber-600/20 ring-amber-500/40 text-amber-300',
  condition: 'bg-purple-600/20 ring-purple-500/40 text-purple-300',
  http: 'bg-emerald-600/20 ring-emerald-500/40 text-emerald-300',
};

const inputCls =
  'rounded-lg bg-slate-900/70 ring-1 ring-slate-700 px-2 py-1.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-indigo-500';

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
  const updateBranch = (i: number, b: ConditionBranch) =>
    onChange(branches.map((x, j) => (j === i ? b : x)));
  const removeBranch = (i: number) => onChange(branches.filter((_, j) => j !== i));
  const addBranch = () =>
    onChange([...branches, { expression: 'output.includes("yes")', goto: '' }]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-400">分支条件</span>
        <button onClick={addBranch} className="text-xs text-indigo-400 hover:text-indigo-300">
          + 添加分支
        </button>
      </div>
      {branches.map((b, i) => (
        <div key={i} className="grid grid-cols-[1fr_auto_auto] gap-2 items-start">
          <textarea
            rows={1}
            className={`${inputCls} font-mono text-xs resize-none`}
            placeholder="output.includes('yes')"
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
              <option value="">— 选择目标 —</option>
              <option value="$end">$end (结束流程)</option>
              {steps.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label
                    ? `${s.label}【${s.id}】`
                    : `${STEP_TYPE_LABELS[s.type ?? 'agent']}【${s.id}】`}
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
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  step: WorkflowStep;
  index: number;
  total: number;
  agents: { agentId: string; name?: string }[];
  allSteps: WorkflowStep[];
  onChange: (s: WorkflowStep) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}) {
  const type: StepType = step.type ?? 'agent';

  return (
    <div className="rounded-xl bg-slate-800/70 ring-1 ring-slate-700/60 p-4 flex flex-col gap-3">
      {/* Header row */}
      <div className="flex items-center gap-2">
        <span className="w-6 h-6 rounded-full bg-indigo-600/30 ring-1 ring-indigo-500/40 text-indigo-300 text-xs flex items-center justify-center font-mono shrink-0">
          {index + 1}
        </span>

        {/* Step type selector */}
        <select
          className={`rounded-lg ring-1 px-2 py-1.5 text-xs font-medium focus:outline-none ${STEP_TYPE_COLORS[type]}`}
          value={type}
          onChange={(e) => onChange({ ...step, type: e.target.value as StepType })}
        >
          {(Object.keys(STEP_TYPE_LABELS) as StepType[]).map((t) => (
            <option key={t} value={t}>
              {STEP_TYPE_LABELS[t]}
            </option>
          ))}
        </select>

        {/* Step label */}
        <input
          className={`${inputCls} flex-1`}
          placeholder={`Step label (ID: ${step.id})`}
          value={step.label ?? ''}
          onChange={(e) => onChange({ ...step, label: e.target.value || undefined })}
        />

        {/* Move + remove */}
        <div className="flex gap-1 shrink-0">
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

      {/* Agent selector */}
      {type === 'agent' && (
        <select
          className={inputCls}
          value={step.agentId ?? ''}
          onChange={(e) => onChange({ ...step, agentId: e.target.value })}
        >
          <option value="">— 选择 Agent —</option>
          {agents.map((a) => (
            <option key={a.agentId} value={a.agentId}>
              {a.name ?? a.agentId}
            </option>
          ))}
        </select>
      )}

      {/* Message template (agent / http body) */}
      {type !== 'condition' && type !== 'transform' && (
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-slate-500">
            {type === 'http' ? '请求体模板 (bodyTemplate)' : '消息模板'}
          </label>
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
      {type === 'agent' && (
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
      {(type === 'agent' || type === 'http') && (
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
      </div>
    </div>
  );
}

// ── WorkflowEditor ────────────────────────────────────────────────────────────

export function WorkflowEditor({
  workflow,
  agents,
  onSave,
  onCancel,
}: {
  workflow: WorkflowDef | null;
  agents: { agentId: string; name?: string }[];
  onSave: (w: WorkflowDef) => void;
  onCancel: () => void;
}) {
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
  const [showHelp, setShowHelp] = useState(false);

  const updateStep = (i: number, s: WorkflowStep) =>
    setSteps((p) => p.map((x, j) => (j === i ? s : x)));
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
    setSteps((p) => [
      ...p,
      {
        id: newStepId(),
        type,
        agentId: type === 'agent' ? '' : undefined,
        messageTemplate: '{{prev_output}}',
        condition: 'any',
      },
    ]);

  const handleSave = () => {
    if (!name.trim()) {
      setNameError(true);
      return;
    }
    setNameError(false);
    const now = Date.now();
    onSave({
      id: workflow?.id ?? newStepId(),
      name: name.trim(),
      description: description.trim() || undefined,
      steps,
      variables: Object.keys(variables).length ? variables : undefined,
      inputRequired: inputRequired ? undefined : false,
      createdAt: workflow?.createdAt ?? now,
      updatedAt: now,
    });
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

      {/* Pipeline visualizer */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {steps.map((s, i) => {
          const t: StepType = s.type ?? 'agent';
          return (
            <div key={s.id} className="flex items-center gap-1.5 shrink-0">
              <div
                className={`rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ${STEP_TYPE_COLORS[t]}`}
              >
                {s.label ?? s.id}
              </div>
              {i < steps.length - 1 && <span className="text-slate-600">→</span>}
            </div>
          );
        })}
        {steps.length === 0 && <span className="text-xs text-slate-600">暂无步骤</span>}
      </div>

      {/* Steps */}
      <div className="flex flex-col gap-2">
        {steps.map((s, i) => (
          <StepRow
            key={s.id}
            step={s}
            index={i}
            total={steps.length}
            agents={agents}
            allSteps={steps}
            onChange={(updated) => updateStep(i, updated)}
            onMoveUp={() => moveUp(i)}
            onMoveDown={() => moveDown(i)}
            onRemove={() => removeStep(i)}
          />
        ))}

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
              + {STEP_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex justify-end">
        <Button size="sm" variant="primary" onClick={handleSave}>
          {workflow ? '保存修改' : '创建工作流'}
        </Button>
      </div>
    </div>
  );
}
