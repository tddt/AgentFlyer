import { describe, expect, it } from 'vitest';
import type { Config } from '../core/config/schema.js';
import { hasRunnerAffectingConfigChanges } from './lifecycle.js';

function createConfig(overrides: Partial<Config> = {}): Config {
  return {
    gateway: {
      auth: { mode: 'token', token: 'test-token' },
      bind: 'loopback',
      port: 0,
      workflow: {
        agentStepTimeoutMs: 300_000,
      },
    },
    defaults: {
      model: 'group/chat',
      workspace: 'workspace',
    },
    models: {
      group: {
        provider: 'openai-compat',
        apiBaseUrl: 'https://example.com/v1',
        models: {
          chat: {
            id: 'model-a',
            maxTokens: 8192,
          },
        },
      },
    },
    agents: [
      {
        id: 'agent-main',
        name: 'Main Agent',
        workspace: 'workspace',
        mesh: {
          role: 'coordinator',
          capabilities: [],
          accepts: ['task', 'query', 'notification'],
          visibility: 'public',
          triggers: [],
        },
        owners: [],
        tools: {
          deny: [],
          approval: ['bash'],
        },
        persona: {
          language: 'zh-CN',
          outputDir: 'output',
        },
      },
    ],
    memory: {
      enabled: false,
      topK: 5,
      compactThreshold: 20,
    },
    search: {
      providers: [],
    },
    sandbox: {
      enabled: true,
      profiles: {},
    },
    skills: {
      compact: true,
      summaryLength: 60,
    },
    context: {
      systemPrompt: {
        maxTokens: 4096,
      },
    },
    channels: [],
    mcp: {
      servers: [],
    },
    federation: {
      enabled: false,
      listen: [],
      peers: [],
    },
    ...overrides,
  } as Config;
}

describe('hasRunnerAffectingConfigChanges', () => {
  it('detects model registry changes even when the agent list is unchanged', () => {
    const prevConfig = createConfig();
    const nextConfig = createConfig({
      models: {
        group: {
          provider: 'openai-compat',
          apiBaseUrl: 'https://example.com/v1',
          models: {
            chat: {
              id: 'model-b',
              maxTokens: 8192,
            },
          },
        },
      },
    });

    expect(hasRunnerAffectingConfigChanges(prevConfig, nextConfig)).toBe(true);
  });

  it('ignores unrelated gateway-only config changes', () => {
    const prevConfig = createConfig();
    const nextConfig = createConfig({
      gateway: {
        auth: { mode: 'token', token: 'different-token' },
        workflow: {
          agentStepTimeoutMs: 300_000,
        },
        port: 3001,
        bind: 'local',
      },
    });

    expect(hasRunnerAffectingConfigChanges(prevConfig, nextConfig)).toBe(false);
  });
});
