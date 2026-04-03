import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import JSON5 from 'json5';
import { createLogger } from '../logger.js';
import { type AgentConfig, type Config, ConfigSchema } from './schema.js';

const logger = createLogger('config:migrate');

// ─── v1 → v2 migration ────────────────────────────────────────────────────────

/**
 * Migrate a raw v1 config object to the v2 structure in-place (returns new object).
 * Safe to call on partially-formed or missing-field objects.
 */
export function migrateV1toV2(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const v1 = raw as Record<string, unknown>;

  // Detect v1: either explicit version:1 or has agents.list shape
  const agentsField = v1.agents as Record<string, unknown> | undefined;
  const isV1 =
    v1.version === 1 ||
    (typeof agentsField === 'object' && agentsField !== null && 'list' in agentsField);

  if (!isV1) return raw; // already v2 or unknown — leave alone

  logger.info('Migrating v1 config to v2');

  // ── agents.list → agents (top-level array) ────────────────────────────────
  const v1Agents = (agentsField?.list as unknown[] | undefined) ?? [];
  const v1Defaults = agentsField?.defaults as Record<string, unknown> | undefined;
  const v1DefaultModel = v1Defaults?.model as Record<string, unknown> | undefined;
  const defaultModelPrimary = (v1DefaultModel?.primary as string | undefined) ?? 'claude-opus-4-5';

  // Build models registry from defaults.model if present
  const models: Record<string, unknown> = {};
  if (defaultModelPrimary) {
    models.smart = { provider: 'anthropic', id: defaultModelPrimary, maxTokens: 8192 };
  }
  models.fast = { provider: 'anthropic', id: 'claude-haiku-3-5', maxTokens: 8192 };
  models.local = { provider: 'ollama', id: 'qwen2.5:7b', maxTokens: 4096 };

  const migratedAgents = v1Agents.map((a) => {
    const agent = a as Record<string, unknown>;
    const oldPolicy = agent.toolPolicy as Record<string, unknown> | undefined;
    const oldModel = agent.model as Record<string, unknown> | undefined;

    // Determine model alias: if agent had custom primary, register it
    let modelAlias: string | undefined;
    if (oldModel?.primary && oldModel.primary !== defaultModelPrimary) {
      const alias = `agent-${String(agent.id ?? 'main')}`;
      models[alias] = {
        provider: 'anthropic',
        id: oldModel.primary,
        maxTokens: oldModel.maxTokens ?? 8192,
      };
      modelAlias = alias;
    }

    return {
      id: agent.id ?? 'main',
      name: agent.name,
      workspace: agent.workspace,
      skills: agent.skills ?? [],
      model: modelAlias,
      mesh: agent.mesh,
      owners: agent.owners ?? [],
      // toolPolicy.{denylist,requireApproval} → tools.{deny,approval}
      tools: {
        allow: oldPolicy?.allowlist,
        deny: oldPolicy?.denylist ?? [],
        approval: oldPolicy?.requireApproval ?? ['bash'],
      },
      soulFile: agent.soulFile,
      agentsFile: agent.agentsFile,
    };
  });

  // ── skills: load.extraDirs → dirs, shortDescLength → summaryLength ────────
  const v1Skills = v1.skills as Record<string, unknown> | undefined;
  const migratedSkills: Record<string, unknown> = {
    dirs: (v1Skills?.load as Record<string, unknown> | undefined)?.extraDirs ?? [],
    compact: v1Skills?.compact ?? true,
    summaryLength: v1Skills?.shortDescLength ?? 60,
    // entries is intentionally dropped — no runtime consumer in AgentFlyer
  };

  // ── federation: simplified economy field names ─────────────────────────────
  const v1Fed = v1.federation as Record<string, unknown> | undefined;
  const v1Econ = v1Fed?.economy as Record<string, unknown> | undefined;
  const v1Contrib = v1Econ?.contribution as Record<string, unknown> | undefined;
  const v1Spend = v1Econ?.spending as Record<string, unknown> | undefined;
  const migratedFed = v1Fed
    ? {
        enabled: v1Fed.enabled ?? false,
        peers: v1Fed.peers ?? [],
        discovery: v1Fed.discovery,
        economy: v1Econ
          ? {
              mode: v1Econ.mode ?? 'invite-only',
              earn: {
                maxDaily: v1Contrib?.maxDailyFC ?? 100,
                maxPerTask: v1Contrib?.maxPerTaskFC ?? 20,
              },
              spend: {
                maxDaily: v1Spend?.maxDailyFC ?? 200,
                minBalance: v1Spend?.requireBalanceAbove ?? 10,
              },
              peerToolPolicy: v1Econ.remotePeerToolPolicy ?? 'read-only',
              notifications: {
                onContribution: v1Econ.notifyOnContribution ?? true,
                monthlyReport: v1Econ.monthlyReport ?? true,
              },
            }
          : undefined,
      }
    : undefined;

  return {
    version: 2,
    gateway: v1.gateway,
    models,
    defaults: {
      model: defaultModelPrimary === 'claude-opus-4-5' ? 'smart' : 'fast',
      maxTokens: (v1DefaultModel?.maxTokens as number | undefined) ?? 8192,
      workspace: v1Defaults?.workspace,
    },
    context: v1.context,
    agents: migratedAgents,
    skills: migratedSkills,
    memory: v1.memory,
    federation: migratedFed,
    log: v1.log,
  };
}

