import { useState } from 'react';
import { Button } from '../components/Button.js';
import { useLocale } from '../context/i18n.js';
import { rpc } from '../hooks/useRpc.js';
import { useToast } from '../hooks/useToast.js';

type ModelProviderKind = 'anthropic' | 'openai' | 'google' | 'ollama' | 'openai-compat';
type Step = 'model' | 'agent' | 'done';

interface ProviderHint {
  label: string;
  needsKey: boolean;
  needsBase: boolean;
  keyHint: string;
  baseHint: string;
  modelHint: string;
  groupHint: string;
}

const PROVIDER_HINTS: Record<ModelProviderKind, ProviderHint> = {
  'openai-compat': {
    label: 'OpenAI-Compatible（DeepSeek / Qwen / 讯飞 等）',
    needsKey: true,
    needsBase: true,
    keyHint: 'sk-xxxxxxxxxxxxxxxxxx',
    baseHint: 'https://api.deepseek.com/v1',
    modelHint: 'deepseek-chat',
    groupHint: 'deepseek',
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    needsKey: true,
    needsBase: false,
    keyHint: 'sk-ant-api03-...',
    baseHint: '',
    modelHint: 'claude-3-5-haiku-20241022',
    groupHint: 'claude',
  },
  openai: {
    label: 'OpenAI',
    needsKey: true,
    needsBase: false,
    keyHint: 'sk-proj-...',
    baseHint: '',
    modelHint: 'gpt-4o-mini',
    groupHint: 'openai',
  },
  google: {
    label: 'Google Gemini',
    needsKey: true,
    needsBase: false,
    keyHint: 'AIzaSy...',
    baseHint: '',
    modelHint: 'gemini-1.5-flash',
    groupHint: 'google',
  },
  ollama: {
    label: 'Ollama（本地部署）',
    needsKey: false,
    needsBase: true,
    keyHint: '',
    baseHint: 'http://localhost:11434/v1',
    modelHint: 'qwen2.5:7b',
    groupHint: 'local',
  },
};

interface ModelFormState {
  groupName: string;
  provider: ModelProviderKind;
  apiKey: string;
  apiBaseUrl: string;
  modelId: string;
  modelKey: string;
}

interface AgentFormState {
  id: string;
  name: string;
  model: string;
}

// ── Tiny UI helpers ───────────────────────────────────────────────────────────

