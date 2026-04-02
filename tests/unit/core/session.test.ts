import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { summarizeSessionErrors } from '../../../src/core/session/error-stats.js';
import {
  buildClearedSessionUpdates,
  findFailedSessionsForAgent,
} from '../../../src/core/session/recovery.js';
import { SessionMetaStore } from '../../../src/core/session/meta.js';
import { SessionStore } from '../../../src/core/session/store.js';
import type { StoredMessage } from '../../../src/core/session/store.js';
import { asAgentId, asThreadKey, makeSessionKey } from '../../../src/core/types.js';
import type { SessionKey } from '../../../src/core/types.js';

let _tmpDir: string;

function makeTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'agentflyer-session-test-'));
}

function makeMsg(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  sessionKey: SessionKey,
): StoredMessage {
  return {
    id,
    sessionKey,
    role,
    content,
    timestamp: Date.now(),
  };
}

describe('SessionStore', () => {
  let store: SessionStore;
  let sessionsDir: string;
  let key: SessionKey;

  beforeEach(() => {
    sessionsDir = makeTestDir();
    store = new SessionStore(sessionsDir);
    key = makeSessionKey(asAgentId('agent1'), asThreadKey('thread1'));
  });

  it('returns empty array for non-existent session', async () => {
    const msgs = await store.readAll(key);
    expect(msgs).toEqual([]);
  });

  it('appends and reads back a single message', async () => {
    const msg = makeMsg('m1', 'user', 'hello', key);
    await store.append(key, msg);
    const msgs = await store.readAll(key);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.content).toBe('hello');
  });

  it('appendMany writes multiple messages', async () => {
    const msgs = [
      makeMsg('m1', 'user', 'hi', key),
      makeMsg('m2', 'assistant', 'hello', key),
      makeMsg('m3', 'user', 'bye', key),
    ];
    await store.appendMany(key, msgs);
    const read = await store.readAll(key);
    expect(read).toHaveLength(3);
    expect(read.map((m) => m.content)).toEqual(['hi', 'hello', 'bye']);
  });

  it('appendMany is a no-op for empty array', async () => {
    await store.appendMany(key, []);
    expect(await store.readAll(key)).toEqual([]);
  });

  it('readLast returns at most N messages', async () => {
    const msgs = [1, 2, 3, 4, 5].map((i) => makeMsg(`m${i}`, 'user', `msg${i}`, key));
    await store.appendMany(key, msgs);
    const last3 = await store.readLast(key, 3);
    expect(last3).toHaveLength(3);
    expect(last3[0]?.content).toBe('msg3');
    expect(last3[2]?.content).toBe('msg5');
  });

  it('overwrite replaces all messages', async () => {
    await store.appendMany(key, [
      makeMsg('old1', 'user', 'old', key),
      makeMsg('old2', 'assistant', 'old reply', key),
    ]);
    const newMsgs = [makeMsg('new1', 'user', 'new content', key)];
    await store.overwrite(key, newMsgs);
    const result = await store.readAll(key);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe('new content');
  });

  it('overwrite with empty array clears session', async () => {
    await store.append(key, makeMsg('x', 'user', 'x', key));
    await store.overwrite(key, []);
    expect(await store.readAll(key)).toEqual([]);
  });

  it('exists returns true only after write', async () => {
    expect(store.exists(key)).toBe(false);
    await store.append(key, makeMsg('m', 'user', 'test', key));
    expect(store.exists(key)).toBe(true);
  });
});

