import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import type { Message, SessionKey } from '../types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('session:store');

export interface StoredMessage extends Message {
  id: string;
  sessionKey: string;
  timestamp: number;
}

/** Convert session key like `agent:main:cli-abc` → safe filename `agent-main-cli-abc.jsonl` */
export function sessionKeyToFilename(sessionKey: SessionKey): string {
  return sessionKey.replace(/:/g, '-') + '.jsonl';
}

/**
 * Append-only JSONL session store. One file per session.
 * Reads reconstruct the full message list by streaming line-by-line.
 */
export class SessionStore {
  constructor(private readonly sessionsDir: string) {}

  private filePath(sessionKey: SessionKey): string {
    return join(this.sessionsDir, sessionKeyToFilename(sessionKey));
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
  }

  async append(sessionKey: SessionKey, message: StoredMessage): Promise<void> {
    await this.ensureDir();
    await appendFile(this.filePath(sessionKey), JSON.stringify(message) + '\n', 'utf-8');
  }

  async appendMany(sessionKey: SessionKey, messages: StoredMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.ensureDir();
    const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
    await appendFile(this.filePath(sessionKey), lines, 'utf-8');
  }

  async readAll(sessionKey: SessionKey): Promise<StoredMessage[]> {
    const path = this.filePath(sessionKey);
    if (!existsSync(path)) return [];

    const messages: StoredMessage[] = [];
    const rl = createInterface({
      input: createReadStream(path, 'utf-8'),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        messages.push(JSON.parse(trimmed) as StoredMessage);
      } catch (err) {
        logger.warn('Skipping malformed JSONL line', { error: String(err) });
      }
    }

    return messages;
  }

  async readLast(sessionKey: SessionKey, count: number): Promise<StoredMessage[]> {
    const all = await this.readAll(sessionKey);
    return all.slice(-count);
  }

  exists(sessionKey: SessionKey): boolean {
    return existsSync(this.filePath(sessionKey));
  }

  /** Overwrite the session file with the given messages (used after compaction). */
  async overwrite(sessionKey: SessionKey, messages: StoredMessage[]): Promise<void> {
    await this.ensureDir();
    const { writeFile } = await import('node:fs/promises');
    const content =
      messages.length > 0 ? messages.map((m) => JSON.stringify(m)).join('\n') + '\n' : '';
    await writeFile(this.filePath(sessionKey), content, 'utf-8');
  }
}