function StepDot({ n, active, done }: { n: number; active: boolean; done: boolean }) {
  return (
    <div
      className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 transition-all ${
        done
          ? 'bg-emerald-500 text-white'
          : active
            ? 'bg-indigo-500 text-white shadow-md shadow-indigo-500/30'
            : 'bg-slate-700/80 text-slate-500'
      }`}
    >
      {done ? (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        n
      )}
    </div>
  );
}

function StepSeparator({ done }: { done: boolean }) {
  return (
    <div
      className={`h-px flex-1 mx-1 transition-colors ${done ? 'bg-emerald-500/50' : 'bg-slate-700/60'}`}
    />
  );
}

function Field({
  label,
  hint,
  children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-slate-300">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-slate-500 leading-relaxed">{hint}</p>}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoComplete="off"
      className="bg-slate-800/70 border border-slate-700/60 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500/80 focus:outline-none focus:ring-1 focus:ring-indigo-500/70 w-full transition-all"
    />
  );
}

function SelectInput({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-slate-800/70 border border-slate-700/60 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/70 w-full"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ── Step 1: Model ─────────────────────────────────────────────────────────────

function ModelStep({ onNext, onSkip }: { onNext: (modelRef: string) => void; onSkip: () => void }) {
  const { toast } = useToast();
  const { t } = useLocale();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<ModelFormState>({
    groupName: 'deepseek',
    provider: 'openai-compat',
    apiKey: '',
    apiBaseUrl: 'https://api.deepseek.com/v1',
    modelId: 'deepseek-chat',
    modelKey: 'chat',
  });

  function applyProvider(p: ModelProviderKind) {
    const h = PROVIDER_HINTS[p];
    setForm((prev) => ({
      ...prev,
      provider: p,
      groupName: h.groupHint,
      apiBaseUrl: h.baseHint,
      modelId: h.modelHint,
      modelKey: 'chat',
    }));
  }

  const hint = PROVIDER_HINTS[form.provider];
  const modelRef =
    form.groupName.trim() && form.modelKey.trim()
      ? `${form.groupName.trim()}/${form.modelKey.trim()}`
      : '';

  async function save() {
    if (!form.groupName.trim()) {
      toast(t('setup.model.validGroupName'), 'error');
      return;
    }
    if (!form.modelId.trim()) {
      toast(t('setup.model.validModelId'), 'error');
      return;
    }
    if (!form.modelKey.trim()) {
      toast(t('setup.model.validModelKey'), 'error');
      return;
    }
    if (hint.needsKey && !form.apiKey.trim()) {
      toast(t('setup.model.validApiKey'), 'error');
      return;
    }
    if (hint.needsBase && !form.apiBaseUrl.trim()) {
      toast(t('setup.model.validApiBaseUrl'), 'error');
      return;
    }

    setSaving(true);
    try {
      const cfg = await rpc<Record<string, unknown>>('config.get');
      const models = (cfg.models ?? {}) as Record<string, unknown>;
      const newGroup: Record<string, unknown> = {
        provider: form.provider,
        models: {
          [form.modelKey.trim()]: { id: form.modelId.trim(), maxTokens: 8192 },
        },
      };
      if (form.apiKey.trim()) newGroup.apiKey = form.apiKey.trim();
      if (form.apiBaseUrl.trim()) newGroup.apiBaseUrl = form.apiBaseUrl.trim();

      await rpc('config.save', {
        ...cfg,
        models: { ...models, [form.groupName.trim()]: newGroup },
        defaults: {
          ...((cfg.defaults ?? {}) as Record<string, unknown>),
          model: modelRef,
        },
      });
      toast(t('setup.model.saved'), 'success');
      onNext(modelRef);
    } catch (e) {
      toast(e instanceof Error ? e.message : t('common.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-[15px] font-semibold text-slate-100">{t('setup.step1.title')}</h2>
        <p className="text-xs text-slate-500 mt-1 leading-relaxed">
          {t('setup.model.description')}
        </p>
      </div>

      <div className="grid gap-3.5">
        <Field label={t('setup.model.provider')}>
          <SelectInput
            value={form.provider}
            onChange={(v) => applyProvider(v as ModelProviderKind)}
            options={Object.entries(PROVIDER_HINTS).map(([k, v]) => ({ value: k, label: v.label }))}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('setup.model.groupName')} hint={t('setup.model.groupHint')}>
            <TextInput
              value={form.groupName}
              onChange={(v) => setForm({ ...form, groupName: v })}
              placeholder="deepseek"
            />
          </Field>
          <Field label={t('setup.model.modelKey')} hint={modelRef ? t('setup.model.modelRefHint', { ref: modelRef }) : t('setup.model.modelKeyHint')}>
            <TextInput
              value={form.modelKey}
              onChange={(v) => setForm({ ...form, modelKey: v })}
              placeholder="chat"
            />
          </Field>
        </div>

        <Field label={t('setup.model.modelId')} hint={t('setup.model.modelIdHint')}>
          <TextInput
            value={form.modelId}
            onChange={(v) => setForm({ ...form, modelId: v })}
            placeholder={hint.modelHint}
          />
        </Field>

        {hint.needsBase && (
          <Field label={t('setup.model.apiBaseUrl')}>
            <TextInput
              value={form.apiBaseUrl}
              onChange={(v) => setForm({ ...form, apiBaseUrl: v })}
              placeholder={hint.baseHint}
            />
          </Field>
        )}

        {hint.needsKey && (
          <Field label={t('setup.model.apiKey')}>
            <TextInput
              value={form.apiKey}
              onChange={(v) => setForm({ ...form, apiKey: v })}
              placeholder={hint.keyHint}
              type="password"
            />
          </Field>
        )}
      </div>

      {modelRef && (
        <div
          className="rounded-lg px-3.5 py-2.5 text-xs font-mono"
          style={{
            background: 'rgba(99,102,241,0.07)',
            border: '1px solid rgba(99,102,241,0.18)',
          }}
        >
          <span className="text-slate-500">{t('setup.model.modelRefLabel')}</span>
          <span className="text-indigo-300">{modelRef}</span>
        </div>
      )}

      <div className="flex items-center gap-3 pt-1">
        <Button variant="primary" onClick={() => void save()} disabled={saving}>
          {saving ? t('setup.saving') : t('setup.save')}
        </Button>
        <button
          onClick={onSkip}
          className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
        >
          {t('setup.model.skip')}
        </button>
      </div>
    </div>
  );
}

// ── Step 2: Agent ─────────────────────────────────────────────────────────────

function AgentStep({
  modelRef,
  onNext,
  onBack,
}: {
  modelRef: string;
  onNext: () => void;
  onBack: () => void;
}) {
  const { toast } = useToast();
  const { t } = useLocale();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<AgentFormState>({
    id: 'main',
    name: 'Main Agent',
    model: modelRef,
  });

  async function save() {
    if (!form.id.trim()) {
      toast(t('setup.agent.validId'), 'error');
      return;
    }

    setSaving(true);
    try {
      const cfg = await rpc<Record<string, unknown>>('config.get');
      const agents = Array.isArray(cfg.agents) ? (cfg.agents as Record<string, unknown>[]) : [];

      const newAgent: Record<string, unknown> = {
        id: form.id.trim(),
        name: form.name.trim() || form.id.trim(),
        model: form.model.trim(),
        mesh: {
          role: 'coordinator',
          capabilities: [],
          accepts: ['task', 'query', 'notification'],
          visibility: 'public',
          triggers: [],
        },
        owners: [],
        tools: { deny: [], approval: ['bash'] },
        persona: { language: 'zh-CN', outputDir: 'output' },
      };

      const idx = agents.findIndex((a) => a.id === form.id.trim());
      const newAgents =
        idx >= 0 ? agents.map((a, i) => (i === idx ? newAgent : a)) : [...agents, newAgent];

      await rpc('config.save', { ...cfg, agents: newAgents });
      toast(t('setup.agent.saved'), 'success');
      onNext();
    } catch (e) {
      toast(e instanceof Error ? e.message : t('common.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-[15px] font-semibold text-slate-100">{t('setup.step2.title')}</h2>
        <p className="text-xs text-slate-500 mt-1 leading-relaxed">
          {t('setup.agent.description')}
        </p>
      </div>

      <div className="grid gap-3.5">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('setup.agent.agentId')} hint={t('setup.agent.agentIdHint')}>
            <TextInput
              value={form.id}
              onChange={(v) => setForm({ ...form, id: v })}
              placeholder="main"
            />
          </Field>
          <Field label={t('setup.agent.agentName')}>
            <TextInput
              value={form.name}
              onChange={(v) => setForm({ ...form, name: v })}
              placeholder="Main Agent"
            />
          </Field>
        </div>

        <Field label={t('setup.agent.model')} hint={t('setup.agent.modelHint')}>
          <TextInput
            value={form.model}
            onChange={(v) => setForm({ ...form, model: v })}
            placeholder={modelRef || 'deepseek/chat'}
          />
        </Field>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <Button variant="ghost" onClick={onBack}>
          {t('setup.back')}
        </Button>
        <Button variant="primary" onClick={() => void save()} disabled={saving}>
          {saving ? t('setup.saving') : t('setup.save')}
        </Button>
      </div>
    </div>
  );
}

// ── Step 3: Done ──────────────────────────────────────────────────────────────

function DoneStep({
  onGoChat,
  onGoOverview,
}: {
  onGoChat: () => void;
  onGoOverview: () => void;
}) {
  const { t } = useLocale();
  return (
    <div className="flex flex-col items-center gap-6 py-6 text-center">
      <div
        className="w-16 h-16 rounded-full flex items-center justify-center"
        style={{
          background: 'linear-gradient(135deg, rgba(16,185,129,0.18), rgba(5,150,105,0.12))',
          border: '1px solid rgba(16,185,129,0.3)',
          boxShadow: '0 6px 24px rgba(16,185,129,0.12)',
        }}
      >
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#10b981"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>

      <div>
        <h2 className="text-[15px] font-semibold text-slate-100">{t('setup.done.title')}</h2>
        <p className="text-xs text-slate-500 mt-2 max-w-xs leading-relaxed">
          {t('setup.done.description', { tab: 'Chat' })}
        </p>
      </div>

      <div className="flex items-center gap-3 flex-wrap justify-center">
        <Button variant="primary" onClick={onGoChat}>
          {t('setup.finish')}
        </Button>
        <Button variant="ghost" onClick={onGoOverview}>
          {t('setup.goOverview')}
        </Button>
      </div>
    </div>
  );
}

// ── Main wizard ───────────────────────────────────────────────────────────────

export function SetupWizard({ onDone }: { onDone: (goToChat?: boolean) => void }) {
  const [step, setStep] = useState<Step>('model');
  const [modelRef, setModelRef] = useState('');
  const { t } = useLocale();

  const stepIndex = step === 'model' ? 0 : step === 'agent' ? 1 : 2;

  const STEP_LABELS = [t('setup.wizard.stepLabel1'), t('setup.wizard.stepLabel2'), t('setup.wizard.stepLabel3')];

  return (
    <div
      className="flex min-h-screen items-center justify-center p-6"
      style={{
        backgroundColor: '#07090f',
        backgroundImage:
          'radial-gradient(ellipse 80% 50% at 20% -10%, rgba(99,102,241,0.08) 0%, transparent 60%), radial-gradient(ellipse 50% 40% at 80% 110%, rgba(139,92,246,0.05) 0%, transparent 55%)',
        fontFamily: "'Outfit', system-ui, sans-serif",
      }}
    >
      <div className="w-full max-w-lg">
        {/* Brand */}
        <div className="flex items-center gap-3 mb-8">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              boxShadow: '0 4px 16px rgba(99,102,241,0.32)',
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
            </svg>
          </div>
          <div>
            <span className="text-sm font-semibold text-slate-200">AgentFlyer</span>
            <span className="ml-2 text-xs text-slate-500">{t('setup.wizard.subtitle')}</span>
          </div>
        </div>

        {/* Step indicator */}
        <div className="flex items-center mb-7">
          {STEP_LABELS.map((label, i) => (
            <div key={label} className="flex items-center gap-1.5 flex-1 last:flex-none">
              <div className="flex items-center gap-2">
                <StepDot n={i + 1} active={stepIndex === i} done={stepIndex > i} />
                <span
                  className={`text-xs whitespace-nowrap transition-colors ${
                    stepIndex === i
                      ? 'text-slate-200'
                      : stepIndex > i
                        ? 'text-emerald-400/70'
                        : 'text-slate-600'
                  }`}
                >
                  {label}
                </span>
              </div>
              {i < STEP_LABELS.length - 1 && <StepSeparator done={stepIndex > i} />}
            </div>
          ))}
        </div>

        {/* Card */}
        <div
          className="rounded-2xl p-7"
          style={{
            background: 'rgba(14,17,28,0.92)',
            border: '1px solid rgba(255,255,255,0.07)',
            backdropFilter: 'blur(24px)',
            boxShadow: '0 24px 64px rgba(0,0,0,0.4)',
          }}
        >
          {step === 'model' && (
            <ModelStep
              onNext={(ref) => {
                setModelRef(ref);
                setStep('agent');
              }}
              onSkip={() => onDone(false)}
            />
          )}
          {step === 'agent' && (
            <AgentStep
              modelRef={modelRef}
              onNext={() => setStep('done')}
              onBack={() => setStep('model')}
            />
          )}
          {step === 'done' && (
            <DoneStep onGoChat={() => onDone(true)} onGoOverview={() => onDone(false)} />
          )}
        </div>

        <p className="text-center text-[11px] text-slate-600 mt-5">
          {t('setup.wizard.footer')}
        </p>
      </div>
    </div>
  );
}
