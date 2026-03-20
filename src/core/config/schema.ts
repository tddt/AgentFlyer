import { z } from 'zod';

// ─── Gateway ──────────────────────────────────────────────────────────────────

const BindModeSchema = z.enum(['loopback', 'local', 'tailscale']);

const AuthSchema = z.object({
  mode: z.enum(['token']).default('token'),
  token: z.string().optional(),
});

const GatewaySchema = z.object({
  bind: BindModeSchema.default('loopback'),
  port: z.number().int().min(1024).max(65535).default(19789),
  auth: AuthSchema.default({}),
});

// ─── Model registry ───────────────────────────────────────────────────────────

/** A single model definition nested inside a model group. */
const ModelDefSchema = z.object({
  id: z.string(),
  maxTokens: z.number().int().positive().default(8192),
  temperature: z.number().min(0).max(2).optional(),
});

/**
 * A user-named model group.
 * apiKey / apiBaseUrl are defined once per group; models are referenced as "groupName/modelKey".
 */
const ModelGroupSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'google', 'ollama', 'openai-compat']),
  /** Used for ollama and openai-compat providers. */
  apiBaseUrl: z.string().optional(),
  /** API key for openai-compat/ollama providers. For production use ~/.agentflyer/credentials/. */
  apiKey: z.string().optional(),
  /** Named models within this group. Reference as "groupName/modelKey". */
  models: z.record(z.string(), ModelDefSchema).default({}),
});

/** Named model registry: groupName → ModelGroup. Models referenced as "groupName/modelKey". */
const ModelRegistrySchema = z.record(z.string(), ModelGroupSchema);

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DefaultsConfigSchema = z.object({
  /** Key into the models registry used when an agent does not specify a model. */
  model: z.string().default('fast'),
  maxTokens: z.number().int().positive().default(8192),
  workspace: z.string().optional(),
});

// ─── Context window management ────────────────────────────────────────────────

const ContextConfigSchema = z.object({
  compaction: z.object({
    /** Fill fraction at which soft compaction begins (compress old messages). */
    soft: z.number().min(0).max(1).default(0.40),
    /** Fill fraction for medium compaction (keep recent N rounds). */
    medium: z.number().min(0).max(1).default(0.60),
    /** Fill fraction for hard compaction (summary + last 1-2 rounds only). */
    hard: z.number().min(0).max(1).default(0.80),
  }).default({}),
  systemPrompt: z.object({
    maxTokens: z.number().int().positive().default(1200),
    /** Lazy-load Layer 2 files (AGENTS.md / SOUL.md) only on first relevant turn. */
    lazy: z.boolean().default(true),
  }).default({}),
});

// ─── Agent mesh ───────────────────────────────────────────────────────────────

const MeshRoleSchema = z.enum(['coordinator', 'worker', 'specialist', 'observer']);

const AgentMeshConfigSchema = z.object({
  role: MeshRoleSchema.default('worker'),
  capabilities: z.array(z.string()).default([]),
  accepts: z.array(z.string()).default(['task', 'query', 'notification']),
  visibility: z.enum(['public', 'private']).default('public'),
  /**
   * Natural-language trigger phrases that hint this agent should be activated.
   * E.g. ["搜索", "查资料", "search"] will route messages containing these words here.
   */
  triggers: z.array(z.string()).default([]),
});

// ─── Agent persona ────────────────────────────────────────────────────────────

export const AgentPersonaSchema = z.object({
  /**
   * Preferred response language (BCP-47 tag).
   * "zh-CN" 默认中文回复；"en-US" 英文回复。
   * Identity、personality 等叙述性内容请编辑工作区的 SOUL.md。
   */
  language: z.string().default('zh-CN'),
  /**
   * Default output subdirectory name inside the agent workspace.
   * Defaults to "output". An absolute path overrides workspace-relative resolution.
   */
  outputDir: z.string().default('output'),
});

// ─── Tool access policy ───────────────────────────────────────────────────────

/** Per-agent tool access configuration. */
const ToolsConfigSchema = z.object({
  /** Explicit allowlist — if set, only listed tools are accessible. */
  allow: z.array(z.string()).optional(),
  /** Tools that are always blocked regardless of allowlist. */
  deny: z.array(z.string()).default([]),
  /** Tools that require interactive user approval before execution. */
  approval: z.array(z.string()).default(['bash']),
});

// ─── Agent ───────────────────────────────────────────────────────────────────

export const AgentConfigSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  workspace: z.string().optional(),
  skills: z.array(z.string()).default([]),
  /** Key into the models registry. Falls back to defaults.model when absent. */
  model: z.string().optional(),
  mesh: AgentMeshConfigSchema.default({}),
  owners: z.array(z.string()).default([]),
  tools: ToolsConfigSchema.default({}),
  persona: AgentPersonaSchema.default({}),
  soulFile: z.string().optional(),
  agentsFile: z.string().optional(),
});

