import { describe, expect, it } from 'vitest';
import { asSessionKey } from '../types.js';
import type { SessionMeta } from './meta.js';
import {
  buildClearedSessionUpdates,
  findFailedSessionsForAgent,
  normalizeSessionErrorCode,
} from './recovery.js';

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

describe('findFailedSessionsForAgent', () => {
  it('returns both error and suspended problem sessions', () => {
    const sessions: SessionMeta[] = [
      createSession({
        sessionKey: asSessionKey('agent:main:error'),
        status: 'error',
        errorCode: 'rate_limit',
      }),
      createSession({
        sessionKey: asSessionKey('agent:main:suspended'),
        status: 'suspended',
        errorCode: 'approval_required',
      }),
      createSession({ sessionKey: asSessionKey('agent:main:idle'), status: 'idle' }),
      createSession({
        sessionKey: asSessionKey('agent:other:error'),
        agentId: 'agent-other',
        status: 'error',
      }),
    ];

    expect(
      findFailedSessionsForAgent(sessions, 'agent-main').map((session) => session.sessionKey),
    ).toEqual(['agent:main:error', 'agent:main:suspended']);
    expect(
      findFailedSessionsForAgent(sessions, 'agent-main', 'approval_required').map(
        (session) => session.sessionKey,
      ),
    ).toEqual(['agent:main:suspended']);
  });

  it('treats missing error codes on problem sessions as generic', () => {
    const sessions: SessionMeta[] = [
      createSession({
        sessionKey: asSessionKey('agent:main:error-generic'),
        status: 'error',
      }),
      createSession({
        sessionKey: asSessionKey('agent:main:suspended-generic'),
        status: 'suspended',
      }),
      createSession({
        sessionKey: asSessionKey('agent:main:idle'),
        status: 'idle',
      }),
    ];

    expect(
      findFailedSessionsForAgent(sessions, 'agent-main', 'generic').map(
        (session) => session.sessionKey,
      ),
    ).toEqual(['agent:main:error-generic', 'agent:main:suspended-generic']);
    expect(normalizeSessionErrorCode(sessions[0] ?? createSession({}))).toBe('generic');
    expect(normalizeSessionErrorCode(sessions[1] ?? createSession({}))).toBe('generic');
    expect(normalizeSessionErrorCode(sessions[2] ?? createSession({}))).toBeUndefined();
  });
});

describe('buildClearedSessionUpdates', () => {
  it('resets runtime counters and problem metadata while keeping the session reusable', () => {
    expect(buildClearedSessionUpdates(1234)).toEqual({
      status: 'idle',
      messageCount: 0,
      lastActivity: 1234,
      contextTokensEstimate: 0,
      compactionCount: 0,
      error: undefined,
      errorCode: undefined,
    });
  });
});
