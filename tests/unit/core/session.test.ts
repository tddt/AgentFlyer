import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
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
    };
    await metaStore.set(meta);
    const loaded = await metaStore.get(key);
    expect(loaded).not.toBeNull();
    expect(loaded?.messageCount).toBe(3);
    expect(loaded?.agentId).toBe('agent1');
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
