import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionKey } from '../types.js';

export type SessionStatus = 'idle' | 'running' | 'compacting' | 'error';
export type SessionErrorCode =
  | 'generic'
  | 'rate_limit'
  | 'overloaded'
  | 'context_overflow'
  | 'compaction_failure'
  | 'transient_http'
  | 'billing'
  | 'tool_loop'
  | 'tool_round_limit';

export interface SessionMeta {
  sessionKey: SessionKey;
  status: SessionStatus;
  messageCount: number;
  lastActivity: number;
  createdAt: number;
  agentId: string;
  threadKey: string;
  contextTokensEstimate: number;
  lastCompactionAt?: number;
  compactionCount: number;
  error?: string;
  errorCode?: SessionErrorCode;
}

function sessionKeyToMetaFilename(sessionKey: SessionKey): string {
  return `${sessionKey.replace(/:/g, '-')}.meta.json`;
}

/** Read/write `.meta.json` files alongside session JSONL files. */
export class SessionMetaStore {
  constructor(private readonly sessionsDir: string) {}

  private filePath(sessionKey: SessionKey): string {
    return join(this.sessionsDir, sessionKeyToMetaFilename(sessionKey));
  }

  async get(sessionKey: SessionKey): Promise<SessionMeta | null> {
    const path = this.filePath(sessionKey);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(await readFile(path, 'utf-8')) as SessionMeta;
    } catch {
      return null;
    }
  }

  async set(meta: SessionMeta): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await writeFile(this.filePath(meta.sessionKey), JSON.stringify(meta, null, 2), 'utf-8');
  }

  async update(sessionKey: SessionKey, updates: Partial<SessionMeta>): Promise<SessionMeta> {
    const existing = await this.get(sessionKey);
    const now = Date.now();
    const meta: SessionMeta = {
      sessionKey,
      status: 'idle',
      messageCount: 0,
      lastActivity: now,
      createdAt: now,
      agentId: '',
      threadKey: '',
      contextTokensEstimate: 0,
      compactionCount: 0,
      ...existing,
      ...updates,
    };
    await this.set(meta);
    return meta;
  }

  async listAll(): Promise<SessionMeta[]> {
    if (!existsSync(this.sessionsDir)) return [];
    const files = await readdir(this.sessionsDir);
    const results: SessionMeta[] = [];
    for (const f of files) {
      if (!f.endsWith('.meta.json')) continue;
      try {
        const raw = await readFile(join(this.sessionsDir, f), 'utf-8');
        results.push(JSON.parse(raw) as SessionMeta);
      } catch {
        // skip corrupt files
      }
    }
    return results;
  }
}
