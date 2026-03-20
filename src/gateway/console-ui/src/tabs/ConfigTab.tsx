import { createPortal } from 'react-dom'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button } from '../components/Button.js'
import { rpc, useQuery } from '../hooks/useRpc.js'
import { useToast } from '../hooks/useToast.js'
import type { SkillListResult, SkillInfo } from '../types.js'

type BindMode = 'loopback' | 'local' | 'tailscale'
type LogLevel = 'debug' | 'info' | 'warn' | 'error'
type LogFormat = 'json' | 'pretty'
type MeshRole = 'coordinator' | 'worker' | 'specialist' | 'observer'
type Visibility = 'public' | 'private'
type SearchProviderKind = 'tavily' | 'bing' | 'serpapi' | 'duckduckgo'
type ModelProviderKind = 'anthropic' | 'openai' | 'google' | 'ollama' | 'openai-compat'

const PROVIDER_LABELS: Record<ModelProviderKind, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  ollama: 'Ollama',
  'openai-compat': 'OpenAI-Compat',
}

type ConfigSection =
  | 'gateway' | 'channels' | 'models' | 'agents'
  | 'defaults' | 'context' | 'skills' | 'search'
  | 'memory' | 'federation' | 'log' | 'json'

// ─── SVG icon set ──────────────────────────────────────────────
const ConfigIco: Record<ConfigSection, ReactNode> = {
  gateway: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="2" y1="12" x2="22" y2="12"/>
      <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/>
    </svg>
  ),
  channels: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81a19.79 19.79 0 01-3.07-8.68 2 2 0 012-2.18h3a2 2 0 012 1.72 12.88 12.88 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 6a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.88 12.88 0 002.81.7 2 2 0 011.72 2z"/>
    </svg>
  ),
  models: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a2 2 0 012 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 017 7h1a1 1 0 01.97 1.24L21.5 18H20a5 5 0 01-9.9 0H8a5 5 0 01-9.9 0H2a1 1 0 01-1-1V14A7 7 0 018 7h1V5.73a2 2 0 01-1-1.73 2 2 0 012-2z"/>
      <circle cx="12" cy="14" r="1" fill="currentColor"/>
      <circle cx="8" cy="14" r="1" fill="currentColor"/>
      <circle cx="16" cy="14" r="1" fill="currentColor"/>
    </svg>
  ),
  agents: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 00-3-3.87"/>
      <path d="M16 3.13a4 4 0 010 7.75"/>
    </svg>
  ),
  defaults: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.07 4.93l-1.41 1.41M5.34 5.34L3.93 3.93M19.07 19.07l-1.41-1.41M5.34 18.66l-1.41 1.41M21 12h-2M5 12H3M12 21v-2M12 5V3"/>
    </svg>
  ),
  context: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3"/>
      <path d="M21 12c0 1.66-4.03 3-9 3S3 13.66 3 12"/>
      <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/>
    </svg>
  ),
  skills: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>
    </svg>
  ),
  search: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  ),
  memory: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5" width="20" height="14" rx="2"/>
      <line x1="2" y1="10" x2="22" y2="10"/>
      <line x1="7" y1="15" x2="7.01" y2="15" strokeWidth="2.5"/>
      <line x1="12" y1="15" x2="12.01" y2="15" strokeWidth="2.5"/>
      <line x1="17" y1="15" x2="17.01" y2="15" strokeWidth="2.5"/>
    </svg>
  ),
  federation: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/>
      <line x1="12" y1="7" x2="5" y2="17"/>
      <line x1="12" y1="7" x2="19" y2="17"/>
      <line x1="5" y1="19" x2="19" y2="19"/>
    </svg>
  ),
  log: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
      <polyline points="14,2 14,8 20,8"/>
      <line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/>
      <line x1="10" y1="9" x2="8" y2="9"/>
    </svg>
  ),
  json: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16,18 22,12 16,6"/>
      <polyline points="8,6 2,12 8,18"/>
    </svg>
  ),
}

const NAV_SECTIONS: { id: ConfigSection; label: string }[] = [
  { id: 'gateway',    label: 'Gateway'    },
  { id: 'channels',   label: 'Channels'   },
  { id: 'models',     label: 'Models'     },
  { id: 'agents',     label: 'Agents'     },
  { id: 'defaults',   label: 'Defaults'   },
  { id: 'context',    label: 'Context'    },
  { id: 'skills',     label: 'Skills'     },
  { id: 'search',     label: 'Search'     },
  { id: 'memory',     label: 'Memory'     },
  { id: 'federation', label: 'Federation' },
  { id: 'log',        label: 'Logging'    },
  { id: 'json',       label: 'Raw JSON'   },
]

const CAPABILITY_OPTIONS = ['code', 'analysis', 'web_search', 'writing'] as const
const ACCEPT_OPTIONS = ['task', 'query', 'notification'] as const
const TOOL_OPTIONS = ['bash', 'read_file', 'grep_search', 'fetch_webpage', 'web_search', 'mesh_list', 'mesh_send', 'mesh_spawn', 'mesh_status', 'write_file'] as const

interface GroupedModelDef {
  id: string
  maxTokens: number
  temperature?: number
}

interface ModelGroup {
  provider: ModelProviderKind
  apiKey?: string
  apiBaseUrl?: string
  models: Record<string, GroupedModelDef>
}

interface GatewayConfig {
  bind: BindMode
  port: number
  auth: { mode: 'token'; token?: string }
}

interface DefaultsConfig {
  model: string
  maxTokens: number
  workspace?: string
}

interface ContextConfig {
  compaction: { soft: number; medium: number; hard: number }
  systemPrompt: { maxTokens: number; lazy: boolean }
}

interface SkillsConfig {
  dirs: string[]
  compact: boolean
  summaryLength: number
}

interface SearchTavily {
  provider: 'tavily'
  apiKey: string
  maxResults: number
  searchDepth: 'basic' | 'advanced'
}

interface SearchBing {
  provider: 'bing'
  apiKey: string
  maxResults: number
  market: string
}

interface SearchSerpApi {
  provider: 'serpapi'
  apiKey: string
  maxResults: number
  engine: string
  hl: string
  gl: string
}

interface SearchDuckDuckGo {
  provider: 'duckduckgo'
  maxResults: number
  region: string
}

type SearchProvider = SearchTavily | SearchBing | SearchSerpApi | SearchDuckDuckGo

interface SearchConfig {
  providers: SearchProvider[]
}

interface MemoryConfig {
  enabled: boolean
  embed: { model: string; provider: 'local' | 'api' }
  decay: { enabled: boolean; halfLifeDays: number }
  maxEntries: number
}

interface FederationPeer {
  nodeId: string
  host: string
  port: number
  publicKeyHex: string
}

interface FederationConfig {
  enabled: boolean
  peers: FederationPeer[]
  discovery: { mdns: boolean; tailscale: boolean; static: boolean }
  economy: {
    mode: 'isolated' | 'invite-only' | 'open-network'
    earn: { maxDaily: number; maxPerTask: number }
    spend: { maxDaily: number; minBalance: number }
    peerToolPolicy: 'none' | 'read-only' | 'safe' | 'full'
    notifications: { onContribution: boolean; monthlyReport: boolean }
  }
}

interface AgentConfig {
  id: string
  name?: string
  workspace?: string
  skills: string[]
  model?: string
  mesh: {
    role: MeshRole
    capabilities: string[]
    accepts: string[]
    visibility: Visibility
    triggers: string[]
  }
  owners: string[]
  tools: { allow?: string[]; deny: string[]; approval: string[] }
  persona: { language: string; outputDir: string }
  soulFile?: string
  agentsFile?: string
}

interface LogConfig {
  level: LogLevel
  format: LogFormat
}

interface ChannelsConfig {
  defaults: {
    output: 'logs' | 'cli' | 'web' | 'telegram' | 'discord' | 'feishu' | 'qq'
    schedulerOutput: 'logs' | 'cli' | 'web' | 'telegram' | 'discord' | 'feishu' | 'qq'
  }
  cli: { enabled: boolean }
  web: { enabled: boolean }
  logs: { enabled: boolean }
  telegram: {
    enabled: boolean
    botToken: string
    defaultAgentId: string
    allowedChatIds: number[]
    pollIntervalMs: number
  }
  discord: {
    enabled: boolean
    botToken: string
    defaultAgentId: string
    allowedChannelIds: string[]
    commandPrefix: string
  }
  feishu: {
    enabled: boolean
    appId: string
    appSecret: string
    verificationToken: string
    encryptKey: string
    defaultAgentId: string
    allowedChatIds: string[]
  }
  qq: {
    enabled: boolean
    appId: string
    clientSecret: string
    defaultAgentId: string
    allowedGroupIds: string[]
  }
}

interface ConfigShape {
  version: number
  gateway: GatewayConfig
  models: Record<string, ModelGroup>
  defaults: DefaultsConfig
  context: ContextConfig
  agents: AgentConfig[]
  skills: SkillsConfig
  search: SearchConfig
  memory: MemoryConfig
  federation: FederationConfig
  channels: ChannelsConfig
  log: LogConfig
}

interface GroupModalState {
  mode: 'add' | 'edit'
  originalKey?: string
  groupName: string
  draft: Omit<ModelGroup, 'models'>
}

interface ModelInGroupModalState {
  mode: 'add' | 'edit'
  groupName: string
  originalModelKey?: string
  modelKey: string
  draft: GroupedModelDef
}

interface AgentModalState {
  mode: 'add' | 'edit'
  index?: number
  draft: AgentConfig
}

interface SearchModalState {
  mode: 'add' | 'edit'
  index?: number
  draft: SearchProvider
}

