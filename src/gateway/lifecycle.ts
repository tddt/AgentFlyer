import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket as WsWebSocket } from 'ws';
import { AnthropicProvider } from '../agent/llm/anthropic.js';
import { FailoverProvider } from '../agent/llm/failover.js';
import { OpenAIProvider, createCompatProvider } from '../agent/llm/openai.js';
import { createProviderRegistry } from '../agent/llm/provider.js';
import { syncSoulMd } from '../agent/prompt/soul.js';
import { AgentRunner } from '../agent/runner.js';
import { createBashTool } from '../agent/tools/builtin/bash.js';
import { createChannelTools } from '../agent/tools/builtin/channel-tools.js';
import { createFsTools } from '../agent/tools/builtin/fs.js';
import { createMemoryTools } from '../agent/tools/builtin/memory.js';
import { createSchedulerTools } from '../agent/tools/builtin/scheduler-tools.js';
import type { SearchProvider } from '../agent/tools/builtin/search-providers/provider.js';
import {
  BingProvider,
  DuckDuckGoProvider,
  SerpApiProvider,
  TavilyProvider,
  createWebSearchTool,
} from '../agent/tools/builtin/web-search.js';
import { createMeshTools } from '../agent/tools/mesh-tools.js';
import { ToolRegistry } from '../agent/tools/registry.js';
import { DiscordChannel } from '../channels/discord/index.js';
import { FeishuChannel } from '../channels/feishu/index.js';
import { QQChannel } from '../channels/qq/index.js';
import { TelegramChannel } from '../channels/telegram/index.js';
import type { Channel } from '../channels/types.js';
import { TypingKeepAlive } from '../channels/typing.js';
import { WebChannel } from '../channels/web/index.js';
import {
  type ConfigWatcher,
  getDefaultConfigPath,
  loadConfig,
  saveConfig,
  watchConfig,
} from '../core/config/loader.js';
import type { Config } from '../core/config/schema.js';
import { ConfigSchema } from '../core/config/schema.js';
import type { AgentConfig } from '../core/config/schema.js';
import { createLogger } from '../core/logger.js';
import { SessionMetaStore } from '../core/session/meta.js';
import { SessionStore } from '../core/session/store.js';
import { asAgentId, asThreadKey } from '../core/types.js';
import { FederationNode } from '../federation/node.js';
import { MemoryOrganizer } from '../memory/organizer.js';
import { MemoryStore } from '../memory/store.js';
import { CronScheduler } from '../scheduler/cron.js';
import { filterSkillsForAgent } from '../skills/filter.js';
import { buildSkillsDirectory } from '../skills/format.js';
import { buildRegistry, scanSkillsDir } from '../skills/registry.js';
import { createSkillTools } from '../skills/skill-tools.js';
import { AgentQueueRegistry } from './agent-queue.js';
import { generateToken } from './auth.js';
import { captureChatTurnDeliverable } from './chat-deliverables.js';
import { ContentStore } from './content-store.js';
import { DeliverableStore } from './deliverables.js';
import { HookRegistry } from './hooks.js';
import { InboxBroadcaster } from './inbox-broadcaster.js';
import { IntentRouter } from './intent-router.js';
import { logBroadcaster } from './log-buffer.js';
import { SenderRateLimiter } from './rate-limiter.js';
import type { RpcContext } from './rpc.js';
import { type GatewayServer, createGatewayServer } from './server.js';

const logger = createLogger('gateway:lifecycle');

const _gw_pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf-8'),
) as { version: string };
export const GATEWAY_VERSION: string = _gw_pkg.version;

export interface GatewayState {
  runners: Map<string, AgentRunner>;
  config: Config;
  startedAt: number;
  authToken: string;
  dataDir: string;
  scheduler: CronScheduler;
  /** Active config file watcher — stopped on shutdown. */
  configWatcher: ConfigWatcher | null;
}

export interface GatewayInstance {
  state: GatewayState;
  hooks: HookRegistry;
  stop(): Promise<void>;
}

let _server: GatewayServer | null = null;
let _pidFile: string | null = null;

function hasUsableApiKey(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.includes('*')) return false;
  return !['changeme', 'placeholder', 'your-api-key'].includes(trimmed.toLowerCase());
}

/** Write PID file so CLI can check if gateway is running. */
async function writePid(dataDir: string, port: number): Promise<void> {
  const pidPath = join(dataDir, 'gateway.pid');
  await mkdir(dataDir, { recursive: true });
  // RATIONALE: store {pid,port} so CLI status/stop always connects to the
  // port the gateway actually bound — not whatever the config says now.
  await writeFile(pidPath, JSON.stringify({ pid: process.pid, port }), 'utf-8');
  _pidFile = pidPath;
}

async function removePid(): Promise<void> {
  if (_pidFile && existsSync(_pidFile)) {
    await unlink(_pidFile).catch(() => undefined);
  }
}

/** Parse pid file content — tolerates both JSON and legacy plain-number format. */
function parsePidFile(raw: string): { pid: number; port?: number } {
  try {
    const obj = JSON.parse(raw) as { pid?: unknown; port?: unknown };
    const pid = Number(obj.pid);
    const port = typeof obj.port === 'number' ? obj.port : undefined;
    return { pid, port };
  } catch {
    return { pid: Number.parseInt(raw.trim(), 10) };
  }
}