describe('SessionMetaStore', () => {
  let metaStore: SessionMetaStore;
  let key: SessionKey;

  beforeEach(() => {
    const dir = makeTestDir();
    metaStore = new SessionMetaStore(dir);
    key = makeSessionKey(asAgentId('agent1'), asThreadKey('thread1'));
  });

  it('returns null for unknown session', async () => {
    const meta = await metaStore.get(key);
    expect(meta).toBeNull();
  });

  it('set and get round-trip', async () => {
    const meta = {
      sessionKey: key,
      status: 'idle' as const,
      messageCount: 3,
      lastActivity: 1000,
      createdAt: 500,
      agentId: 'agent1',
      threadKey: 'thread1',
      contextTokensEstimate: 200,
      compactionCount: 0,
      errorCode: 'generic' as const,
    };
    await metaStore.set(meta);
    const loaded = await metaStore.get(key);
    expect(loaded).not.toBeNull();
    expect(loaded?.messageCount).toBe(3);
    expect(loaded?.agentId).toBe('agent1');
    expect(loaded?.errorCode).toBe('generic');
  });

  it('update merges fields with defaults', async () => {
    const updated = await metaStore.update(key, { messageCount: 5, status: 'running' });
    expect(updated.messageCount).toBe(5);
    expect(updated.status).toBe('running');
    expect(typeof updated.createdAt).toBe('number');
  });

  it('update persists changes', async () => {
    await metaStore.update(key, { messageCount: 7 });
    const loaded = await metaStore.get(key);
    expect(loaded?.messageCount).toBe(7);
  });
});

describe('summarizeSessionErrors', () => {
  it('aggregates current breakdown and recent trend from errored sessions', () => {
    const now = Date.UTC(2026, 3, 1, 12, 0, 0);
    const sessions = [
      {
        sessionKey: makeSessionKey(asAgentId('agent1'), asThreadKey('thread1')),
        status: 'error' as const,
        messageCount: 3,
        lastActivity: now,
        createdAt: now,
        agentId: 'agent1',
        threadKey: 'thread1',
        contextTokensEstimate: 120,
        compactionCount: 0,
        errorCode: 'rate_limit' as const,
      },
      {
        sessionKey: makeSessionKey(asAgentId('agent1'), asThreadKey('thread2')),
        status: 'error' as const,
        messageCount: 5,
        lastActivity: now - 86_400_000,
        createdAt: now - 86_400_000,
        agentId: 'agent1',
        threadKey: 'thread2',
        contextTokensEstimate: 220,
        compactionCount: 1,
        errorCode: 'context_overflow' as const,
      },
      {
        sessionKey: makeSessionKey(asAgentId('agent2'), asThreadKey('thread3')),
        status: 'error' as const,
        messageCount: 2,
        lastActivity: now - 10 * 86_400_000,
        createdAt: now - 10 * 86_400_000,
        agentId: 'agent2',
        threadKey: 'thread3',
        contextTokensEstimate: 80,
        compactionCount: 0,
        errorCode: 'rate_limit' as const,
      },
      {
        sessionKey: makeSessionKey(asAgentId('agent2'), asThreadKey('thread4')),
        status: 'idle' as const,
        messageCount: 8,
        lastActivity: now,
        createdAt: now,
        agentId: 'agent2',
        threadKey: 'thread4',
        contextTokensEstimate: 60,
        compactionCount: 0,
      },
    ];

    const summary = summarizeSessionErrors(sessions, 7, now);

    expect(summary.totalErrorSessions).toBe(3);
    expect(summary.recentErrorSessions).toBe(2);
    expect(summary.latestErrorAt).toBe(now);
    expect(summary.breakdown).toEqual([
      {
        code: 'rate_limit',
        count: 2,
        lastSeenAt: now,
      },
      {
        code: 'context_overflow',
        count: 1,
        lastSeenAt: now - 86_400_000,
      },
    ]);
    expect(summary.trend).toHaveLength(7);
    expect(summary.trend.at(-2)).toEqual({ date: '2026-03-31', count: 1 });
    expect(summary.trend.at(-1)).toEqual({ date: '2026-04-01', count: 1 });
    expect(summary.byAgent).toEqual([
      {
        agentId: 'agent1',
        totalErrorSessions: 2,
        recentErrorSessions: 2,
        latestErrorAt: now,
        topErrorCode: 'context_overflow',
        trend: [
          { date: '2026-03-26', count: 0 },
          { date: '2026-03-27', count: 0 },
          { date: '2026-03-28', count: 0 },
          { date: '2026-03-29', count: 0 },
          { date: '2026-03-30', count: 0 },
          { date: '2026-03-31', count: 1 },
          { date: '2026-04-01', count: 1 },
        ],
      },
      {
        agentId: 'agent2',
        totalErrorSessions: 1,
        recentErrorSessions: 0,
        latestErrorAt: now - 10 * 86_400_000,
        topErrorCode: 'rate_limit',
        trend: [
          { date: '2026-03-26', count: 0 },
          { date: '2026-03-27', count: 0 },
          { date: '2026-03-28', count: 0 },
          { date: '2026-03-29', count: 0 },
          { date: '2026-03-30', count: 0 },
          { date: '2026-03-31', count: 0 },
          { date: '2026-04-01', count: 0 },
        ],
      },
    ]);
  });

  it('normalizes legacy error sessions without an errorCode to generic', () => {
    const now = Date.UTC(2026, 3, 1, 12, 0, 0);
    const summary = summarizeSessionErrors(
      [
        {
          sessionKey: makeSessionKey(asAgentId('agent1'), asThreadKey('legacy')),
          status: 'error' as const,
          messageCount: 1,
          lastActivity: now,
          createdAt: now,
          agentId: 'agent1',
          threadKey: 'legacy',
          contextTokensEstimate: 30,
          compactionCount: 0,
        },
      ],
      3,
      now,
    );

    expect(summary.breakdown).toEqual([
      {
        code: 'generic',
        count: 1,
        lastSeenAt: now,
      },
    ]);
    expect(summary.byAgent).toEqual([
      {
        agentId: 'agent1',
        totalErrorSessions: 1,
        recentErrorSessions: 1,
        latestErrorAt: now,
        topErrorCode: 'generic',
        trend: [
          { date: '2026-03-30', count: 0 },
          { date: '2026-03-31', count: 0 },
          { date: '2026-04-01', count: 1 },
        ],
      },
    ]);
  });
});