interface PeerModalState {
  mode: 'add' | 'edit'
  index?: number
  draft: FederationPeer
}

function asStringArray(value: string): string[] {
  return value.split(',').map((v) => v.trim()).filter(Boolean)
}

function toCsv(values: string[] | undefined): string {
  return (values ?? []).join(', ')
}

function defaultSearchProvider(kind: SearchProviderKind): SearchProvider {
  if (kind === 'tavily') return { provider: 'tavily', apiKey: '', maxResults: 5, searchDepth: 'basic' }
  if (kind === 'bing') return { provider: 'bing', apiKey: '', maxResults: 5, market: 'zh-CN' }
  if (kind === 'serpapi') return { provider: 'serpapi', apiKey: '', maxResults: 5, engine: 'google', hl: 'zh-cn', gl: 'cn' }
  return { provider: 'duckduckgo', maxResults: 5, region: 'cn-zh' }
}

function defaultAgent(index: number): AgentConfig {
  return {
    id: `agent-${index + 1}`,
    name: `Agent ${index + 1}`,
    workspace: '',
    skills: [],
    model: '',
    mesh: {
      role: 'worker',
      capabilities: ['code'],
      accepts: ['task', 'query', 'notification'],
      visibility: 'public',
      triggers: [],
    },
    owners: [],
    tools: { allow: [], deny: [], approval: ['bash'] },
    persona: { language: 'zh-CN', outputDir: 'output' },
  }
}

function defaultPeer(index: number): FederationPeer {
  return { nodeId: `peer-${index + 1}`, host: '127.0.0.1', port: 19789, publicKeyHex: '' }
}

function ensureConfigShape(raw: unknown): ConfigShape {
  const data = raw as ConfigShape
  // Migrate legacy flat model entries { provider, id, maxTokens } → grouped format
  if (data.models && typeof data.models === 'object') {
    const migrated: Record<string, ModelGroup> = {}
    for (const [key, entry] of Object.entries(data.models)) {
      const e = entry as ModelGroup | { provider: ModelProviderKind; id: string; maxTokens: number; temperature?: number; apiKey?: string; apiBaseUrl?: string }
      if ('models' in e && e.models !== null && typeof e.models === 'object') {
        migrated[key] = e as ModelGroup
      } else {
        const flat = e as { provider: ModelProviderKind; id: string; maxTokens: number; temperature?: number; apiKey?: string; apiBaseUrl?: string }
        migrated[key] = {
          provider: flat.provider,
          apiKey: flat.apiKey,
          apiBaseUrl: flat.apiBaseUrl,
          models: { default: { id: flat.id, maxTokens: flat.maxTokens, temperature: flat.temperature } },
        }
      }
    }
    data.models = migrated
  }
  return data
}

// ── UI Primitives ────────────────────────────────────────────────────────────

function HelpTip({ text }: { text: string }) {
  return (
    <span className="relative inline-flex items-center group">
      <span className="h-4 w-4 rounded-full bg-slate-700 hover:bg-slate-600 text-[10px] text-slate-300 inline-flex items-center justify-center cursor-help transition-colors">?</span>
      <span className="pointer-events-none absolute z-20 left-6 top-1/2 -translate-y-1/2 hidden group-hover:block whitespace-pre-wrap w-72 rounded-lg bg-slate-900 ring-1 ring-slate-600/80 shadow-xl px-3 py-2 text-[11px] text-slate-200 leading-relaxed">
        {text}
      </span>
    </span>
  )
}

function FieldLabel({ label, help }: { label: string; help: string }) {
  return (
    <span className="text-sm text-slate-300 inline-flex items-center gap-2 font-medium">
      {label}
      <HelpTip text={help} />
    </span>
  )
}

function PanelSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section
      className="rounded-xl p-5 flex flex-col gap-4 ring-1 ring-white/[0.07]"
      style={{ background: 'rgba(14,17,28,0.85)' }}
    >
      <div>
        <h3 className="text-[13px] font-semibold text-slate-100">{title}</h3>
        {description && <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{description}</p>}
      </div>
      {children}
    </section>
  )
}

function FieldRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4 items-center">{children}</div>
}

const inputCls = 'bg-slate-900/80 ring-1 ring-slate-700 focus:ring-indigo-500/60 focus:outline-none text-slate-200 text-sm rounded-lg px-3 py-2 transition-shadow w-full'
const selectCls = 'bg-slate-900/80 ring-1 ring-slate-700 focus:ring-indigo-500/60 focus:outline-none text-slate-200 text-sm rounded-lg px-3 py-2 transition-shadow w-full'

function TextRow({ label, help, value, onChange, placeholder }: {
  label: string; help: string; value?: string; onChange: (value: string) => void; placeholder?: string
}) {
  return (
    <FieldRow>
      <FieldLabel label={label} help={help} />
      <input value={value ?? ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={inputCls} />
    </FieldRow>
  )
}

function NumberRow({ label, help, value, min, max, onChange }: {
  label: string; help: string; value: number; min?: number; max?: number; onChange: (value: number) => void
}) {
  return (
    <FieldRow>
      <FieldLabel label={label} help={help} />
      <input type="number" min={min} max={max} value={Number.isFinite(value) ? String(value) : '0'} onChange={(e) => onChange(Number(e.target.value))} className={inputCls} />
    </FieldRow>
  )
}

function ToggleRow({ label, help, checked, onChange }: {
  label: string; help: string; checked: boolean; onChange: (next: boolean) => void
}) {
  return (
    <FieldRow>
      <FieldLabel label={label} help={help} />
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 ${checked ? 'bg-indigo-600' : 'bg-slate-700'}`}
      >
        <span className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
    </FieldRow>
  )
}

function SelectRow<T extends string>({ label, help, value, options, onChange }: {
  label: string; help: string; value: T; options: T[]; onChange: (value: T) => void
}) {
  return (
    <FieldRow>
      <FieldLabel label={label} help={help} />
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className={selectCls}>
        {options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    </FieldRow>
  )
}

// Model select grouped by user-named groups — uses <optgroup> per group,
// options are "groupName/modelKey" values so references are unambiguous.
function GroupedModelSelect({ label, help, value, onChange, modelGroups, includeNone = false }: {
  label: string; help: string; value: string
  onChange: (v: string) => void
  modelGroups: Record<string, ModelGroup>
  includeNone?: boolean
}) {
  const groups = Object.entries(modelGroups)

  return (
    <FieldRow>
      <FieldLabel label={label} help={help} />
      <select value={value} onChange={(e) => onChange(e.target.value)} className={selectCls}>
        {(includeNone || groups.length === 0) && <option value="">— (default) —</option>}
        {groups.map(([groupName, group]) => {
          const models = Object.entries(group.models ?? {})
          if (models.length === 0) return null
          return (
            <optgroup key={groupName} label={`${groupName} (${PROVIDER_LABELS[group.provider] ?? group.provider})`}>
              {models.map(([modelKey, def]) => (
                <option key={`${groupName}/${modelKey}`} value={`${groupName}/${modelKey}`}>
                  {modelKey} — {def.id || '(no id)'}
                </option>
              ))}
            </optgroup>
          )
        })}
      </select>
    </FieldRow>
  )
}

function MultiChoiceRow({ label, help, options, selected, onChange }: {
  label: string; help: string; options: readonly string[]; selected: string[]; onChange: (values: string[]) => void
}) {
  return (
    <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4 items-start">
      <FieldLabel label={label} help={help} />
      <div className="grid grid-cols-2 gap-2">
        {options.map((opt) => {
          const checked = selected.includes(opt)
          return (
            <label key={opt} className="inline-flex items-center gap-2 text-sm text-slate-300 bg-slate-800/60 ring-1 ring-slate-700/40 rounded-lg px-3 py-2 cursor-pointer hover:bg-slate-700/60 transition-colors">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => {
                  if (e.target.checked) onChange([...selected, opt])
                  else onChange(selected.filter((v) => v !== opt))
                }}
                className="accent-indigo-500"
              />
              {opt}
            </label>
          )
        })}
      </div>
    </div>
  )
}

// CSV field that only commits to parent on blur — prevents trailing-comma being stripped mid-typing
function DeferredTextRow({ label, help, value, onChange, placeholder }: {
  label: string; help: string; value?: string; onChange: (value: string) => void; placeholder?: string
}) {
  const [local, setLocal] = useState(value ?? '')
  useEffect(() => { setLocal(value ?? '') }, [value])
  return (
    <FieldRow>
      <FieldLabel label={label} help={help} />
      <input
        value={local}
        placeholder={placeholder}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => onChange(local)}
        className={inputCls}
      />
    </FieldRow>
  )
}

// Tag-input with optional preset quick-toggle chips + free-form custom entry
function TagInputRow({ label, help, values, presets, onChange }: {
  label: string
  help: string
  values: string[]
  presets?: readonly string[]
  onChange: (values: string[]) => void
}) {
  const [inputVal, setInputVal] = useState('')

  function commit(raw: string) {
    const tag = raw.trim()
    if (tag && !values.includes(tag)) onChange([...values, tag])
    setInputVal('')
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commit(inputVal)
    } else if (e.key === 'Backspace' && inputVal === '' && values.length > 0) {
      onChange(values.slice(0, -1))
    }
  }

  return (
    <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4 items-start">
      <FieldLabel label={label} help={help} />
      <div className="flex flex-col gap-2">
        {/* Preset quick-toggle chips */}
        {presets && presets.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {presets.map((opt) => {
              const active = values.includes(opt)
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => {
                    if (active) onChange(values.filter((v) => v !== opt))
                    else onChange([...values, opt])
                  }}
                  className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                    active
                      ? 'bg-indigo-600/30 border-indigo-500/50 text-indigo-300'
                      : 'border-slate-700/60 text-slate-500 hover:text-slate-200 hover:border-slate-600'
                  }`}
                  style={active ? {} : { background: 'rgba(30,34,50,0.6)' }}
                >
                  {opt}
                </button>
              )
            })}
          </div>
        )}
        {/* Tag display + custom-entry input */}
        <div className="min-h-[36px] flex flex-wrap gap-1.5 items-center ring-1 ring-slate-700 focus-within:ring-indigo-500/60 rounded-lg px-2 py-1.5 transition-shadow" style={{ background: 'rgba(15,18,30,0.8)' }}>
          {values.map((tag) => (
            <span key={tag} className="inline-flex items-center gap-1 text-xs bg-slate-700/70 text-slate-200 rounded-md px-2 py-0.5 shrink-0">
              {tag}
              <button
                type="button"
                onClick={() => onChange(values.filter((v) => v !== tag))}
                className="text-slate-400 hover:text-white leading-none ml-0.5"
                aria-label={`Remove ${tag}`}
              >×</button>
            </span>
          ))}
          <input
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => { if (inputVal.trim()) commit(inputVal) }}
            placeholder={values.length === 0 ? 'Enter or , to add…' : ''}
            className="flex-1 min-w-[100px] bg-transparent text-slate-200 text-sm outline-none placeholder:text-slate-600"
          />
        </div>
      </div>
    </div>
  )
}