/** Check if a gateway is already running (by pid file + process probe). */
export async function isGatewayRunning(dataDir: string): Promise<boolean> {
  const pidPath = join(dataDir, 'gateway.pid');
  if (!existsSync(pidPath)) return false;
  try {
    const { pid } = parsePidFile(await readFile(pidPath, 'utf-8'));
    if (Number.isNaN(pid) || pid <= 0) return false;
    process.kill(pid, 0); // throws if process doesn't exist
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the port the running gateway is actually bound to.
 * Falls back to `fallback` when pid file is missing or doesn't contain a port.
 */
export async function readRunningPort(dataDir: string, fallback: number): Promise<number> {
  const pidPath = join(dataDir, 'gateway.pid');
  try {
    const { port } = parsePidFile(await readFile(pidPath, 'utf-8'));
    if (typeof port === 'number' && port > 0) return port;
  } catch {
    /* no pid file */
  }
  return fallback;
}

// Shared channel map — populated after channels start; tools hold a live reference.
const sharedChannels = new Map<string, Channel>();

type FlatModelEntry = {
  provider: string;
  id: string;
  maxTokens: number;
  temperature?: number;
  apiKey?: string;
  apiBaseUrl?: string;
};

/**
 * Resolve a model key in both the new grouped format ("group/modelKey")
 * and the legacy flat format ("fast").
 * RATIONALE: supports zero-downtime migration — old configs continue to work.
 */
function resolveModelEntry(
  models: Record<string, unknown>,
  fullKey: string,
): FlatModelEntry | undefined {
  const slash = fullKey.indexOf('/');
  if (slash !== -1) {
    const groupName = fullKey.slice(0, slash);
    const modelName = fullKey.slice(slash + 1);
    const group = models[groupName] as
      | {
          provider: string;
          apiKey?: string;
          apiBaseUrl?: string;
          models?: Record<string, { id: string; maxTokens: number; temperature?: number }>;
        }
      | undefined;
    if (!group?.models) return undefined;
    const def = group.models[modelName];
    if (!def) return undefined;
    return { provider: group.provider, apiKey: group.apiKey, apiBaseUrl: group.apiBaseUrl, ...def };
  }
  // Legacy flat-format fallback: key directly maps to { provider, id, maxTokens, ... }
  return models[fullKey] as FlatModelEntry | undefined;
}

function buildRunner(
  agentCfg: AgentConfig,
  state: GatewayState,
  skillsText = '',
  agentSkillRegistry?: import('../skills/registry.js').SkillRegistry,
): AgentRunner {
  const { config, dataDir } = state;
  const sessionsDir = join(dataDir, 'sessions');
  const workspaceDir = agentCfg.workspace ?? config.defaults.workspace ?? process.cwd();

  // Ensure workspace directory structure exists (created on first launch)
  if (agentCfg.workspace) {
    mkdirSync(join(agentCfg.workspace, 'output'), { recursive: true });
    mkdirSync(join(agentCfg.workspace, 'skills'), { recursive: true });
    // Always re-sync SOUL.md so machine-managed sections (Capabilities, Assigned
    // Skills, Mesh, Tool Access, footer) reflect the current config.
    // User-edited sections (Description, Personality & Style, Heartbeat Triggers)
    // are preserved from the existing file when present.
    const soulPath = join(agentCfg.workspace, 'SOUL.md');
    const existingSoul = existsSync(soulPath) ? readFileSync(soulPath, 'utf8') : null;
    const freshSoul = syncSoulMd(agentCfg, existingSoul);
    if (existingSoul !== freshSoul) {
      writeFileSync(soulPath, freshSoul);
      logger.info(existingSoul ? 'Synced SOUL.md' : 'Generated SOUL.md', {
        agentId: agentCfg.id,
        soulPath,
      });
    }
    logger.debug('Workspace ready', { agentId: agentCfg.id, workspaceDir: agentCfg.workspace });
  }

  const sessionStore = new SessionStore(sessionsDir);
  const metaStore = new SessionMetaStore(sessionsDir);
  const memoryStore = new MemoryStore(dataDir);

  // Resolve model: agent.model can be a string key or a failover-config object.
  // Supports both grouped "group/modelKey" and legacy flat "fast" formats.
  const rawModel = agentCfg.model ?? config.defaults.model;
  const modelCfg =
    rawModel && typeof rawModel === 'object' ? rawModel : { primary: rawModel, fallback: [] };
  const modelKey = modelCfg.primary;
  const modelEntry = resolveModelEntry(config.models as Record<string, unknown>, modelKey);
  const primaryModelId = modelEntry?.id ?? modelKey;

  // LLM providers
  const providerReg = createProviderRegistry();
  providerReg.register(new AnthropicProvider());

  // RATIONALE: Register openai-compat/ollama providers BEFORE the generic OpenAIProvider
  // so that exact model-id matches take precedence over the broad prefix check.
  // Supports both grouped format { provider, models: { key: { id } } }
  // and legacy flat format { provider: 'openai-compat', id, apiBaseUrl, apiKey }.
  for (const [groupName, groupVal] of Object.entries(config.models as Record<string, unknown>)) {
    const group = groupVal as {
      provider?: string;
      apiKey?: string;
      apiBaseUrl?: string;
      models?: Record<string, { id: string }>;
    };
    const provider = group.provider;
    if (!provider || (provider !== 'openai-compat' && provider !== 'ollama')) continue;
    const baseURL =
      group.apiBaseUrl ?? (provider === 'ollama' ? 'http://localhost:11434/v1' : undefined);
    if (!baseURL) {
      logger.warn('Skipping compat model registration: missing apiBaseUrl', { groupName });
      continue;
    }
    const envKey = `AGENTFLYER_API_KEY_${groupName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const apiKey = group.apiKey ?? process.env[envKey] ?? process.env.OPENAI_API_KEY ?? 'unused';

    if (group.models && typeof group.models === 'object') {
      // Grouped format: register one compat provider per model in the group
      for (const [modelName, modelDef] of Object.entries(group.models)) {
        providerReg.register(
          createCompatProvider({
            baseURL,
            apiKey,
            providerId: `${provider}:${groupName}/${modelName}`,
            modelPrefixes: [(modelDef as { id: string }).id],
          }),
        );
      }
    } else {
      // Legacy flat format: the entry itself carries the model id
      const legacyId = (groupVal as { id?: string }).id;
      if (legacyId) {
        providerReg.register(
          createCompatProvider({
            baseURL,
            apiKey,
            providerId: `${provider}:${groupName}`,
            modelPrefixes: [legacyId],
          }),
        );
      }
    }
  }

  // Generic OpenAIProvider as fallback for gpt-*/o1/o3/o4 models
  providerReg.register(new OpenAIProvider());

  // Build the active provider, wrapping with FailoverProvider when fallback models are configured.
  const primaryProvider = providerReg.forModel(primaryModelId);
  const provider =
    modelCfg.fallback.length > 0
      ? new FailoverProvider({
          primary: primaryProvider,
          // RATIONALE: Use first fallback model on the same registry (covers same-provider
          // cheaper/larger model scenarios). Multi-hop fallback (>1 entry) is Phase 2.
          fallbackModel: (() => {
            const fbKey = modelCfg.fallback[0] as string;
            const fbEntry = resolveModelEntry(config.models as Record<string, unknown>, fbKey);
            return fbEntry?.id ?? fbKey;
          })(),
          maxRetries: 1,
        })
      : primaryProvider;

  // Tool registry
  const tools = new ToolRegistry();
  // Pass skill dirs so the agent can read files inside skill directories
  const skillAllowedDirs = agentSkillRegistry
    ? agentSkillRegistry.list().map((s) => dirname(s.filePath))
    : [];
  tools.registerMany(createFsTools(workspaceDir, skillAllowedDirs));
  tools.register(
    createBashTool({
      cwd: workspaceDir,
      workspaceDir,
      outputDir: agentCfg.persona?.outputDir ?? 'output',
      mirrorDirs: skillAllowedDirs,
    }),
  );
  tools.registerMany(createMemoryTools(memoryStore, config.memory));
  // Skill tools — let the agent read full SKILL.md content on demand
  if (agentSkillRegistry) {
    tools.registerMany(createSkillTools(agentSkillRegistry));
  }
  // RATIONALE: Both runners and agentConfigs are passed by reference/value respectively.
  // The runners Map is fully populated before any tool is invoked at runtime.
  tools.registerMany(createMeshTools(state.runners, state.config.agents));
  // Scheduler tools share the same CronScheduler singleton across all agents.
  tools.registerMany(createSchedulerTools(state.runners, state.scheduler, state.dataDir));
  // Channel tools — let the agent send text/files to any registered channel.
  tools.registerMany(
    createChannelTools({
      channels: sharedChannels,
      agentId: agentCfg.id as import('../core/types.js').AgentId,
      workspaceDir,
    }),
  );

  // Web search — build provider list from config
  const searchProviders: SearchProvider[] = [];
  for (const cfg of config.search.providers) {
    switch (cfg.provider) {
      case 'tavily':
        if (!hasUsableApiKey(cfg.apiKey)) {
          logger.warn('Skipping Tavily search provider: missing usable apiKey');
          break;
        }
        searchProviders.push(
          new TavilyProvider({
            apiKey: cfg.apiKey,
            maxResults: cfg.maxResults,
            searchDepth: cfg.searchDepth,
          }),
        );
        break;
      case 'bing':
        if (!hasUsableApiKey(cfg.apiKey)) {
          logger.warn('Skipping Bing search provider: missing usable apiKey');
          break;
        }
        searchProviders.push(
          new BingProvider({ apiKey: cfg.apiKey, maxResults: cfg.maxResults, market: cfg.market }),
        );
        break;
      case 'serpapi':
        if (!hasUsableApiKey(cfg.apiKey)) {
          logger.warn('Skipping SerpApi search provider: missing usable apiKey');
          break;
        }
        searchProviders.push(
          new SerpApiProvider({
            apiKey: cfg.apiKey,
            maxResults: cfg.maxResults,
            engine: cfg.engine,
            hl: cfg.hl,
            gl: cfg.gl,
          }),
        );
        break;
      case 'duckduckgo':
        searchProviders.push(
          new DuckDuckGoProvider({ maxResults: cfg.maxResults, region: cfg.region }),
        );
        break;
    }
  }
  if (searchProviders.length > 0) {
    tools.register(createWebSearchTool({ providers: searchProviders }));
    logger.info('Web search tool registered', { providers: searchProviders.map((p) => p.name) });
  }

  return new AgentRunner(agentCfg, {
    provider,
    toolRegistry: tools,
    sessionStore,
    metaStore,
    skillsText,
    systemPromptMaxTokens: config.context?.systemPrompt?.maxTokens,
    dataDir,
    memoryOrganizer: new MemoryOrganizer(memoryStore, provider, asAgentId(agentCfg.id)),
    memoryStore,
    resolvedModel: {
      id: primaryModelId,
      maxTokens: modelEntry?.maxTokens ?? 8192,
      temperature: modelEntry?.temperature,
    },
  });
}

/**
 * Bootstrap and start the gateway.
 * Resolves when the server is accepting connections.
 */
export async function startGateway(
  config: Config,
  dataDir: string,
  configPath?: string,
): Promise<GatewayInstance> {
  logger.info('Starting AgentFlyer gateway', { version: GATEWAY_VERSION });

  // Install log interception as early as possible so all subsequent output
  // is captured for the web console SSE stream.
  logBroadcaster.install();

  const hooks = new HookRegistry();
  await hooks.emit('before:start', {});

  const authToken = config.gateway.auth.token ?? process.env.AGENTFLYER_TOKEN ?? generateToken();

  const runners = new Map<string, AgentRunner>();
  const scheduler = new CronScheduler();
  const state: GatewayState = {
    runners,
    config,
    startedAt: Date.now(),
    authToken,
    dataDir,
    scheduler,
    configWatcher: null,
  };

  // Build global skill registry once; each agent gets its own filtered slice
  // RATIONALE: let so it can be updated when config is reloaded with new skill dirs
  let globalSkillRegistry = buildRegistry(config, config.defaults.workspace ?? process.cwd());
  logger.info('Global skill registry ready', { total: globalSkillRegistry.size() });

  // Build a runner for each agent
  for (const agentCfg of config.agents) {
    try {
      // 1. Skills explicitly selected from the global pool
      const explicitSkills = filterSkillsForAgent(
        globalSkillRegistry.list(),
        agentCfg.skills ?? [],
      );

      // 2. Auto-merge per-agent workspace skills (<workspace>/skills/)
      // RATIONALE: agents can drop SKILL.md files in their own workspace without
      // touching the global config — they are always included automatically.
      const workspaceSkills = [];
      if (agentCfg.workspace) {
        const explicitIds = new Set(explicitSkills.map((s) => s.id));
        for (const s of scanSkillsDir(
          join(agentCfg.workspace, 'skills'),
          config.skills.summaryLength ?? 60,
        )) {
          if (!explicitIds.has(s.id)) workspaceSkills.push({ ...s, source: 'workspace' as const });
        }
      }

      const agentSkills = [...explicitSkills, ...workspaceSkills];
      const agentSkillsText = buildSkillsDirectory(agentSkills, config.skills.compact ?? true);
      if (agentSkills.length > 0) {
        logger.info('Skills loaded for agent', {
          agentId: agentCfg.id,
          skills: agentSkills.map((s) => s.id),
        });
      }
      // Build a per-agent registry so skill_read / skill_list are scoped to this agent's skills
      const agentSkillRegistry = new (await import('../skills/registry.js')).SkillRegistry();
      for (const s of agentSkills) agentSkillRegistry.register(s);
      runners.set(agentCfg.id, buildRunner(agentCfg, state, agentSkillsText, agentSkillRegistry));
      const rawModelForLog = agentCfg.model ?? config.defaults.model;
      const modelKeyForLog =
        rawModelForLog && typeof rawModelForLog === 'object'
          ? rawModelForLog.primary
          : rawModelForLog;
      logger.info('Agent registered', { agentId: agentCfg.id, model: modelKeyForLog });
      await hooks.emit('agent:registered', { agentId: agentCfg.id, runners });
    } catch (err) {
      logger.error('Failed to build runner for agent', {
        agentId: agentCfg.id,
        error: String(err),
      });
      await hooks.emit('agent:error', {
        agentId: agentCfg.id,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  // ── Manual reload helper (also used by hot-reload watcher) ────────────
  /**
   * Reload agent(s) by re-reading the config file from disk and rebuilding
   * their runners in-place.  Specify agentId to reload a single agent;
   * omit (or pass undefined) to reload all agents and sync additions/removals.
   */
  async function reloadAgents(agentId?: string): Promise<{ reloaded: string[] }> {
    const newConfig = loadConfig(configFilePath);
    await hooks.emit('before:reload', { runners });

    let toReload: AgentConfig[];

    if (agentId) {
      // Single-agent reload: find in new config, keep everything else intact
      const agentCfg = newConfig.agents.find((a) => a.id === agentId);
      if (!agentCfg) throw new Error(`Agent "${agentId}" not found in config`);
      toReload = [agentCfg];
    } else {
      // Full reload: diff old/new sets, remove deleted agents
      const oldIds = new Set(runners.keys());
      const newIds = new Set(newConfig.agents.map((a) => a.id));
      for (const id of oldIds) {
        if (!newIds.has(id)) {
          runners.delete(id);
          logger.info('Agent removed on reload', { agentId: id });
        }
      }
      toReload = newConfig.agents;
    }

    state.config = newConfig;
    // Rebuild the global registry once with new config (picks up new extraSkillDirs)
    globalSkillRegistry = buildRegistry(newConfig, newConfig.defaults.workspace ?? process.cwd());
    logger.info('Global skill registry rebuilt on reload', { total: globalSkillRegistry.size() });
    const reloaded: string[] = [];
    for (const agentCfg of toReload) {
      try {
        // 1. Skills explicitly selected from the global pool
        const explicitSkills = filterSkillsForAgent(
          globalSkillRegistry.list(),
          agentCfg.skills ?? [],
        );

        // 2. Auto-merge per-agent workspace skills (<workspace>/skills/)
        const workspaceSkills = [];
        if (agentCfg.workspace) {
          const explicitIds = new Set(explicitSkills.map((s) => s.id));
          for (const s of scanSkillsDir(
            join(agentCfg.workspace, 'skills'),
            newConfig.skills.summaryLength ?? 60,
          )) {
            if (!explicitIds.has(s.id))
              workspaceSkills.push({ ...s, source: 'workspace' as const });
          }
        }

        const agentSkills = [...explicitSkills, ...workspaceSkills];
        const agentSkillsText = buildSkillsDirectory(agentSkills, newConfig.skills.compact ?? true);
        const agentSkillRegistry = new (await import('../skills/registry.js')).SkillRegistry();
        for (const s of agentSkills) agentSkillRegistry.register(s);
        runners.set(agentCfg.id, buildRunner(agentCfg, state, agentSkillsText, agentSkillRegistry));
        reloaded.push(agentCfg.id);
        logger.info('Agent reloaded', { agentId: agentCfg.id, skills: agentSkills.length });
      } catch (err) {
        logger.error('Failed to reload runner', { agentId: agentCfg.id, error: String(err) });
      }
    }

    await hooks.emit('after:reload', { runners });
    logger.info('Reload complete', { reloaded });
    return { reloaded };
  }

  const configFilePath = configPath ?? getDefaultConfigPath();

  async function saveAndReload(raw: unknown): Promise<{ reloaded: string[] }> {
    const merged = raw;
    const parsed = ConfigSchema.safeParse(merged);
    if (!parsed.success) {
      throw new Error(`Invalid config: ${parsed.error.message}`);
    }
    await saveConfig(parsed.data, configFilePath);
    // Update live state and rebuild runners
    return reloadAgents();
  }

  const inboxBroadcaster = new InboxBroadcaster();

  const rpcContext: RpcContext = {
    runners,
    gatewayVersion: GATEWAY_VERSION,
    startedAt: state.startedAt,
    dataDir,
    getConfig: () => state.config,
    saveAndReload,
    scheduler,
    shutdown: cleanup,
    reload: reloadAgents,
    listSkills: () => globalSkillRegistry.list(),
    sessionStore: new SessionStore(join(dataDir, 'sessions')),
    metaStore: new SessionMetaStore(join(dataDir, 'sessions')),
    contentStore: new ContentStore(() => state.config),
    deliverableStore: new DeliverableStore(dataDir),
    inboxBroadcaster,
    channels: sharedChannels,
    runningTasks: new Map(),
  };

  // ── Inbound channel handler ──────────────────────────────────────────────
  // Routes a ChannelMessage to the appropriate AgentRunner and streams/sends
  // the reply back via the originating channel.
  const activeChannels: { stop(): Promise<void> }[] = [];
  type WebhookHandler = (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => Promise<void>;
  const webhookHandlers = new Map<string, WebhookHandler>();

  // WebChannel is always instantiated — WS binds happen on demand.
  const webChannel = new WebChannel();

  // RATIONALE: A single queue registry ensures concurrent messages for the same
  // agent are processed in FIFO order — prevents setThread()+turn() race conditions.
  const agentQueues = new AgentQueueRegistry();

  // RATIONALE: one rate limiter shared across all channels so a sender cannot
  // circumvent limits by alternating between Telegram and Discord (same identity
  // key is used — username / userId / senderId per channel).
  const rateLimiter = new SenderRateLimiter({
    maxRequests: 20,
    windowMs: 60_000,
  });
  rateLimiter.startCleanup();

  async function sendCapturedStream(options: {
    stream: AsyncIterable<import('../core/types.js').StreamChunk>;
    send: (stream: AsyncIterable<import('../core/types.js').StreamChunk>) => Promise<void>;
    agentId: string;
    threadKey: string;
    channelId: string;
  }): Promise<void> {
    let replyText = '';
    const startedAt = Date.now();
    async function* capture(): AsyncIterable<import('../core/types.js').StreamChunk> {
      for await (const chunk of options.stream) {
        if (chunk.type === 'text_delta' && chunk.text) {
          replyText += chunk.text;
        }
        yield chunk;
      }
    }
    await options.send(capture());
    if (replyText.trim()) {
      inboxBroadcaster.publish({
        kind: 'agent_reply',
        agentId: options.agentId,
        threadKey: options.threadKey,
        channelId: options.channelId,
        title: `${options.agentId} replied`,
        text: replyText.trim(),
      });
    }
    await captureChatTurnDeliverable(rpcContext, {
      agentId: options.agentId,
      threadKey: options.threadKey,
      channelId: options.channelId,
      replyText,
      startedAt,
    });
  }

  async function startExternalChannels(): Promise<void> {
    const channelsCfg = config.channels;
    // Default agent: first configured agent, or 'main' as fallback
    const firstAgentId = asAgentId(config.agents[0]?.id ?? 'main');

    // ── Telegram ────────────────────────────────────────────────────────────
    const tgCfg = channelsCfg.telegram;
    if (tgCfg.enabled && tgCfg.botToken) {
      try {
        const tg = new TelegramChannel({
          botToken: tgCfg.botToken,
          defaultAgentId: asAgentId(tgCfg.defaultAgentId || firstAgentId),
          allowedChatIds: tgCfg.allowedChatIds,
          pollIntervalMs: tgCfg.pollIntervalMs,
        });
        await tg.start(async (msg) => {
          // Sender allowlist — reject messages from users not in allowFrom
          if (tgCfg.allowFrom.length > 0) {
            const ident = String(msg.meta?.username ?? msg.meta?.chatId ?? '');
            if (!ident || !tgCfg.allowFrom.includes(ident)) {
              logger.debug('Telegram: sender not in allowFrom, ignoring', { ident });
              return;
            }
          }
          // Rate limit — drop if sender exceeds burst threshold
          const rlKey = `tg:${String(msg.meta?.chatId ?? msg.meta?.username ?? 'unknown')}`;
          if (!rateLimiter.check(rlKey)) {
            logger.warn('Telegram: rate limit exceeded, dropping message', { rlKey });
            return;
          }
          const runner = runners.get(msg.agentId);
          if (!runner) {
            logger.warn('Telegram: no runner for agent', { agentId: msg.agentId });
            await tg.sendToChat(msg.meta?.chatId as number, `⚠️ Agent "${msg.agentId}" not found.`);
            return;
          }
          // RATIONALE: queue ensures sequential processing per agent (no concurrent turns)
          await agentQueues.for(msg.agentId).enqueue(async () => {
            const typing = new TypingKeepAlive();
            typing.start(() => tg.sendTyping(msg.threadKey));
            try {
              runner.setThread(msg.threadKey);
              const memoryText = await runner.searchMemory(msg.text);
              const stream = runner.turn(msg.text, { memoryText: memoryText || undefined });
              await sendCapturedStream({
                stream,
                send: (captured) =>
                  tg.sendStream({ agentId: msg.agentId, threadKey: msg.threadKey }, captured),
                agentId: msg.agentId,
                threadKey: msg.threadKey,
                channelId: msg.channelId,
              });
            } catch (err: unknown) {
              logger.error('Telegram agent run error', { error: String(err) });
              await tg.sendToChat(msg.meta?.chatId as number, `❌ Error: ${String(err)}`);
            } finally {
              typing.stop();
            }
          });
        });
        activeChannels.push(tg);
        sharedChannels.set('telegram', tg as unknown as Channel);
        logger.info('Telegram channel active', { agentId: tgCfg.defaultAgentId });
      } catch (err: unknown) {
        logger.error('Failed to start Telegram channel — gateway continues without it', {
          error: String(err),
        });
      }
    }

    // ── Discord ─────────────────────────────────────────────────────────────
    const dcCfg = channelsCfg.discord;
    if (dcCfg.enabled && dcCfg.botToken) {
      try {
        const dc = new DiscordChannel({
          botToken: dcCfg.botToken,
          defaultAgentId: asAgentId(dcCfg.defaultAgentId || firstAgentId),
          allowedChannelIds: dcCfg.allowedChannelIds,
          commandPrefix: dcCfg.commandPrefix,
        });
        await dc.start(async (msg) => {
          // Sender allowlist — reject messages from users not in allowFrom
          if (dcCfg.allowFrom.length > 0) {
            const ident = String(msg.meta?.authorId ?? msg.meta?.username ?? '');
            if (!ident || !dcCfg.allowFrom.includes(ident)) {
              logger.debug('Discord: sender not in allowFrom, ignoring', { ident });
              return;
            }
          }
          const rlKeyDc = `dc:${String(msg.meta?.authorId ?? msg.meta?.username ?? 'unknown')}`;
          if (!rateLimiter.check(rlKeyDc)) {
            logger.warn('Discord: rate limit exceeded, dropping message', { rlKey: rlKeyDc });
            return;
          }
          const runner = runners.get(msg.agentId);
          if (!runner) {
            logger.warn('Discord: no runner for agent', { agentId: msg.agentId });
            await dc.sendToChannel(
              msg.meta?.discordChannelId as string,
              `⚠️ Agent "${msg.agentId}" not found.`,
            );
            return;
          }
          await agentQueues.for(msg.agentId).enqueue(async () => {
            const typing = new TypingKeepAlive();
            typing.start(() => dc.sendTyping(msg.threadKey));
            try {
              runner.setThread(msg.threadKey);
              const memoryText = await runner.searchMemory(msg.text);
              const stream = runner.turn(msg.text, { memoryText: memoryText || undefined });
              await sendCapturedStream({
                stream,
                send: (captured) =>
                  dc.sendStream({ agentId: msg.agentId, threadKey: msg.threadKey }, captured),
                agentId: msg.agentId,
                threadKey: msg.threadKey,
                channelId: msg.channelId,
              });
            } catch (err: unknown) {
              logger.error('Discord agent run error', { error: String(err) });
              await dc.sendToChannel(
                msg.meta?.discordChannelId as string,
                `❌ Error: ${String(err)}`,
              );
            } finally {
              typing.stop();
            }
          });
        });
        activeChannels.push(dc);
        sharedChannels.set('discord', dc as unknown as Channel);
        logger.info('Discord channel active', { agentId: dcCfg.defaultAgentId });
      } catch (err: unknown) {
        logger.error('Failed to start Discord channel — gateway continues without it', {
          error: String(err),
        });
      }
    }

    // ── Feishu ──────────────────────────────────────────────────────────────
    const feishuCfg = channelsCfg.feishu;
    if (feishuCfg.enabled && feishuCfg.appId) {
      try {
        const feishu = new FeishuChannel({
          appId: feishuCfg.appId,
          appSecret: feishuCfg.appSecret,
          verificationToken: feishuCfg.verificationToken,
          encryptKey: feishuCfg.encryptKey,
          defaultAgentId: asAgentId(feishuCfg.defaultAgentId || firstAgentId),
          allowedChatIds: feishuCfg.allowedChatIds,
          agentMappings: feishuCfg.agentMappings,
          knownAgentIds: [...runners.keys()],
        });
        await feishu.start(async (msg) => {
          // Sender allowlist — reject messages from users not in allowFrom
          if (feishuCfg.allowFrom.length > 0) {
            const ident = String(msg.meta?.senderId ?? '');
            if (!ident || !feishuCfg.allowFrom.includes(ident)) {
              logger.debug('Feishu: sender not in allowFrom, ignoring', { ident });
              return;
            }
          }
          const rlKeyFei = `feishu:${String(msg.meta?.senderId ?? 'unknown')}`;
          if (!rateLimiter.check(rlKeyFei)) {
            logger.warn('Feishu: rate limit exceeded, dropping message', { rlKey: rlKeyFei });
            return;
          }
          const runner = runners.get(msg.agentId);
          if (!runner) {
            logger.warn('Feishu: no runner for agent', { agentId: msg.agentId });
            await feishu.sendToChat(msg.threadKey, `⚠️ Agent "${msg.agentId}" not found.`);
            return;
          }
          await agentQueues.for(msg.agentId).enqueue(async () => {
            try {
              runner.setThread(msg.threadKey);
              const memoryText = await runner.searchMemory(msg.text);
              const stream = runner.turn(msg.text, { memoryText: memoryText || undefined });
              await sendCapturedStream({
                stream,
                send: (captured) =>
                  feishu.sendStream({ agentId: msg.agentId, threadKey: msg.threadKey }, captured),
                agentId: msg.agentId,
                threadKey: msg.threadKey,
                channelId: msg.channelId,
              });
            } catch (err: unknown) {
              logger.error('Feishu agent run error', { error: String(err) });
              await feishu.sendToChat(msg.threadKey, `❌ Error: ${String(err)}`);
            }
          });
        });
        // WebSocket mode: no webhook handler needed — events arrive via WSClient
        activeChannels.push(feishu);
        sharedChannels.set('feishu', feishu as unknown as Channel);
        logger.info('Feishu channel active (WebSocket mode)', {
          agentId: feishuCfg.defaultAgentId,
        });
      } catch (err: unknown) {
        logger.error('Failed to start Feishu channel — gateway continues without it', {
          error: String(err),
        });
      }
    }

    // ── QQ ──────────────────────────────────────────────────────────────────
    const qqCfg = channelsCfg.qq;
    if (qqCfg.enabled && qqCfg.appId) {
      try {
        const qq = new QQChannel({
          appId: qqCfg.appId,
          clientSecret: qqCfg.clientSecret,
          defaultAgentId: asAgentId(qqCfg.defaultAgentId || firstAgentId),
          allowedGroupIds: qqCfg.allowedGroupIds,
        });
        await qq.start(async (msg) => {
          // Sender allowlist — reject messages from users not in allowFrom
          if (qqCfg.allowFrom.length > 0) {
            const ident = String(msg.meta?.openid ?? '');
            if (!ident || !qqCfg.allowFrom.includes(ident)) {
              logger.debug('QQ: sender not in allowFrom, ignoring', { ident });
              return;
            }
          }
          const rlKeyQq = `qq:${String(msg.meta?.openid ?? 'unknown')}`;
          if (!rateLimiter.check(rlKeyQq)) {
            logger.warn('QQ: rate limit exceeded, dropping message', { rlKey: rlKeyQq });
            return;
          }
          const runner = runners.get(msg.agentId);
          if (!runner) {
            logger.warn('QQ: no runner for agent', { agentId: msg.agentId });
            await qq.sendToThread(msg.threadKey, `⚠️ Agent "${msg.agentId}" not found.`);
            return;
          }
          await agentQueues.for(msg.agentId).enqueue(async () => {
            try {
              runner.setThread(msg.threadKey);
              const memoryText = await runner.searchMemory(msg.text);
              const stream = runner.turn(msg.text, { memoryText: memoryText || undefined });
              await sendCapturedStream({
                stream,
                send: (captured) =>
                  qq.sendStream({ agentId: msg.agentId, threadKey: msg.threadKey }, captured),
                agentId: msg.agentId,
                threadKey: msg.threadKey,
                channelId: msg.channelId,
              });
            } catch (err: unknown) {
              logger.error('QQ agent run error', { error: String(err) });
              await qq.sendToThread(msg.threadKey, `❌ Error: ${String(err)}`);
            }
          });
        });
        webhookHandlers.set('/channels/qq/event', qq.getWebhookHandler());
        activeChannels.push(qq);
        sharedChannels.set('qq', qq as unknown as Channel);
        logger.info('QQ channel active', { agentId: qqCfg.defaultAgentId });
      } catch (err: unknown) {
        logger.error('Failed to start QQ channel — gateway continues without it', {
          error: String(err),
        });
      }
    }

    // ── WebChannel (WS) ─────────────────────────────────────────────────────
    // RATIONALE: WebChannel is always started — it only costs a handler registration.
    // Actual WS connections arrive via the gateway's /ws/chat upgrade path.
    await webChannel.start(async (msg) => {
      const rlKeyWs = `ws:${String(msg.meta?.connectionKey ?? 'unknown')}`;
      if (!rateLimiter.check(rlKeyWs)) {
        logger.warn('WebChannel: rate limit exceeded, dropping message', { rlKey: rlKeyWs });
        return;
      }
      const runner = runners.get(msg.agentId);
      if (!runner) {
        logger.warn('WebChannel: no runner for agent', { agentId: msg.agentId });
        return;
      }
      await agentQueues.for(msg.agentId).enqueue(async () => {
        try {
          runner.setThread(msg.threadKey);
          const memoryText = await runner.searchMemory(msg.text);
          const stream = runner.turn(msg.text, { memoryText: memoryText || undefined });
          await sendCapturedStream({
            stream,
            send: (captured) =>
              webChannel.sendStream({ agentId: msg.agentId, threadKey: msg.threadKey }, captured),
            agentId: msg.agentId,
            threadKey: msg.threadKey,
            channelId: msg.channelId,
          });
        } catch (err: unknown) {
          logger.error('WebChannel agent run error', { error: String(err) });
        }
      });
    });
    activeChannels.push(webChannel);
    sharedChannels.set('web', webChannel as unknown as Channel);
    logger.info('Web channel active (WS endpoint: /ws/chat)');
  }

  await startExternalChannels();

  // ── WS upgrade handler — authenticates and binds each connection to WebChannel ──
  const wsHandler = (ws: WsWebSocket, req: import('node:http').IncomingMessage): void => {
    const qs = (req.url ?? '').split('?')[1] ?? '';
    const params = new URLSearchParams(qs);
    const wsToken = params.get('token') ?? '';
    if (wsToken !== authToken) {
      ws.close(4401, 'Unauthorized');
      return;
    }
    const agentId = asAgentId(params.get('agentId')?.trim() || config.agents[0]?.id || 'main');
    const threadKey = asThreadKey(params.get('threadKey')?.trim() || `ws-${Date.now()}`);
    webChannel.bindWebSocket(ws, agentId, threadKey);
  };

  // ── Step 11: Federation node (optional) ─────────────────────────────────
  let federationNode: FederationNode | null = null;
  if (config.federation?.enabled) {
    try {
      federationNode = new FederationNode({
        config: config.federation,
        gatewayPort: config.gateway.port,
        dataDir,
        gatewayVersion: GATEWAY_VERSION,
      });
      await federationNode.start();
      rpcContext.federationNode = federationNode;
    } catch (err) {
      logger.error('Federation node failed to start — gateway continues without it', {
        error: String(err),
      });
    }
  }

  _server = createGatewayServer({
    port: config.gateway.port,
    bind: config.gateway.bind,
    authToken,
    rpcContext,
    logBroadcaster,
    inboxBroadcaster,
    webhookHandlers: webhookHandlers.size > 0 ? webhookHandlers : undefined,
    intentRouter: config.routing.rules.length > 0 ? new IntentRouter(config.routing) : undefined,
    wsHandler,
  });

  const { port, address } = await _server.start();

  await writePid(dataDir, port);
  const consoleUrl = `http://127.0.0.1:${port}/console?token=${authToken}`;
  logger.info('Gateway ready', {
    address,
    port,
    authToken: `${authToken.slice(0, 8)}...`,
    consoleUrl,
  });
  await hooks.emit('after:start', { runners });

  // ── Hot-reload watcher (uses the same configFilePath declared above) ──
  state.configWatcher = watchConfig(async (_newConfig, err) => {
    if (err) {
      logger.error('Hot-reload skipped due to config error', { error: err.message });
      return;
    }
    // Delegate to the shared reload helper so RPC and watcher use the same path
    logger.info('Config file changed — triggering hot-reload…');
    await reloadAgents();
  }, configFilePath);

  process.on('SIGINT', () => void cleanup());
  process.on('SIGTERM', () => void cleanup());

  async function cleanup(): Promise<void> {
    logger.info('Gateway shutting down...');
    await hooks.emit('before:stop', { runners });
    rateLimiter.stop();
    state.configWatcher?.stop();
    state.scheduler.stopAll();
    await federationNode?.stop().catch(() => undefined);
    // Stop external channels gracefully
    for (const ch of activeChannels) {
      await ch.stop().catch(() => undefined);
    }
    await _server?.stop();
    await removePid();
    await hooks.emit('after:stop', {});
    process.exit(0);
  }

  return {
    state,
    hooks,
    stop: cleanup,
  };
}