describe('session recovery helpers', () => {
  it('finds only failed sessions for a target agent and optional error code', () => {
    const sessions = [
      {
        sessionKey: makeSessionKey(asAgentId('agent1'), asThreadKey('a')),
        status: 'error' as const,
        messageCount: 1,
        lastActivity: 1,
        createdAt: 1,
        agentId: 'agent1',
        threadKey: 'a',
        contextTokensEstimate: 10,
        compactionCount: 0,
        errorCode: 'rate_limit' as const,
      },
      {
        sessionKey: makeSessionKey(asAgentId('agent1'), asThreadKey('b')),
        status: 'error' as const,
        messageCount: 2,
        lastActivity: 2,
        createdAt: 2,
        agentId: 'agent1',
        threadKey: 'b',
        contextTokensEstimate: 20,
        compactionCount: 0,
        errorCode: 'billing' as const,
      },
      {
        sessionKey: makeSessionKey(asAgentId('agent2'), asThreadKey('c')),
        status: 'error' as const,
        messageCount: 3,
        lastActivity: 3,
        createdAt: 3,
        agentId: 'agent2',
        threadKey: 'c',
        contextTokensEstimate: 30,
        compactionCount: 0,
        errorCode: 'rate_limit' as const,
      },
      {
        sessionKey: makeSessionKey(asAgentId('agent1'), asThreadKey('d')),
        status: 'idle' as const,
        messageCount: 4,
        lastActivity: 4,
        createdAt: 4,
        agentId: 'agent1',
        threadKey: 'd',
        contextTokensEstimate: 40,
        compactionCount: 0,
      },
    ];

    expect(findFailedSessionsForAgent(sessions, 'agent1')).toHaveLength(2);
    expect(findFailedSessionsForAgent(sessions, 'agent1', 'rate_limit')).toEqual([sessions[0]]);
  });

  it('matches legacy generic failures when filtering by generic error code', () => {
    const sessions = [
      {
        sessionKey: makeSessionKey(asAgentId('agent1'), asThreadKey('legacy')),
        status: 'error' as const,
        messageCount: 1,
        lastActivity: 1,
        createdAt: 1,
        agentId: 'agent1',
        threadKey: 'legacy',
        contextTokensEstimate: 10,
        compactionCount: 0,
      },
    ];

    expect(findFailedSessionsForAgent(sessions, 'agent1', 'generic')).toEqual([sessions[0]]);
  });

  it('builds cleared session updates that remove error state', () => {
    const updates = buildClearedSessionUpdates(1234);

    expect(updates).toEqual({
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
