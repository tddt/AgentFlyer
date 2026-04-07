import { describe, expect, it } from 'vitest';
import { asSessionKey } from '../types.js';
import { summarizeSessionErrors } from './error-stats.js';
import type { SessionMeta } from './meta.js';

function createSession(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    sessionKey: asSessionKey('agent:main:thread'),
    status: 'idle',
    messageCount: 0,
    lastActivity: 0,
    createdAt: 0,
    agentId: 'agent-main',
    threadKey: 'thread',
    contextTokensEstimate: 0,
    compactionCount: 0,
    ...overrides,
  };
}

describe('summarizeSessionErrors', () => {
  it('counts suspended sessions as problem sessions', () => {
    const now = Date.UTC(2026, 3, 7);
    const sessions: SessionMeta[] = [
      createSession({
        sessionKey: asSessionKey('agent:main:error'),
        status: 'error',
        errorCode: 'rate_limit',
        lastActivity: now,
      }),
      createSession({
        sessionKey: asSessionKey('agent:main:suspended'),
        status: 'suspended',
        errorCode: 'approval_required',
        lastActivity: now - 60_000,
      }),
      createSession({
        sessionKey: asSessionKey('agent:other:suspended'),
        agentId: 'agent-other',
        threadKey: 'other-thread',
        status: 'suspended',
        errorCode: 'billing',
        lastActivity: now - 120_000,
      }),
    ];

    const summary = summarizeSessionErrors(sessions, 7, now);

    expect(summary.totalErrorSessions).toBe(3);
    expect(summary.recentErrorSessions).toBe(3);
    expect(summary.breakdown.map((entry) => entry.code)).toEqual([
      'rate_limit',
      'approval_required',
      'billing',
    ]);
    expect(summary.byAgent[0]?.agentId).toBe('agent-main');
    expect(summary.byAgent[0]?.totalErrorSessions).toBe(2);
    expect(summary.byAgent[0]?.topErrorCode).toBe('approval_required');
  });

  it('normalizes missing problem error codes to generic', () => {
    const now = Date.UTC(2026, 3, 7);
    const sessions: SessionMeta[] = [
      createSession({
        sessionKey: asSessionKey('agent:main:error-generic'),
        status: 'error',
        lastActivity: now,
      }),
      createSession({
        sessionKey: asSessionKey('agent:main:suspended-generic'),
        status: 'suspended',
        lastActivity: now - 60_000,
      }),
      createSession({
        sessionKey: asSessionKey('agent:main:idle'),
        status: 'idle',
        lastActivity: now - 120_000,
      }),
    ];

    const summary = summarizeSessionErrors(sessions, 7, now);

    expect(summary.totalErrorSessions).toBe(2);
    expect(summary.breakdown).toEqual([
      {
        code: 'generic',
        count: 2,
        lastSeenAt: now,
      },
    ]);
    expect(summary.byAgent[0]?.topErrorCode).toBe('generic');
  });
});
