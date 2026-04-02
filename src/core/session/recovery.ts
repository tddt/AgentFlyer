import type { SessionErrorCode, SessionMeta } from './meta.js';

function normalizeSessionErrorCode(session: SessionMeta): SessionErrorCode | undefined {
  if (session.status !== 'error') return undefined;
  return session.errorCode ?? 'generic';
}

export function findFailedSessionsForAgent(
  sessions: SessionMeta[],
  agentId: string,
  errorCode?: SessionErrorCode,
): SessionMeta[] {
  return sessions.filter(
    (session) =>
      session.agentId === agentId &&
      session.status === 'error' &&
      (errorCode === undefined || normalizeSessionErrorCode(session) === errorCode),
  );
}

export function buildClearedSessionUpdates(now = Date.now()): Partial<SessionMeta> {
  return {
    status: 'idle',
    messageCount: 0,
    lastActivity: now,
    contextTokensEstimate: 0,
    compactionCount: 0,
    error: undefined,
    errorCode: undefined,
  };
}
