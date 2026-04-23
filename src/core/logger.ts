// Structured JSON logger — no internal dependencies
import { AsyncLocalStorage } from 'node:async_hooks';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RequestContext {
  requestId: string;
  correlationId?: string;
}

interface LogEntry {
  ts: number;
  level: LogLevel;
  name: string;
  msg: string;
  [key: string]: unknown;
}

// ── Request context propagation (AsyncLocalStorage) ──────────────────────────

const _requestStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with a request-scoped context containing requestId / correlationId.
 * All log entries emitted inside `fn` will include these fields automatically.
 */
export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return _requestStorage.run(ctx, fn);
}

/** Return the current request context from the async local store, if any. */
export function getRequestContext(): RequestContext | undefined {
  return _requestStorage.getStore();
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(name: string): Logger;
}

const LEVELS: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

let _minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info';
let _outputFn: (entry: LogEntry) => void = (entry) => {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
};

export function setLogLevel(level: LogLevel): void {
  _minLevel = level;
}

export function setLogOutput(fn: (entry: LogEntry) => void): void {
  _outputFn = fn;
}

export function createLogger(name: string): Logger {
  function write(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[_minLevel]) return;
    const ctx = _requestStorage.getStore();
    const entry: LogEntry = {
      ts: Date.now(),
      level,
      name,
      msg,
      ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
      ...(ctx?.correlationId ? { correlationId: ctx.correlationId } : {}),
      ...data,
    };
    _outputFn(entry);
  }

  const logger: Logger = {
    debug: (msg, data) => write('debug', msg, data),
    info: (msg, data) => write('info', msg, data),
    warn: (msg, data) => write('warn', msg, data),
    error: (msg, data) => write('error', msg, data),
    child: (childName) => createLogger(`${name}:${childName}`),
  };

  return logger;
}
