/**
 * Circular log buffer + SSE broadcaster.
 * Install once via `logBroadcaster.install()` to intercept the global logger output
 * before any logging occurs. All subsequent entries are written to stdout (original
 * behaviour) AND forwarded to every registered SSE subscriber.
 */

import type { ServerResponse } from 'node:http';
import { setLogOutput } from '../core/logger.js';

interface LogEntry {
  ts: number;
  level: string;
  name: string;
  msg: string;
  [key: string]: unknown;
}

export class LogBroadcaster {
  private readonly capacity: number;
  private buffer: LogEntry[] = [];
  private subscribers = new Set<ServerResponse>();

  constructor(capacity = 500) {
    this.capacity = capacity;
  }

  /** Hook into the global logger, keeping stdout output intact. */
  install(): void {
    setLogOutput((entry) => {
      process.stdout.write(`${JSON.stringify(entry)}\n`);
      this.push(entry as LogEntry);
    });
  }

  push(entry: LogEntry): void {
    if (this.buffer.length >= this.capacity) this.buffer.shift();
    this.buffer.push(entry);

    const line = `data: ${JSON.stringify(entry)}\n\n`;
    for (const res of this.subscribers) {
      try {
        res.write(line);
      } catch {
        this.subscribers.delete(res);
      }
    }
  }

  /**
   * Subscribe an SSE ServerResponse.
   * Replays the buffered entries immediately, then streams future entries.
   * Automatically unsubscribes when the client disconnects.
   */
  subscribe(res: ServerResponse): void {
    this.subscribers.add(res);
    for (const entry of this.buffer) {
      try {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      } catch {
        this.subscribers.delete(res);
        return;
      }
    }
    res.on('close', () => this.subscribers.delete(res));
  }

  getBuffer(): LogEntry[] {
    return [...this.buffer];
  }
}

/** Singleton installed in lifecycle.ts before any logging occurs. */
export const logBroadcaster = new LogBroadcaster();
