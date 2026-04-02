import { describe, expect, it } from 'vitest';
import type { RoutingConfig } from '../../../src/core/config/schema.js';
import { IntentRouter } from '../../../src/gateway/intent-router.js';

function makeRoutingConfig(): RoutingConfig {
  return {
    enabled: true,
    mode: 'simple',
    defaultAgent: 'main',
    rules: [
      {
        pattern: 'search|搜索',
        agent: 'worker-search',
        fallback: 'main',
      },
    ],
  };
}

describe('IntentRouter', () => {
  it('routes matched messages and preserves fallback ids', () => {
    const router = new IntentRouter(makeRoutingConfig());

    expect(router.route('帮我搜索一下')).toBe('worker-search');
    expect(router.routeWithFallback('帮我搜索一下')).toEqual({
      agent: 'worker-search',
      fallback: 'main',
    });
    expect(router.route('plain message')).toBe('main');
  });

  it('rejects blank default agent ids during construction', () => {
    expect(
      () =>
        new IntentRouter({
          ...makeRoutingConfig(),
          defaultAgent: '   ',
        }),
    ).toThrow('AgentId cannot be empty');
  });
});