// ─── OpenClaw config shape (minimal — only what we need to migrate) ──────────

interface OpenClawAgentConfig {
  id?: string;
  model?: { primary?: string; fallback?: string };
  skills?: string[];
  workspace?: string;
  owners?: string[];
  toolPolicy?: { denylist?: string[]; requireApproval?: string[] };
}

interface OpenClawConfig {
  gateway?: {
    bind?: string;
    port?: number;
    auth?: { mode?: string; token?: string };
  };
  agents?: {
    defaults?: { model?: { primary?: string; fallback?: string } };
    list?: OpenClawAgentConfig[];
  };
  skills?: {
    entries?: Record<string, unknown>;
    load?: { extraDirs?: string[] };
  };
  memory?: { enabled?: boolean };
}

/**
 * Attempt to migrate an openclaw.json file to AgentFlyer v2 config format.
 *
 * @param openclawPath - Full path to the openclaw.json file
 * @returns Migrated and validated AgentFlyer Config
 */
export function migrateFromOpenclaw(openclawPath: string): Config {
  if (!existsSync(openclawPath)) {
    throw new Error(`openclaw.json not found at: ${openclawPath}`);
  }

  let raw: string;
  try {
    raw = readFileSync(openclawPath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read openclaw.json: ${String(err)}`);
  }

  let oc: OpenClawConfig;
  try {
    oc = JSON5.parse(raw) as OpenClawConfig;
  } catch (err) {
    throw new Error(`Failed to parse openclaw.json: ${String(err)}`);
  }

  const defaultModelPrimary = oc.agents?.defaults?.model?.primary ?? 'claude-opus-4-5';

  // Build models registry
  const models: Record<string, { provider: string; id: string; maxTokens: number }> = {
    fast: { provider: 'anthropic', id: 'claude-haiku-3-5', maxTokens: 8192 },
    smart: { provider: 'anthropic', id: defaultModelPrimary, maxTokens: 8192 },
    local: { provider: 'ollama', id: 'qwen2.5:7b', maxTokens: 4096 },
  };

  const agentList: AgentConfig[] = (oc.agents?.list ?? []).map((a) => ({
    id: a.id ?? 'main',
    name: a.id,
    mentionAliases: [],
    workspace: a.workspace,
    skills: a.skills ?? [],
    model:
      a.model?.primary && a.model.primary !== defaultModelPrimary ? a.model.primary : undefined,
    mesh: {
      role: 'coordinator',
      capabilities: [],
      accepts: ['task', 'query', 'notification'],
      visibility: 'public',
      triggers: [],
    },
    owners: a.owners ?? [],
    tools: {
      deny: a.toolPolicy?.denylist ?? [],
      approval: a.toolPolicy?.requireApproval ?? ['bash'],
      maxRounds: 60,
    },
    persona: { language: 'zh-CN', outputDir: 'output' },
  }));

  if (agentList.length === 0) {
    agentList.push({
      id: 'main',
      mentionAliases: [],
      skills: [],
      mesh: {
        role: 'coordinator',
        capabilities: [],
        accepts: ['task', 'query', 'notification'],
        visibility: 'public',
        triggers: [],
      },
      owners: [],
      tools: { deny: [], approval: ['bash'], maxRounds: 60 },
      persona: { language: 'zh-CN', outputDir: 'output' },
    });
  }

  const raw2 = {
    version: 2,
    gateway: {
      bind: oc.gateway?.bind ?? 'loopback',
      port: oc.gateway?.port ?? 19789,
      auth: { mode: 'token', token: oc.gateway?.auth?.token },
    },
    models,
    defaults: {
      model: 'smart',
      maxTokens: 8192,
    },
    agents: agentList,
    skills: {
      dirs: oc.skills?.load?.extraDirs ?? [],
    },
    memory: { enabled: oc.memory?.enabled ?? true },
    federation: { enabled: false },
  };

  const result = ConfigSchema.safeParse(raw2);
  if (!result.success) {
    const errors = result.error.errors.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Migration produced invalid config:\n${errors}`);
  }

  logger.info('Migration from openclaw.json complete', { source: openclawPath });
  return result.data;
}

/** Find openclaw.json in common locations. */
export function detectOpenclawConfig(): string | null {
  const candidates = [join(homedir(), '.openclaw', 'openclaw.json')];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}
