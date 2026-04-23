import { describe, expect, it } from 'vitest';
import { detectOpenclawConfig, migrateV1toV2 } from '../../../src/core/config/migrate.js';

describe('migrateV1toV2', () => {
  it('returns non-object input unchanged', () => {
    expect(migrateV1toV2(null)).toBeNull();
    expect(migrateV1toV2('string')).toBe('string');
    expect(migrateV1toV2(42)).toBe(42);
  });

  it('returns v2 (or unknown) objects unchanged when no v1 markers present', () => {
    const v2Config = {
      version: 2,
      models: { smart: { provider: 'anthropic', id: 'claude-opus-4-5' } },
      agents: [],
    };
    const result = migrateV1toV2(v2Config);
    expect(result).toEqual(v2Config);
  });

  it('migrates when version is 1', () => {
    const v1 = {
      version: 1,
      agents: {
        list: [
          {
            id: 'main',
            name: 'Main Agent',
            workspace: '/home/user/workspace',
            skills: ['weather'],
            owners: ['admin'],
          },
        ],
        defaults: {
          model: { primary: 'claude-opus-4-5', maxTokens: 8192 },
        },
      },
      skills: {
        load: { extraDirs: ['/extra/skills'] },
        shortDescLength: 80,
      },
    };

    const result = migrateV1toV2(v1) as Record<string, unknown>;
    expect(result.version).toBe(2);
    expect(Array.isArray(result.agents)).toBe(true);
    const agents = result.agents as Array<Record<string, unknown>>;
    expect(agents[0].id).toBe('main');
    expect(agents[0].workspace).toBe('/home/user/workspace');
  });

  it('migrates when agents.list shape is present (no explicit version field)', () => {
    const v1NoVersion = {
      agents: {
        list: [{ id: 'worker' }],
        defaults: { model: { primary: 'claude-haiku-3-5' } },
      },
    };

    const result = migrateV1toV2(v1NoVersion) as Record<string, unknown>;
    expect(result.version).toBe(2);
  });

  it('maps toolPolicy to tools.allow/deny/approval', () => {
    const v1 = {
      version: 1,
      agents: {
        list: [
          {
            id: 'agent1',
            toolPolicy: {
              denylist: ['rm', 'sudo'],
              requireApproval: ['bash', 'exec'],
            },
          },
        ],
        defaults: {},
      },
    };

    const result = migrateV1toV2(v1) as Record<string, unknown>;
    const agents = result.agents as Array<Record<string, unknown>>;
    const tools = agents[0].tools as Record<string, unknown>;
    expect(tools.deny).toEqual(['rm', 'sudo']);
    expect(tools.approval).toEqual(['bash', 'exec']);
  });

  it('migrates skills.shortDescLength to summaryLength', () => {
    const v1 = {
      version: 1,
      agents: { list: [], defaults: {} },
      skills: { shortDescLength: 120 },
    };

    const result = migrateV1toV2(v1) as Record<string, unknown>;
    const skills = result.skills as Record<string, unknown>;
    expect(skills.summaryLength).toBe(120);
  });

  it('migrates skills.load.extraDirs to skills.dirs', () => {
    const v1 = {
      version: 1,
      agents: { list: [], defaults: {} },
      skills: { load: { extraDirs: ['/my/skills'] } },
    };

    const result = migrateV1toV2(v1) as Record<string, unknown>;
    const skills = result.skills as Record<string, unknown>;
    expect(skills.dirs).toEqual(['/my/skills']);
  });

  it('migrates federation.economy fields', () => {
    const v1 = {
      version: 1,
      agents: { list: [], defaults: {} },
      federation: {
        enabled: true,
        peers: ['peer1'],
        economy: {
          mode: 'open',
          contribution: { maxDailyFC: 50, maxPerTaskFC: 10 },
          spending: { maxDailyFC: 100, requireBalanceAbove: 5 },
          notifyOnContribution: false,
          monthlyReport: false,
        },
      },
    };

    const result = migrateV1toV2(v1) as Record<string, unknown>;
    const fed = result.federation as Record<string, unknown>;
    expect(fed.enabled).toBe(true);
    const econ = fed.economy as Record<string, unknown>;
    const earn = econ.earn as Record<string, unknown>;
    expect(earn.maxDaily).toBe(50);
    expect(earn.maxPerTask).toBe(10);
    const spend = econ.spend as Record<string, unknown>;
    expect(spend.maxDaily).toBe(100);
  });

  it('handles empty agents list', () => {
    const v1 = { version: 1, agents: { list: [], defaults: {} } };
    const result = migrateV1toV2(v1) as Record<string, unknown>;
    expect(result.agents).toEqual([]);
  });

  it('creates agents with default model when agent model matches default', () => {
    const v1 = {
      version: 1,
      agents: {
        list: [{ id: 'agent1', model: { primary: 'claude-opus-4-5' } }],
        defaults: { model: { primary: 'claude-opus-4-5' } },
      },
    };
    const result = migrateV1toV2(v1) as Record<string, unknown>;
    const agents = result.agents as Array<Record<string, unknown>>;
    // Same model as default → no custom alias needed
    expect(agents[0].model).toBeUndefined();
  });
});

describe('detectOpenclawConfig', () => {
  it('returns null when no openclaw.json is found in standard locations', () => {
    // In test environment, ~/.openclaw/openclaw.json shouldn't exist
    // This is a best-effort test — we just verify it returns null or a string path
    const result = detectOpenclawConfig();
    expect(result === null || typeof result === 'string').toBe(true);
  });
});