// ─── Skills ───────────────────────────────────────────────────────────────────

const SkillsConfigSchema = z.object({
  /** Extra skill directories to scan (in addition to ~/.agentflyer/skills). */
  dirs: z.array(z.string()).default([]),
  compact: z.boolean().default(true),
  /** Maximum characters for auto-extracted short descriptions. */
  summaryLength: z.number().int().min(20).max(200).default(60),
});

// ─── Web search ────────────────────────────────────────────────────────────────────────────────

const TavilySearchSchema = z.object({
  provider: z.literal('tavily'),
  apiKey: z.string(),
  maxResults: z.number().int().positive().default(5),
  searchDepth: z.enum(['basic', 'advanced']).default('basic'),
});

const BingSearchSchema = z.object({
  provider: z.literal('bing'),
  /** Azure Cognitive Services Bing Search v7 API key. */
  apiKey: z.string(),
  maxResults: z.number().int().positive().default(5),
  market: z.string().default('zh-CN'),
});

const SerpApiSearchSchema = z.object({
  provider: z.literal('serpapi'),
  apiKey: z.string(),
  maxResults: z.number().int().positive().default(5),
  engine: z.string().default('google'),
  hl: z.string().default('zh-cn'),
  gl: z.string().default('cn'),
});

const DuckDuckGoSearchSchema = z.object({
  provider: z.literal('duckduckgo'),
  maxResults: z.number().int().positive().default(5),
  region: z.string().default('cn-zh'),
});

const SearchProviderConfigSchema = z.discriminatedUnion('provider', [
  TavilySearchSchema,
  BingSearchSchema,
  SerpApiSearchSchema,
  DuckDuckGoSearchSchema,
]);

export type SearchProviderConfig = z.infer<typeof SearchProviderConfigSchema>;

const SearchConfigSchema = z.object({
  /**
   * Ordered list of configured search providers.
   * The first entry is used by default; callers can specify provider by name.
   */
  providers: z.array(SearchProviderConfigSchema).default([]),
});

// ─── Memory ───────────────────────────────────────────────────────────────────

const EmbedConfigSchema = z.object({
  model: z.string().default('Xenova/all-MiniLM-L6-v2'),
  provider: z.enum(['local', 'api']).default('local'),
});

const MemoryDecaySchema = z.object({
  enabled: z.boolean().default(true),
  halfLifeDays: z.number().positive().default(30),
});

const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  embed: EmbedConfigSchema.default({}),
  decay: MemoryDecaySchema.default({}),
  maxEntries: z.number().int().positive().default(10000),
});

// ─── Federation ───────────────────────────────────────────────────────────────

const FederationEconomySchema = z.object({
  mode: z.enum(['isolated', 'invite-only', 'open-network']).default('invite-only'),
  /** Token earning limits (contributing compute to peers). */
  earn: z.object({
    maxDaily: z.number().positive().default(100),
    maxPerTask: z.number().positive().default(20),
  }).default({}),
  /** Token spending limits (using peer compute). */
  spend: z.object({
    maxDaily: z.number().positive().default(200),
    minBalance: z.number().nonnegative().default(10),
  }).default({}),
  /** Tool access level granted to remote peers. */
  peerToolPolicy: z.enum(['none', 'read-only', 'safe', 'full']).default('read-only'),
  notifications: z.object({
    onContribution: z.boolean().default(true),
    monthlyReport: z.boolean().default(true),
  }).default({}),
});

const FederationPeerSchema = z.object({
  nodeId: z.string(),
  host: z.string(),
  port: z.number().int().default(19789),
  publicKeyHex: z.string(),
});

const FederationDiscoverySchema = z.object({
  mdns: z.boolean().default(true),
  tailscale: z.boolean().default(false),
  static: z.boolean().default(true),
});

const FederationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  peers: z.array(FederationPeerSchema).default([]),
  discovery: FederationDiscoverySchema.default({}),
  economy: FederationEconomySchema.default({}),
});

// ─── Logging ──────────────────────────────────────────────────────────────────

const LogConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  format: z.enum(['json', 'pretty']).default('json'),
});

// ─── Channels ────────────────────────────────────────────────────────────────

const ChannelKindSchema = z.enum(['logs', 'cli', 'web', 'telegram', 'discord', 'feishu', 'qq']);