function ListSummary({ values }: { values: string[] }) {
  return <span className="text-sm text-slate-400">{values.length > 0 ? values.join(', ') : 'none'}</span>
}

function ItemCard({ children }: { children: ReactNode }) {
  return (
    <div
      className="rounded-xl px-4 py-3 flex items-center justify-between gap-3 ring-1 ring-white/[0.07] hover:ring-white/[0.12] transition-all"
      style={{ background: 'rgba(12,15,24,0.7)' }}
    >
      {children}
    </div>
  )
}

function FormModal({ title, description, onClose, onSubmit, children }: {
  title: string; description: string; onClose: () => void; onSubmit: () => void; children: ReactNode
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center backdrop-blur-sm"
      style={{ background: 'rgba(0,0,0,0.65)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="w-full max-w-2xl mx-4 rounded-2xl flex flex-col overflow-hidden"
        style={{
          maxHeight: '85vh',
          background: 'linear-gradient(160deg, rgba(20,23,37,0.98) 0%, rgba(12,14,22,0.98) 100%)',
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(99,102,241,0.08) inset',
        }}
      >
        {/* Header — fixed */}
        <div className="px-6 pt-6 pb-4 shrink-0">
          <h3 className="text-[15px] font-semibold text-slate-100">{title}</h3>
          <p className="text-sm text-slate-400 mt-1 leading-relaxed">{description}</p>
        </div>

        {/* Scrollable form area */}
        <div className="flex-1 overflow-y-auto px-6">
          <div className="flex flex-col gap-4 pb-2">{children}</div>
        </div>

        {/* Footer — fixed at bottom */}
        <div
          className="px-6 py-4 flex justify-end gap-2 shrink-0"
          style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
        >
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={onSubmit}>Confirm</Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── Config Panels ────────────────────────────────────────────────────────────

interface PanelProps {
  cfg: ConfigShape
  onChange: (next: ConfigShape) => void
  modelKeys: string[]
  availableSkills: SkillInfo[]
  groupModal: GroupModalState | null
  setGroupModal: (m: GroupModalState | null) => void
  modelInGroupModal: ModelInGroupModalState | null
  setModelInGroupModal: (m: ModelInGroupModalState | null) => void
  agentModal: AgentModalState | null
  setAgentModal: (m: AgentModalState | null) => void
  searchModal: SearchModalState | null
  setSearchModal: (m: SearchModalState | null) => void
  peerModal: PeerModalState | null
  setPeerModal: (m: PeerModalState | null) => void
}

function GatewayPanel({ cfg, onChange }: Pick<PanelProps, 'cfg' | 'onChange'>) {
  return (
    <PanelSection title="Gateway" description="Network binding, port, and authentication settings.">
      <SelectRow
        label="Bind mode"
        help="Network interface to bind the gateway.\n• loopback — 127.0.0.1 only\n• local — all LAN interfaces\n• tailscale — Tailscale VPN interface"
        value={cfg.gateway.bind}
        options={['loopback', 'local', 'tailscale']}
        onChange={(bind) => onChange({ ...cfg, gateway: { ...cfg.gateway, bind } })}
      />
      <NumberRow
        label="Port"
        help="TCP port the gateway listens on."
        value={cfg.gateway.port}
        min={1}
        max={65535}
        onChange={(port) => onChange({ ...cfg, gateway: { ...cfg.gateway, port } })}
      />
      <TextRow
        label="Auth token"
        help="Bearer token for RPC authentication. Clients must send: Authorization: Bearer <token>."
        value={cfg.gateway.auth.token ?? ''}
        placeholder="(leave blank to disable auth)"
        onChange={(token) => onChange({ ...cfg, gateway: { ...cfg.gateway, auth: { ...cfg.gateway.auth, token } } })}
      />
    </PanelSection>
  )
}

function ChannelsPanel({ cfg, onChange }: Pick<PanelProps, 'cfg' | 'onChange'>) {
  return (
    <div className="flex flex-col gap-4">
      <PanelSection title="Defaults" description="Default output channel for agent replies and scheduler tasks.">
        <SelectRow label="Default output" help="Channel for agent reply routing when not specified per-session." value={cfg.channels.defaults.output} options={['logs', 'cli', 'web', 'telegram', 'discord', 'feishu', 'qq']} onChange={(output) => onChange({ ...cfg, channels: { ...cfg.channels, defaults: { ...cfg.channels.defaults, output } } })} />
        <SelectRow label="Scheduler output" help="Channel for scheduled task result delivery." value={cfg.channels.defaults.schedulerOutput} options={['logs', 'cli', 'web', 'telegram', 'discord', 'feishu', 'qq']} onChange={(schedulerOutput) => onChange({ ...cfg, channels: { ...cfg.channels, defaults: { ...cfg.channels.defaults, schedulerOutput } } })} />
      </PanelSection>

      <PanelSection title="Built-in Channels" description="CLI, Web UI, and Logs output channels.">
        <ToggleRow label="CLI channel" help="Enable CLI interactive channel." checked={cfg.channels.cli?.enabled ?? false} onChange={(enabled) => onChange({ ...cfg, channels: { ...cfg.channels, cli: { enabled } } })} />
        <ToggleRow label="Web channel" help="Enable web console channel." checked={cfg.channels.web?.enabled ?? false} onChange={(enabled) => onChange({ ...cfg, channels: { ...cfg.channels, web: { enabled } } })} />
        <ToggleRow label="Logs channel" help="Route replies to gateway log output." checked={cfg.channels.logs?.enabled ?? false} onChange={(enabled) => onChange({ ...cfg, channels: { ...cfg.channels, logs: { enabled } } })} />
      </PanelSection>

      <PanelSection title="Telegram" description="Telegram bot via long-polling.">
        <ToggleRow label="Enabled" help="Enable Telegram bot channel." checked={cfg.channels.telegram?.enabled ?? false} onChange={(enabled) => onChange({ ...cfg, channels: { ...cfg.channels, telegram: { ...cfg.channels.telegram, enabled } } })} />
        {cfg.channels.telegram?.enabled && (
          <div className="pl-4 border-l-2 border-indigo-600/40 flex flex-col gap-3">
            <TextRow label="Bot token" help="Telegram bot token from @BotFather." value={cfg.channels.telegram.botToken} onChange={(botToken) => onChange({ ...cfg, channels: { ...cfg.channels, telegram: { ...cfg.channels.telegram, botToken } } })} />
            <TextRow label="Default agent ID" help="Agent that handles Telegram messages." value={cfg.channels.telegram.defaultAgentId ?? 'main'} onChange={(defaultAgentId) => onChange({ ...cfg, channels: { ...cfg.channels, telegram: { ...cfg.channels.telegram, defaultAgentId } } })} />
            <TextRow label="Allowed chat IDs" help="Comma-separated numeric chat IDs. Empty = allow all." value={(cfg.channels.telegram.allowedChatIds ?? []).join(', ')} onChange={(raw) => { const allowedChatIds = raw.split(',').map((s) => Number(s.trim())).filter(Number.isFinite); onChange({ ...cfg, channels: { ...cfg.channels, telegram: { ...cfg.channels.telegram, allowedChatIds } } }) }} />
            <NumberRow label="Poll interval (ms)" help="Long-poll interval in milliseconds." value={cfg.channels.telegram.pollIntervalMs ?? 1000} min={500} onChange={(pollIntervalMs) => onChange({ ...cfg, channels: { ...cfg.channels, telegram: { ...cfg.channels.telegram, pollIntervalMs } } })} />
          </div>
        )}
      </PanelSection>

      <PanelSection title="Discord" description="Discord bot using slash commands.">
        <ToggleRow label="Enabled" help="Enable Discord bot channel." checked={cfg.channels.discord?.enabled ?? false} onChange={(enabled) => onChange({ ...cfg, channels: { ...cfg.channels, discord: { ...cfg.channels.discord, enabled } } })} />
        {cfg.channels.discord?.enabled && (
          <div className="pl-4 border-l-2 border-indigo-600/40 flex flex-col gap-3">
            <TextRow label="Bot token" help="Discord bot token from Discord Developer Portal." value={cfg.channels.discord.botToken} onChange={(botToken) => onChange({ ...cfg, channels: { ...cfg.channels, discord: { ...cfg.channels.discord, botToken } } })} />
            <TextRow label="Default agent ID" help="Agent that handles Discord messages." value={cfg.channels.discord.defaultAgentId ?? 'main'} onChange={(defaultAgentId) => onChange({ ...cfg, channels: { ...cfg.channels, discord: { ...cfg.channels.discord, defaultAgentId } } })} />
            <TextRow label="Command prefix" help="Prefix for bot commands (e.g. !)." value={cfg.channels.discord.commandPrefix ?? '!'} onChange={(commandPrefix) => onChange({ ...cfg, channels: { ...cfg.channels, discord: { ...cfg.channels.discord, commandPrefix } } })} />
            <TextRow label="Allowed channel IDs" help="Comma-separated Discord channel IDs. Empty = allow all." value={(cfg.channels.discord.allowedChannelIds ?? []).join(', ')} onChange={(raw) => { const allowedChannelIds = raw.split(',').map((s) => s.trim()).filter(Boolean); onChange({ ...cfg, channels: { ...cfg.channels, discord: { ...cfg.channels.discord, allowedChannelIds } } }) }} />
          </div>
        )}
      </PanelSection>

      <PanelSection title="Feishu / Lark" description="Feishu Open Platform webhook events.">
        <ToggleRow label="Enabled" help="Enable Feishu bot channel. Configure event subscription URL in Feishu as: https://your-gateway/channels/feishu/event" checked={cfg.channels.feishu?.enabled ?? false} onChange={(enabled) => onChange({ ...cfg, channels: { ...cfg.channels, feishu: { ...cfg.channels.feishu, enabled } } })} />
        {cfg.channels.feishu?.enabled && (
          <div className="pl-4 border-l-2 border-indigo-600/40 flex flex-col gap-3">
            <TextRow label="App ID" help="Feishu Open Platform App ID (e.g. cli_xxxxxxxx)." value={cfg.channels.feishu.appId ?? ''} onChange={(appId) => onChange({ ...cfg, channels: { ...cfg.channels, feishu: { ...cfg.channels.feishu, appId } } })} />
            <TextRow label="App Secret" help="Feishu App Secret. Keep this secret." value={cfg.channels.feishu.appSecret ?? ''} onChange={(appSecret) => onChange({ ...cfg, channels: { ...cfg.channels, feishu: { ...cfg.channels.feishu, appSecret } } })} />
            <TextRow label="Verification token" help="Legacy verification token from event subscription page. Leave blank if using Encrypt Key." value={cfg.channels.feishu.verificationToken ?? ''} onChange={(verificationToken) => onChange({ ...cfg, channels: { ...cfg.channels, feishu: { ...cfg.channels.feishu, verificationToken } } })} />
            <TextRow label="Encrypt key" help="AES encrypt key for event payload decryption (recommended)." value={cfg.channels.feishu.encryptKey ?? ''} onChange={(encryptKey) => onChange({ ...cfg, channels: { ...cfg.channels, feishu: { ...cfg.channels.feishu, encryptKey } } })} />
            <TextRow label="Default agent ID" help="Agent that receives Feishu messages." value={cfg.channels.feishu.defaultAgentId ?? 'main'} onChange={(defaultAgentId) => onChange({ ...cfg, channels: { ...cfg.channels, feishu: { ...cfg.channels.feishu, defaultAgentId } } })} />
            <TextRow label="Allowed chat IDs" help="Comma-separated Feishu chat IDs. Empty = allow all." value={(cfg.channels.feishu.allowedChatIds ?? []).join(', ')} onChange={(raw) => { const allowedChatIds = raw.split(',').map((s) => s.trim()).filter(Boolean); onChange({ ...cfg, channels: { ...cfg.channels, feishu: { ...cfg.channels.feishu, allowedChatIds } } }) }} />
          </div>
        )}
      </PanelSection>

      <PanelSection title="QQ 开放平台" description="QQ Open Platform webhook events.">
        <ToggleRow label="Enabled" help="Enable QQ bot channel. Configure callback URL as: https://your-gateway/channels/qq/event" checked={cfg.channels.qq?.enabled ?? false} onChange={(enabled) => onChange({ ...cfg, channels: { ...cfg.channels, qq: { ...cfg.channels.qq, enabled } } })} />
        {cfg.channels.qq?.enabled && (
          <div className="pl-4 border-l-2 border-indigo-600/40 flex flex-col gap-3">
            <TextRow label="App ID" help="QQ Open Platform App ID." value={cfg.channels.qq.appId ?? ''} onChange={(appId) => onChange({ ...cfg, channels: { ...cfg.channels, qq: { ...cfg.channels.qq, appId } } })} />
            <TextRow label="Client secret" help="QQ App client secret. Used for access token and Ed25519 webhook verification." value={cfg.channels.qq.clientSecret ?? ''} onChange={(clientSecret) => onChange({ ...cfg, channels: { ...cfg.channels, qq: { ...cfg.channels.qq, clientSecret } } })} />
            <TextRow label="Default agent ID" help="Agent that receives QQ messages." value={cfg.channels.qq.defaultAgentId ?? 'main'} onChange={(defaultAgentId) => onChange({ ...cfg, channels: { ...cfg.channels, qq: { ...cfg.channels.qq, defaultAgentId } } })} />
            <TextRow label="Allowed group IDs" help="Comma-separated QQ group openids. Empty = allow all." value={(cfg.channels.qq.allowedGroupIds ?? []).join(', ')} onChange={(raw) => { const allowedGroupIds = raw.split(',').map((s) => s.trim()).filter(Boolean); onChange({ ...cfg, channels: { ...cfg.channels, qq: { ...cfg.channels.qq, allowedGroupIds } } }) }} />
          </div>
        )}
      </PanelSection>
    </div>
  )
}

function ModelsPanel({ cfg, onChange, groupModal, setGroupModal, modelInGroupModal, setModelInGroupModal }: Pick<PanelProps, 'cfg' | 'onChange' | 'groupModal' | 'setGroupModal' | 'modelInGroupModal' | 'setModelInGroupModal'>) {
  function openAddGroup() {
    setGroupModal({ mode: 'add', groupName: '', draft: { provider: 'openai-compat' } })
  }

  function openEditGroup(groupName: string, group: ModelGroup) {
    setGroupModal({ mode: 'edit', originalKey: groupName, groupName, draft: { provider: group.provider, apiKey: group.apiKey, apiBaseUrl: group.apiBaseUrl } })
  }

  function openAddModel(groupName: string) {
    const count = Object.keys(cfg.models[groupName]?.models ?? {}).length
    setModelInGroupModal({ mode: 'add', groupName, modelKey: `model-${count + 1}`, draft: { id: '', maxTokens: 8192 } })
  }

  function openEditModel(groupName: string, modelKey: string, def: GroupedModelDef) {
    setModelInGroupModal({ mode: 'edit', groupName, originalModelKey: modelKey, modelKey, draft: { ...def } })
  }

  const groups = Object.entries(cfg.models)

  return (
    <PanelSection
      title="Model Groups"
      description='Group models by provider. Credentials (API key / base URL) are shared per group. Reference a model as "groupName/modelKey" in agent and defaults config.'
    >
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={openAddGroup}>+ New Group</Button>
      </div>

      {groups.length === 0 && (
        <p className="text-sm text-slate-500 text-center py-4">No model groups configured. Add a group to get started.</p>
      )}

      <div className="flex flex-col gap-3">
        {groups.map(([groupName, group]) => {
          const modelEntries = Object.entries(group.models ?? {})
          const hasApiKey = !!(group.apiKey?.trim())
          const hasBaseUrl = !!(group.apiBaseUrl?.trim())
          return (
            <div key={groupName} className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
              {/* Group header — shows group name, provider, shared credentials */}
              <div
                className="flex items-center gap-3 px-4 py-2.5"
                style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
              >
                <span className="text-[13px] font-bold text-slate-100 shrink-0">{groupName}</span>
                <span className="text-[10px] font-bold text-indigo-300 uppercase tracking-wider shrink-0">
                  {PROVIDER_LABELS[group.provider] ?? group.provider}
                </span>
                {hasApiKey && (
                  <span className="text-xs text-slate-500 font-mono shrink-0">
                    {group.apiKey!.slice(0, 6)}{'\u2022'.repeat(Math.min(8, Math.max(0, group.apiKey!.length - 6)))}
                  </span>
                )}
                {hasBaseUrl && (
                  <span className="text-xs text-slate-500 font-mono truncate max-w-[200px]">{group.apiBaseUrl}</span>
                )}
                <span className="text-xs text-slate-600 shrink-0">
                  {modelEntries.length}&nbsp;model{modelEntries.length !== 1 ? 's' : ''}
                </span>
                <div className="ml-auto flex gap-2 shrink-0">
                  <Button size="sm" variant="ghost" onClick={() => openEditGroup(groupName, group)}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => openAddModel(groupName)}>+ Add Model</Button>
                  <Button size="sm" variant="danger" onClick={() => {
                    const next = { ...cfg.models }
                    delete next[groupName]
                    onChange({ ...cfg, models: next })
                  }}>Remove</Button>
                </div>
              </div>

              {/* Model rows inside this group */}
              {modelEntries.length === 0 ? (
                <div className="px-4 py-3 text-xs text-slate-600 italic">No models yet — use "+ Add Model".</div>
              ) : (
                modelEntries.map(([modelKey, def]) => (
                  <div
                    key={modelKey}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-800/30 transition-colors"
                    style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}
                  >
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-semibold text-slate-200">{modelKey}</span>
                      <span className="mx-1.5 text-slate-700">·</span>
                      <span className="text-xs text-slate-400 font-mono">{def.id || <em className="text-slate-600">no id</em>}</span>
                      <span className="ml-2 text-[10px] text-slate-600 font-mono bg-slate-800/60 px-1.5 py-0.5 rounded">
                        {groupName}/{modelKey}
                      </span>
                    </div>
                    <span className="text-xs text-slate-500 shrink-0">
                      max&nbsp;{def.maxTokens.toLocaleString()}
                      {def.temperature !== undefined ? ` · temp ${def.temperature}` : ''}
                    </span>
                    <div className="flex gap-2 shrink-0">
                      <Button size="sm" variant="ghost" onClick={() => openEditModel(groupName, modelKey, def)}>Edit</Button>
                      <Button size="sm" variant="danger" onClick={() => {
                        const nextModels = { ...group.models }
                        delete nextModels[modelKey]
                        onChange({ ...cfg, models: { ...cfg.models, [groupName]: { ...group, models: nextModels } } })
                      }}>Remove</Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )
        })}
      </div>
    </PanelSection>
  )
}

function AgentsPanel({ cfg, onChange, modelKeys, availableSkills, agentModal, setAgentModal }: Pick<PanelProps, 'cfg' | 'onChange' | 'modelKeys' | 'availableSkills' | 'agentModal' | 'setAgentModal'>) {
  return (
    <PanelSection title="Agent Nodes" description="Configure agents. Each agent runs independently with its own model, skills, mesh role, and tools policy.">
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => setAgentModal({ mode: 'add', draft: defaultAgent(cfg.agents.length) })}>+ Add Agent</Button>
      </div>
      {cfg.agents.length === 0 && (
        <p className="text-sm text-slate-500 text-center py-4">No agents configured.</p>
      )}
      <div className="flex flex-col gap-2">
        {cfg.agents.map((agent, idx) => (
          <ItemCard key={`${agent.id}-${idx}`}>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-slate-200">{agent.id}{agent.name ? ` · ${agent.name}` : ''}</div>
              <div className="text-xs text-slate-500 mt-0.5">model={agent.model || '(default)'} · role={agent.mesh.role} · accepts: <ListSummary values={agent.mesh.accepts} /></div>
              {(agent.soulFile || agent.agentsFile) && (
                <div className="text-xs text-slate-500 mt-0.5">
                  {agent.soulFile && <span>soul: <span className="text-slate-400 font-mono">{agent.soulFile}</span></span>}
                  {agent.soulFile && agent.agentsFile && <span className="mx-1">·</span>}
                  {agent.agentsFile && <span>agents: <span className="text-slate-400 font-mono">{agent.agentsFile}</span></span>}
                </div>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              <Button size="sm" variant="ghost" onClick={() => setAgentModal({ mode: 'edit', index: idx, draft: { ...agent, mesh: { ...agent.mesh }, tools: { ...agent.tools }, persona: { ...agent.persona } } })}>Edit</Button>
              <Button size="sm" variant="danger" onClick={() => onChange({ ...cfg, agents: cfg.agents.filter((_, i) => i !== idx) })}>Remove</Button>
            </div>
          </ItemCard>
        ))}
      </div>
    </PanelSection>
  )
}

function DefaultsPanel({ cfg, onChange }: Pick<PanelProps, 'cfg' | 'onChange'>) {
  return (
    <PanelSection title="Defaults" description="Fallback settings used when an agent does not override them.">
      <GroupedModelSelect label="Default model" help='Reference as "groupName/modelKey". Must match a model in the registry.' value={cfg.defaults.model} modelGroups={cfg.models} onChange={(model) => onChange({ ...cfg, defaults: { ...cfg.defaults, model } })} />
      <NumberRow label="Default max tokens" help="Token budget when agent-level max tokens is not set." value={cfg.defaults.maxTokens} min={1} onChange={(maxTokens) => onChange({ ...cfg, defaults: { ...cfg.defaults, maxTokens } })} />
      <TextRow label="Default workspace" help="Workspace path fallback for agents without a workspace." value={cfg.defaults.workspace ?? ''} onChange={(workspace) => onChange({ ...cfg, defaults: { ...cfg.defaults, workspace } })} />
    </PanelSection>
  )
}

function ContextPanel({ cfg, onChange }: Pick<PanelProps, 'cfg' | 'onChange'>) {
  return (
    <PanelSection title="Context & Compaction" description="Token compaction thresholds and system prompt settings.">
      <NumberRow label="Soft threshold" help="Ratio at which soft compaction is triggered (0–1)." value={cfg.context.compaction.soft} min={0} max={1} onChange={(soft) => onChange({ ...cfg, context: { ...cfg.context, compaction: { ...cfg.context.compaction, soft } } })} />
      <NumberRow label="Medium threshold" help="Ratio at which medium compaction is triggered (0–1)." value={cfg.context.compaction.medium} min={0} max={1} onChange={(medium) => onChange({ ...cfg, context: { ...cfg.context, compaction: { ...cfg.context.compaction, medium } } })} />
      <NumberRow label="Hard threshold" help="Ratio at which hard compaction is triggered (0–1)." value={cfg.context.compaction.hard} min={0} max={1} onChange={(hard) => onChange({ ...cfg, context: { ...cfg.context, compaction: { ...cfg.context.compaction, hard } } })} />
      <ToggleRow label="Lazy system prompt" help="Enable lazy loading of large prompt resources." checked={cfg.context.systemPrompt.lazy} onChange={(lazy) => onChange({ ...cfg, context: { ...cfg.context, systemPrompt: { ...cfg.context.systemPrompt, lazy } } })} />
    </PanelSection>
  )
}

function SkillsPanel({ cfg, onChange, availableSkills }: Pick<PanelProps, 'cfg' | 'onChange' | 'availableSkills'>) {
  return (
    <div className="flex flex-col gap-4">
      <PanelSection title="Skill Pool Settings" description="Global skill directories and compaction behaviour.">
        <ToggleRow label="Compact summaries" help="Inject compact skill summaries into agent system prompt." checked={cfg.skills.compact} onChange={(compact) => onChange({ ...cfg, skills: { ...cfg.skills, compact } })} />
      </PanelSection>

      <PanelSection title="Extra Skill Directories" description="Additional directories scanned for SKILL.md files. Default dirs (~/.agentflyer/skills, workspace/skills) are always included.">
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => {
            const dir = window.prompt('Enter directory path to add to skill pool:')
            if (dir?.trim()) onChange({ ...cfg, skills: { ...cfg.skills, dirs: [...(cfg.skills.dirs ?? []), dir.trim()] } })
          }}>+ Add Dir</Button>
        </div>
        {(cfg.skills.dirs ?? []).length === 0 ? (
          <p className="text-sm text-slate-500">No extra dirs configured. Default dirs are always scanned.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {(cfg.skills.dirs ?? []).map((dir, i) => (
              <ItemCard key={`${dir}-${i}`}>
                <span className="text-sm font-mono text-slate-300 truncate flex-1">{dir}</span>
                <Button size="sm" variant="danger" onClick={() => onChange({ ...cfg, skills: { ...cfg.skills, dirs: (cfg.skills.dirs ?? []).filter((_, j) => j !== i) } })}>Remove</Button>
              </ItemCard>
            ))}
          </div>
        )}
      </PanelSection>

      <PanelSection title={`Discovered Skills (${availableSkills.length})`} description="Skills currently found in the pool.">
        {availableSkills.length === 0 ? (
          <p className="text-sm text-slate-500">No skills detected. Add skill dirs or place SKILL.md files in ~/.agentflyer/skills/.</p>
        ) : (
          <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
            {availableSkills.map((sk) => (
              <div key={sk.id} className="rounded-lg bg-slate-900/50 ring-1 ring-slate-700/40 px-3 py-2.5 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-slate-200">{sk.name}</span>
                  <span className="text-xs text-slate-500 ml-2">{sk.shortDesc}</span>
                </div>
                {sk.apiKeyRequired && <span className="text-xs text-amber-400 shrink-0 bg-amber-400/10 px-1.5 py-0.5 rounded">key req'd</span>}
              </div>
            ))}
          </div>
        )}
      </PanelSection>
    </div>
  )
}

function SearchPanel({ cfg, onChange, searchModal, setSearchModal }: Pick<PanelProps, 'cfg' | 'onChange' | 'searchModal' | 'setSearchModal'>) {
  return (
    <PanelSection title="Search Providers" description="Ordered search provider chain. Each provider is tried in sequence.">
      <div className="flex items-center justify-end gap-2">
        {(['tavily', 'bing', 'serpapi', 'duckduckgo'] as SearchProviderKind[]).map((kind) => (
          <Button key={kind} size="sm" variant="ghost" onClick={() => setSearchModal({ mode: 'add', draft: defaultSearchProvider(kind) })}>+ {kind}</Button>
        ))}
      </div>
      {cfg.search.providers.length === 0 && (
        <p className="text-sm text-slate-500 text-center py-4">No search providers configured.</p>
      )}
      <div className="flex flex-col gap-2">
        {cfg.search.providers.map((provider, idx) => (
          <ItemCard key={`${provider.provider}-${idx}`}>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-slate-200 capitalize">{provider.provider}</div>
              <div className="text-xs text-slate-500 mt-0.5">max {provider.maxResults} results</div>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button size="sm" variant="ghost" onClick={() => setSearchModal({ mode: 'edit', index: idx, draft: { ...provider } as SearchProvider })}>Edit</Button>
              <Button size="sm" variant="danger" onClick={() => onChange({ ...cfg, search: { ...cfg.search, providers: cfg.search.providers.filter((_, i) => i !== idx) } })}>Remove</Button>
            </div>
          </ItemCard>
        ))}
      </div>
    </PanelSection>
  )
}

function MemoryPanel({ cfg, onChange }: Pick<PanelProps, 'cfg' | 'onChange'>) {
  return (
    <PanelSection title="Memory" description="Memory embedding, decay, and retention settings.">
      <ToggleRow label="Enabled" help="Enable the memory module." checked={cfg.memory.enabled} onChange={(enabled) => onChange({ ...cfg, memory: { ...cfg.memory, enabled } })} />
      <SelectRow label="Embed provider" help="Embedding provider mode." value={cfg.memory.embed.provider} options={['local', 'api']} onChange={(provider) => onChange({ ...cfg, memory: { ...cfg.memory, embed: { ...cfg.memory.embed, provider } } })} />
      <TextRow label="Embed model" help="Embedding model used for memory vectorization." value={cfg.memory.embed.model} onChange={(model) => onChange({ ...cfg, memory: { ...cfg.memory, embed: { ...cfg.memory.embed, model } } })} />
      <ToggleRow label="Decay enabled" help="Enable time-decay scoring on memory retrieval." checked={cfg.memory.decay.enabled} onChange={(enabled) => onChange({ ...cfg, memory: { ...cfg.memory, decay: { ...cfg.memory.decay, enabled } } })} />
      <NumberRow label="Half-life (days)" help="Memory strength decay half-life in days." value={cfg.memory.decay.halfLifeDays} min={1} onChange={(halfLifeDays) => onChange({ ...cfg, memory: { ...cfg.memory, decay: { ...cfg.memory.decay, halfLifeDays } } })} />
      <NumberRow label="Max entries" help="Maximum number of retained memory entries." value={cfg.memory.maxEntries} min={1} onChange={(maxEntries) => onChange({ ...cfg, memory: { ...cfg.memory, maxEntries } })} />
    </PanelSection>
  )
}

function FederationPanel({ cfg, onChange, peerModal, setPeerModal }: Pick<PanelProps, 'cfg' | 'onChange' | 'peerModal' | 'setPeerModal'>) {
  return (
    <div className="flex flex-col gap-4">
      <PanelSection title="Federation Settings" description="Enable/disable federation and configure peer discovery and economy.">
        <ToggleRow label="Enabled" help="Enable federation network behavior." checked={cfg.federation.enabled} onChange={(enabled) => onChange({ ...cfg, federation: { ...cfg.federation, enabled } })} />
        <ToggleRow label="mDNS discovery" help="Enable LAN peer discovery with mDNS." checked={cfg.federation.discovery.mdns} onChange={(mdns) => onChange({ ...cfg, federation: { ...cfg.federation, discovery: { ...cfg.federation.discovery, mdns } } })} />
        <ToggleRow label="Tailscale discovery" help="Enable peer discovery via Tailscale network." checked={cfg.federation.discovery.tailscale} onChange={(tailscale) => onChange({ ...cfg, federation: { ...cfg.federation, discovery: { ...cfg.federation.discovery, tailscale } } })} />
        <SelectRow label="Economy mode" help="Token economy participation mode." value={cfg.federation.economy.mode} options={['isolated', 'invite-only', 'open-network']} onChange={(modeValue) => onChange({ ...cfg, federation: { ...cfg.federation, economy: { ...cfg.federation.economy, mode: modeValue } } })} />
        <SelectRow label="Peer tool policy" help="Allowed remote tool policy for federation peers." value={cfg.federation.economy.peerToolPolicy} options={['none', 'read-only', 'safe', 'full']} onChange={(peerToolPolicy) => onChange({ ...cfg, federation: { ...cfg.federation, economy: { ...cfg.federation.economy, peerToolPolicy } } })} />
      </PanelSection>

      <PanelSection title="Federation Peers" description="Known peer nodes for federated task routing.">
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => setPeerModal({ mode: 'add', draft: defaultPeer(cfg.federation.peers.length) })}>+ Add Peer</Button>
        </div>
        {cfg.federation.peers.length === 0 && (
          <p className="text-sm text-slate-500 text-center py-4">No peers configured.</p>
        )}
        <div className="flex flex-col gap-2">
          {cfg.federation.peers.map((peer, idx) => (
            <ItemCard key={`${peer.nodeId}-${idx}`}>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-200">{peer.nodeId}</div>
                <div className="text-xs text-slate-500 mt-0.5">{peer.host}:{peer.port}</div>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button size="sm" variant="ghost" onClick={() => setPeerModal({ mode: 'edit', index: idx, draft: { ...peer } })}>Edit</Button>
                <Button size="sm" variant="danger" onClick={() => onChange({ ...cfg, federation: { ...cfg.federation, peers: cfg.federation.peers.filter((_, i) => i !== idx) } })}>Remove</Button>
              </div>
            </ItemCard>
          ))}
        </div>
      </PanelSection>
    </div>
  )
}

function LogPanel({ cfg, onChange }: Pick<PanelProps, 'cfg' | 'onChange'>) {
  return (
    <PanelSection title="Logging" description="Gateway log level and output format.">
      <SelectRow label="Log level" help="Minimum log severity to output." value={cfg.log.level} options={['debug', 'info', 'warn', 'error']} onChange={(level) => onChange({ ...cfg, log: { ...cfg.log, level } })} />
      <SelectRow label="Log format" help="Output formatter for log lines." value={cfg.log.format} options={['json', 'pretty']} onChange={(format) => onChange({ ...cfg, log: { ...cfg.log, format } })} />
    </PanelSection>
  )
}

// ── Main Component ───────────────────────────────────────────────────────────

export function ConfigTab() {
  const { toast } = useToast()
  const [text, setText] = useState('')
  const [cfg, setCfg] = useState<ConfigShape | null>(null)
  const [activeSection, setActiveSection] = useState<ConfigSection>('gateway')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)

  const [groupModal, setGroupModal] = useState<GroupModalState | null>(null)
  const [modelInGroupModal, setModelInGroupModal] = useState<ModelInGroupModalState | null>(null)
  const [agentModal, setAgentModal] = useState<AgentModalState | null>(null)
  const [searchModal, setSearchModal] = useState<SearchModalState | null>(null)
  const [peerModal, setPeerModal] = useState<PeerModalState | null>(null)

  const { data, loading, error, refetch } = useQuery<unknown>(() => rpc<unknown>('config.get'), [])
  const { data: skillListData } = useQuery<SkillListResult>(() => rpc<SkillListResult>('skill.list'), [])

  useEffect(() => {
    if (data !== null && data !== undefined) {
      setCfg(ensureConfigShape(data))
      setText(JSON.stringify(data, null, 2))
      setDirty(false)
    }
  }, [data])

  const availableSkills: SkillInfo[] = useMemo(() => skillListData?.skills ?? [], [skillListData])
  const modelKeys = useMemo(() => {
    if (!cfg) return []
    return Object.entries(cfg.models).flatMap(([g, grp]) =>
      Object.keys(grp.models ?? {}).map((m) => `${g}/${m}`)
    )
  }, [cfg])

  function handleCfgChange(next: ConfigShape) {
    setCfg(next)
    setText(JSON.stringify(next, null, 2))
    setDirty(true)
    setParseError(null)
  }

  function handleJsonChange(raw: string) {
    setText(raw)
    setDirty(true)
    try {
      setCfg(ensureConfigShape(JSON.parse(raw)))
      setParseError(null)
    } catch {
      setParseError('Invalid JSON — fix before saving.')
    }
  }

  async function handleSave() {
    if (!cfg || parseError) return
    setSaving(true)
    try {
      await rpc('config.save', cfg)
      setDirty(false)
      toast('Config saved', 'success')
    } catch (e) {
      toast(`Save failed: ${String(e)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  function handleReset() {
    refetch()
    setDirty(false)
    setParseError(null)
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-slate-400 text-sm gap-2"><span className="animate-spin">⟳</span> Loading config…</div>
  }
  if (error) {
    return <div className="flex items-center justify-center h-64 text-red-400 text-sm">Failed to load config: {String(error)}</div>
  }

  const panelProps: PanelProps = {
    cfg: cfg!,
    onChange: handleCfgChange,
    modelKeys,
    availableSkills,
    groupModal,
    setGroupModal,
    modelInGroupModal,
    setModelInGroupModal,
    agentModal,
    setAgentModal,
    searchModal,
    setSearchModal,
    peerModal,
    setPeerModal,
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] bg-slate-950">
      {/* ── Left Config Nav ── */}
      <nav
        className="w-52 shrink-0 flex flex-col h-full"
        style={{
          background: 'linear-gradient(180deg, rgba(12,14,22,0.9) 0%, rgba(9,11,18,0.9) 100%)',
          borderRight: '1px solid rgba(255,255,255,0.055)',
        }}
      >
        <div className="px-4 py-[14px]" style={{ borderBottom: '1px solid rgba(255,255,255,0.055)' }}>
          <h2 className="text-[10.5px] font-semibold text-slate-500 uppercase tracking-[0.12em]">Settings</h2>
        </div>

        <div className="flex-1 overflow-y-auto py-2 px-2">
          {NAV_SECTIONS.map(({ id, label }) => {
            const active = activeSection === id
            return (
              <button
                key={id}
                onClick={() => setActiveSection(id)}
                className={`relative w-full flex items-center gap-3 px-3 py-[9px] rounded-lg text-[13px] font-medium mb-px text-left transition-colors duration-150 ${
                  active
                    ? 'text-indigo-300 bg-indigo-500/10'
                    : 'text-slate-500 hover:text-slate-200 hover:bg-white/[0.04]'
                }`}
              >
                {active && (
                  <span className="absolute left-0 top-[7px] bottom-[7px] w-[2px] rounded-r-full bg-indigo-400" />
                )}
                <span className={`shrink-0 ${active ? 'text-indigo-400' : ''}`}>
                  {ConfigIco[id]}
                </span>
                <span className="truncate">{label}</span>
                {dirty && active && (
                  <span className="ml-auto h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
                )}
              </button>
            )
          })}
        </div>

        {/* Save / Reset in nav footer */}
        <div className="px-3 py-3 border-t border-slate-700/50 flex flex-col gap-2">
          {parseError && (
            <p className="text-xs text-red-400 px-1">{parseError}</p>
          )}
          {dirty && !parseError && (
            <p className="text-xs text-amber-400 px-1">Unsaved changes</p>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={saving || !dirty || !!parseError}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReset}
            disabled={saving}
          >
            Reset
          </Button>
        </div>
      </nav>

      {/* ── Right Content Panel ── */}
      <div className="flex-1 overflow-y-auto p-6">
        {!cfg ? (
          <div className="flex items-center justify-center h-64 text-slate-400 text-sm">No config loaded.</div>
        ) : (
          <>
            {activeSection === 'gateway' && <GatewayPanel cfg={cfg} onChange={handleCfgChange} />}
            {activeSection === 'channels' && <ChannelsPanel cfg={cfg} onChange={handleCfgChange} />}
            {activeSection === 'models' && <ModelsPanel {...panelProps} />}
            {activeSection === 'agents' && <AgentsPanel {...panelProps} />}
            {activeSection === 'defaults' && <DefaultsPanel cfg={cfg} onChange={handleCfgChange} modelKeys={modelKeys} />}
            {activeSection === 'context' && <ContextPanel cfg={cfg} onChange={handleCfgChange} />}
            {activeSection === 'skills' && <SkillsPanel cfg={cfg} onChange={handleCfgChange} availableSkills={availableSkills} />}
            {activeSection === 'search' && <SearchPanel {...panelProps} />}
            {activeSection === 'memory' && <MemoryPanel cfg={cfg} onChange={handleCfgChange} />}
            {activeSection === 'federation' && <FederationPanel {...panelProps} />}
            {activeSection === 'log' && <LogPanel cfg={cfg} onChange={handleCfgChange} />}
            {activeSection === 'json' && (
              <PanelSection title="Raw JSON" description="Directly edit the config JSON. Errors block saving.">
                <textarea
                  value={text}
                  onChange={(e) => handleJsonChange(e.target.value)}
                  rows={32}
                  spellCheck={false}
                  className="w-full font-mono text-sm bg-slate-900/80 ring-1 ring-slate-700 focus:ring-indigo-500/60 focus:outline-none text-slate-200 rounded-xl px-4 py-3 resize-none transition-shadow"
                />
              </PanelSection>
            )}
          </>
        )}
      </div>

      {/* ── CRUD Modals ── */}
      {cfg && groupModal && (
        <FormModal
          title={groupModal.mode === 'add' ? 'Add Model Group' : 'Edit Model Group'}
          description="A group shares one provider, API key, and base URL. Add individual models inside the group."
          onClose={() => setGroupModal(null)}
          onSubmit={() => {
            const trimmedName = groupModal.groupName.trim()
            if (!trimmedName) return
            const nextModels = { ...cfg.models }
            if (groupModal.mode === 'edit' && groupModal.originalKey && groupModal.originalKey !== trimmedName) {
              // Rename: preserve existing models sub-object under new key
              const existing = nextModels[groupModal.originalKey]
              delete nextModels[groupModal.originalKey]
              nextModels[trimmedName] = { ...groupModal.draft, models: existing?.models ?? {} }
            } else if (groupModal.mode === 'edit' && groupModal.originalKey) {
              nextModels[groupModal.originalKey] = { ...groupModal.draft, models: nextModels[groupModal.originalKey]?.models ?? {} }
            } else {
              nextModels[trimmedName] = { ...groupModal.draft, models: {} }
            }
            handleCfgChange({ ...cfg, models: nextModels })
            setGroupModal(null)
          }}
        >
          <TextRow label="Group name" help="Short English identifier for this provider group (e.g. deepseek, anthropic). Used as the prefix in model references like groupName/modelKey." value={groupModal.groupName} onChange={(groupName) => setGroupModal({ ...groupModal, groupName })} />
          <SelectRow label="Provider" help="LLM provider protocol for all models in this group." value={groupModal.draft.provider} options={['anthropic', 'openai', 'google', 'ollama', 'openai-compat']} onChange={(provider) => setGroupModal({ ...groupModal, draft: { ...groupModal.draft, provider } })} />
          <TextRow label="API base URL" help="Required for openai-compat and ollama. E.g. https://api.deepseek.com/v1" value={groupModal.draft.apiBaseUrl ?? ''} onChange={(apiBaseUrl) => setGroupModal({ ...groupModal, draft: { ...groupModal.draft, apiBaseUrl } })} />
          <TextRow label="API key" help="Shared API key for all models in this group." value={groupModal.draft.apiKey ?? ''} onChange={(apiKey) => setGroupModal({ ...groupModal, draft: { ...groupModal.draft, apiKey } })} />
        </FormModal>
      )}

      {cfg && modelInGroupModal && (
        <FormModal
          title={modelInGroupModal.mode === 'add' ? `Add Model to "${modelInGroupModal.groupName}"` : `Edit Model in "${modelInGroupModal.groupName}"`}
          description={`Reference this model as ${modelInGroupModal.groupName}/${modelInGroupModal.modelKey || '<key>'} in agent and defaults config.`}
          onClose={() => setModelInGroupModal(null)}
          onSubmit={() => {
            const { groupName, modelKey, originalModelKey, draft } = modelInGroupModal
            const trimmedKey = modelKey.trim()
            if (!trimmedKey) return
            const group = cfg.models[groupName]
            if (!group) return
            const nextGroupModels = { ...group.models }
            if (originalModelKey && originalModelKey !== trimmedKey) {
              delete nextGroupModels[originalModelKey]
            }
            nextGroupModels[trimmedKey] = draft
            handleCfgChange({ ...cfg, models: { ...cfg.models, [groupName]: { ...group, models: nextGroupModels } } })
            setModelInGroupModal(null)
          }}
        >
          <TextRow label="Model key" help='Local key within the group (e.g. chat, fast, reasoner). The full reference will be "groupName/modelKey".' value={modelInGroupModal.modelKey} onChange={(modelKey) => setModelInGroupModal({ ...modelInGroupModal, modelKey })} />
          <TextRow label="Provider model ID" help="Exact model identifier on the provider side (e.g. deepseek-chat, claude-3-5-haiku-latest)." value={modelInGroupModal.draft.id} onChange={(id) => setModelInGroupModal({ ...modelInGroupModal, draft: { ...modelInGroupModal.draft, id } })} />
          <NumberRow label="Max tokens" help="Completion token budget for this model." value={modelInGroupModal.draft.maxTokens} min={1} onChange={(maxTokens) => setModelInGroupModal({ ...modelInGroupModal, draft: { ...modelInGroupModal.draft, maxTokens } })} />
          <NumberRow label="Temperature" help="Sampling temperature in [0, 2]. Leave at 0 to use provider default." value={modelInGroupModal.draft.temperature ?? 0} min={0} max={2} onChange={(temperature) => setModelInGroupModal({ ...modelInGroupModal, draft: { ...modelInGroupModal.draft, temperature } })} />
        </FormModal>
      )}

      {cfg && agentModal && (
        <FormModal
          title={agentModal.mode === 'add' ? 'Add Agent' : 'Edit Agent'}
          description="Configure agent identity, model, mesh role, and tools policy."
          onClose={() => setAgentModal(null)}
          onSubmit={() => {
            const list = [...cfg.agents]
            if (agentModal.mode === 'add') list.push(agentModal.draft)
            else if (agentModal.index !== undefined) list[agentModal.index] = agentModal.draft
            handleCfgChange({ ...cfg, agents: list })
            setAgentModal(null)
          }}
        >
          <TextRow label="Agent ID" help="Unique identifier for routing and sessions." value={agentModal.draft.id} onChange={(id) => setAgentModal({ ...agentModal, draft: { ...agentModal.draft, id } })} />
          <TextRow label="Name" help="Display name for console and logs." value={agentModal.draft.name ?? ''} onChange={(name) => setAgentModal({ ...agentModal, draft: { ...agentModal.draft, name } })} />
          <TextRow label="Workspace" help="Agent workspace path." value={agentModal.draft.workspace ?? ''} onChange={(workspace) => setAgentModal({ ...agentModal, draft: { ...agentModal.draft, workspace } })} />
          <TextRow label="Soul file" help="Optional path of SOUL.md override for this agent." value={agentModal.draft.soulFile ?? ''} onChange={(soulFile) => setAgentModal({ ...agentModal, draft: { ...agentModal.draft, soulFile } })} />
          <TextRow label="Agents file" help="Optional path of AGENTS.md override for this agent." value={agentModal.draft.agentsFile ?? ''} onChange={(agentsFile) => setAgentModal({ ...agentModal, draft: { ...agentModal.draft, agentsFile } })} />
          <GroupedModelSelect label="Model" help='Select from the model registry. Format: "groupName/modelKey".' value={agentModal.draft.model ?? ''} modelGroups={cfg!.models} includeNone onChange={(model) => setAgentModal({ ...agentModal, draft: { ...agentModal.draft, model } })} />
          <SelectRow label="Mesh role" help="Agent role in the distributed mesh." value={agentModal.draft.mesh.role} options={['coordinator', 'worker', 'specialist', 'observer']} onChange={(role) => setAgentModal({ ...agentModal, draft: { ...agentModal.draft, mesh: { ...agentModal.draft.mesh, role } } })} />
          <SelectRow label="Visibility" help="Agent discoverability in mesh." value={agentModal.draft.mesh.visibility} options={['public', 'private']} onChange={(visibility) => setAgentModal({ ...agentModal, draft: { ...agentModal.draft, mesh: { ...agentModal.draft.mesh, visibility } } })} />
          <MultiChoiceRow label="Capabilities" help="Capability flags for this agent." options={CAPABILITY_OPTIONS} selected={agentModal.draft.mesh.capabilities} onChange={(capabilities) => setAgentModal({ ...agentModal, draft: { ...agentModal.draft, mesh: { ...agentModal.draft.mesh, capabilities } } })} />
          <MultiChoiceRow label="Accepts" help="Inbound message kinds this agent handles." options={ACCEPT_OPTIONS} selected={agentModal.draft.mesh.accepts} onChange={(accepts) => setAgentModal({ ...agentModal, draft: { ...agentModal.draft, mesh: { ...agentModal.draft.mesh, accepts } } })} />
          <MultiChoiceRow label="Tools approval" help="Tools requiring interactive user approval." options={TOOL_OPTIONS} selected={agentModal.draft.tools.approval} onChange={(approval) => setAgentModal({ ...agentModal, draft: { ...agentModal.draft, tools: { ...agentModal.draft.tools, approval } } })} />
          <TagInputRow
            label="Tools allow"
            help="Optional tool allowlist — checked preset or custom name. Empty = all tools allowed."
            values={agentModal.draft.tools.allow ?? []}
            presets={TOOL_OPTIONS}
            onChange={(allow) => setAgentModal({ ...agentModal, draft: { ...agentModal.draft, tools: { ...agentModal.draft.tools, allow } } })}
          />
          <TagInputRow
            label="Tools deny"
            help="Tool denylist — these tools are blocked for this agent."
            values={agentModal.draft.tools.deny}
            presets={TOOL_OPTIONS}
            onChange={(deny) => setAgentModal({ ...agentModal, draft: { ...agentModal.draft, tools: { ...agentModal.draft.tools, deny } } })}
          />
          <TagInputRow
            label="Triggers"
            help="Keywords that activate this agent. Press Enter or comma to add each trigger."
            values={agentModal.draft.mesh.triggers}
            onChange={(triggers) => setAgentModal({ ...agentModal, draft: { ...agentModal.draft, mesh: { ...agentModal.draft.mesh, triggers } } })}
          />
          {availableSkills.length > 0 ? (
            <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4 items-start">
              <FieldLabel label="Skills" help="Select skills from the global pool to assign to this agent." />
              <div className="flex flex-col gap-1 max-h-40 overflow-y-auto bg-slate-900/60 ring-1 ring-slate-700/50 rounded-xl p-2">
                {availableSkills.map((sk) => {
                  const checked = agentModal.draft.skills.includes(sk.id)
                  return (
                    <label key={sk.id} className="inline-flex items-start gap-2 text-sm text-slate-300 hover:bg-slate-700/40 rounded-lg px-2 py-1.5 cursor-pointer transition-colors">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const skills = e.target.checked
                            ? [...agentModal.draft.skills, sk.id]
                            : agentModal.draft.skills.filter((s) => s !== sk.id)
                          setAgentModal({ ...agentModal, draft: { ...agentModal.draft, skills } })
                        }}
                        className="mt-0.5 accent-indigo-500 shrink-0"
                      />
                      <span className="flex flex-col gap-0.5">
                        <span className="font-medium">{sk.name}</span>
                        <span className="text-xs text-slate-500">{sk.shortDesc}</span>
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          ) : (
            <DeferredTextRow label="Skills (CSV)" help="Skill IDs assigned to this agent. Add skill dirs in the Skills section." value={toCsv(agentModal.draft.skills)} onChange={(v) => setAgentModal({ ...agentModal, draft: { ...agentModal.draft, skills: asStringArray(v) } })} />
          )}
          <DeferredTextRow label="Owners (CSV)" help="Owner IDs allowed to manage this agent. Comma-separated." value={toCsv(agentModal.draft.owners)} onChange={(v) => setAgentModal({ ...agentModal, draft: { ...agentModal.draft, owners: asStringArray(v) } })} />
          <TextRow label="Persona language" help="BCP-47 language tag for response language." value={agentModal.draft.persona.language} onChange={(language) => setAgentModal({ ...agentModal, draft: { ...agentModal.draft, persona: { ...agentModal.draft.persona, language } } })} />
          <TextRow label="Persona output dir" help="Default output folder under workspace." value={agentModal.draft.persona.outputDir} onChange={(outputDir) => setAgentModal({ ...agentModal, draft: { ...agentModal.draft, persona: { ...agentModal.draft.persona, outputDir } } })} />
        </FormModal>
      )}

      {cfg && searchModal && (
        <FormModal
          title={searchModal.mode === 'add' ? 'Add Search Provider' : 'Edit Search Provider'}
          description="Configure provider type and provider-specific fields."
          onClose={() => setSearchModal(null)}
          onSubmit={() => {
            const providers = [...cfg.search.providers]
            if (searchModal.mode === 'add') providers.push(searchModal.draft)
            else if (searchModal.index !== undefined) providers[searchModal.index] = searchModal.draft
            handleCfgChange({ ...cfg, search: { ...cfg.search, providers } })
            setSearchModal(null)
          }}
        >
          <SelectRow label="Provider" help="Choose provider type." value={searchModal.draft.provider} options={['tavily', 'bing', 'serpapi', 'duckduckgo']} onChange={(provider) => setSearchModal({ ...searchModal, draft: defaultSearchProvider(provider) })} />
          <NumberRow label="Max results" help="Maximum result items per query." value={searchModal.draft.maxResults} min={1} onChange={(maxResults) => setSearchModal({ ...searchModal, draft: { ...searchModal.draft, maxResults } as SearchProvider })} />
          {searchModal.draft.provider === 'tavily' && (
            <>
              <TextRow label="API key" help="Tavily API key." value={searchModal.draft.apiKey} onChange={(apiKey) => setSearchModal({ ...searchModal, draft: { ...searchModal.draft, apiKey } })} />
              <SelectRow label="Search depth" help="Tavily search depth." value={searchModal.draft.searchDepth} options={['basic', 'advanced']} onChange={(searchDepth) => setSearchModal({ ...searchModal, draft: { ...searchModal.draft, searchDepth } })} />
            </>
          )}
          {searchModal.draft.provider === 'bing' && (
            <>
              <TextRow label="API key" help="Bing Search API key." value={searchModal.draft.apiKey} onChange={(apiKey) => setSearchModal({ ...searchModal, draft: { ...searchModal.draft, apiKey } })} />
              <TextRow label="Market" help="Bing market code, e.g. zh-CN." value={searchModal.draft.market} onChange={(market) => setSearchModal({ ...searchModal, draft: { ...searchModal.draft, market } })} />
            </>
          )}
          {searchModal.draft.provider === 'serpapi' && (
            <>
              <TextRow label="API key" help="SerpApi API key." value={searchModal.draft.apiKey} onChange={(apiKey) => setSearchModal({ ...searchModal, draft: { ...searchModal.draft, apiKey } })} />
              <TextRow label="Engine" help="Search engine name for SerpApi." value={searchModal.draft.engine} onChange={(engine) => setSearchModal({ ...searchModal, draft: { ...searchModal.draft, engine } })} />
              <TextRow label="hl" help="Language hint for SerpApi." value={searchModal.draft.hl} onChange={(hl) => setSearchModal({ ...searchModal, draft: { ...searchModal.draft, hl } })} />
              <TextRow label="gl" help="Geo hint for SerpApi." value={searchModal.draft.gl} onChange={(gl) => setSearchModal({ ...searchModal, draft: { ...searchModal.draft, gl } })} />
            </>
          )}
          {searchModal.draft.provider === 'duckduckgo' && (
            <TextRow label="Region" help="DuckDuckGo region code, e.g. cn-zh." value={searchModal.draft.region} onChange={(region) => setSearchModal({ ...searchModal, draft: { ...searchModal.draft, region } })} />
          )}
        </FormModal>
      )}

      {cfg && peerModal && (
        <FormModal
          title={peerModal.mode === 'add' ? 'Add Federation Peer' : 'Edit Federation Peer'}
          description="Configure remote peer endpoint and identity."
          onClose={() => setPeerModal(null)}
          onSubmit={() => {
            const peers = [...cfg.federation.peers]
            if (peerModal.mode === 'add') peers.push(peerModal.draft)
            else if (peerModal.index !== undefined) peers[peerModal.index] = peerModal.draft
            handleCfgChange({ ...cfg, federation: { ...cfg.federation, peers } })
            setPeerModal(null)
          }}
        >
          <TextRow label="Node ID" help="Remote peer node identifier." value={peerModal.draft.nodeId} onChange={(nodeId) => setPeerModal({ ...peerModal, draft: { ...peerModal.draft, nodeId } })} />
          <TextRow label="Host" help="Peer host or IP address." value={peerModal.draft.host} onChange={(host) => setPeerModal({ ...peerModal, draft: { ...peerModal.draft, host } })} />
          <NumberRow label="Port" help="Peer gateway port." value={peerModal.draft.port} min={1} max={65535} onChange={(port) => setPeerModal({ ...peerModal, draft: { ...peerModal.draft, port } })} />
          <TextRow label="Public key (hex)" help="Ed25519 public key in hex for signature verification." value={peerModal.draft.publicKeyHex} onChange={(publicKeyHex) => setPeerModal({ ...peerModal, draft: { ...peerModal.draft, publicKeyHex } })} />
        </FormModal>
      )}
    </div>
  )
}
