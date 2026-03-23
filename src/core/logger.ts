// Structured JSON logger — no internal dependencies

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  ts: number;
  level: LogLevel;
  name: string;
  msg: string;
  [key: string]: unknown;
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
    const entry: LogEntry = { ts: Date.now(), level, name, msg, ...data };
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