const ChannelsConfigSchema = z.object({
  defaults: z.object({
    /** Global default output channel for system events. */
    output: ChannelKindSchema.default('logs'),
    /** Scheduler result output channel. Falls back to defaults.output when absent. */
    schedulerOutput: ChannelKindSchema.default('logs'),
  }).default({}),
  cli: z.object({
    enabled: z.boolean().default(true),
  }).default({}),
  web: z.object({
    enabled: z.boolean().default(true),
  }).default({}),
  logs: z.object({
    enabled: z.boolean().default(true),
  }).default({}),
  telegram: z.object({
    enabled: z.boolean().default(false),
    /** Telegram Bot API token from @BotFather */
    botToken: z.string().default(''),
    /** Default agent ID to route messages to when no routing rule matches */
    defaultAgentId: z.string().default('main'),
    /** Allowed Telegram chat IDs (empty = allow all) */
    allowedChatIds: z.array(z.number()).default([]),
    /** Polling interval in ms (default 2000) */
    pollIntervalMs: z.number().int().positive().default(2000),
  }).default({}),
  discord: z.object({
    enabled: z.boolean().default(false),
    /** Discord Bot token */
    botToken: z.string().default(''),
    /** Default agent ID to route messages to */
    defaultAgentId: z.string().default('main'),
    /** Allowed Discord channel IDs (empty = allow all guilds) */
    allowedChannelIds: z.array(z.string()).default([]),
    /** Command prefix for bot trigger (default '!agent') */
    commandPrefix: z.string().default('!agent'),
  }).default({}),
  feishu: z.object({
    enabled: z.boolean().default(false),
    /** Feishu Open Platform App ID */
    appId: z.string().default(''),
    /** Feishu App Secret */
    appSecret: z.string().default(''),
    /** Verification token from Feishu event subscription page (legacy validation) */
    verificationToken: z.string().default(''),
    /** Encrypt key for event payload decryption (optional) */
    encryptKey: z.string().default(''),
    /** Default agent ID to route messages to */
    defaultAgentId: z.string().default('main'),
    /** Allowed Feishu chat IDs (empty = allow all) */
    allowedChatIds: z.array(z.string()).default([]),
    /**
     * Maps Feishu bot display name (or user-defined alias) to agentId.
     * When a user @mentions a bot whose display name matches a key here,
     * the message is routed to the corresponding agentId instead of defaultAgentId.
     * Example: { "工人": "worker-1", "主控": "main" }
     */
    agentMappings: z.record(z.string()).optional().default({}),
  }).default({}),
  qq: z.object({
    enabled: z.boolean().default(false),
    /** QQ Open Platform App ID */
    appId: z.string().default(''),
    /** QQ App client secret */
    clientSecret: z.string().default(''),
    /** Default agent ID to route messages to */
    defaultAgentId: z.string().default('main'),
    /** Restrict to these group openids (empty = allow all) */
    allowedGroupIds: z.array(z.string()).default([]),
  }).default({}),
});

// ─── Root config schema (v2) ──────────────────────────────────────────────────

export const ConfigSchema = z.object({
  version: z.literal(2).default(2),
  gateway: GatewaySchema.default({}),
  /** Named model registry. Agents reference entries by key. Empty by default — use the setup wizard or Config tab to add models. */
  models: ModelRegistrySchema.default({}),
  defaults: DefaultsConfigSchema.default({}),
  context: ContextConfigSchema.default({}),
  agents: z.array(AgentConfigSchema).default([
    {
      id: 'main',
      skills: [],
      mesh: { role: 'coordinator', capabilities: [], accepts: ['task', 'query', 'notification'], visibility: 'public' },
      owners: [],
      tools: { deny: [], approval: ['bash'] },
    },
  ]),
  skills: SkillsConfigSchema.default({}),
  memory: MemoryConfigSchema.default({}),
  search: SearchConfigSchema.default({}),
  federation: FederationConfigSchema.default({}),
  channels: ChannelsConfigSchema.default({}),
  log: LogConfigSchema.default({}),
});

// ─── Exported types ───────────────────────────────────────────────────────────

export type Config = z.infer<typeof ConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AgentPersona = z.infer<typeof AgentPersonaSchema>;
export type GatewayConfig = z.infer<typeof GatewaySchema>;
export type ModelDef = z.infer<typeof ModelDefSchema>;
export type ModelGroup = z.infer<typeof ModelGroupSchema>;
export type ModelRegistry = z.infer<typeof ModelRegistrySchema>;
export type DefaultsConfig = z.infer<typeof DefaultsConfigSchema>;
export type ContextConfig = z.infer<typeof ContextConfigSchema>;
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type FederationConfig = z.infer<typeof FederationConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type ChannelsConfig = z.infer<typeof ChannelsConfigSchema>;
export type LogConfig = z.infer<typeof LogConfigSchema>;
