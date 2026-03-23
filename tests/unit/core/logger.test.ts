import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type LogLevel,
  createLogger,
  setLogLevel,
  setLogOutput,
} from '../../../src/core/logger.js';

describe('logger', () => {
  const captured: unknown[] = [];

  beforeEach(() => {
    setLogLevel('debug');
    setLogOutput((entry) => {
      captured.push(entry);
    });
    captured.length = 0;
  });

  afterEach(() => {
    // restore defaults
    setLogLevel('info');
    setLogOutput((entry) => process.stdout.write(`${JSON.stringify(entry)}\n`));
  });

  it('emits messages with correct level and name', () => {
    const log = createLogger('test');
    log.info('hello world');
    expect(captured).toHaveLength(1);
    const entry = captured[0] as Record<string, unknown>;
    expect(entry.level).toBe('info');
    expect(entry.name).toBe('test');
    expect(entry.msg).toBe('hello world');
    expect(typeof entry.ts).toBe('number');
  });

  it('spreads extra data into the log entry', () => {
    const log = createLogger('test');
    log.warn('oops', { code: 42, extra: 'ctx' });
    const entry = captured[0] as Record<string, unknown>;
    expect(entry.code).toBe(42);
    expect(entry.extra).toBe('ctx');
  });

  it('filters messages below the configured log level', () => {
    setLogLevel('warn');
    const log = createLogger('test');
    log.debug('ignored');
    log.info('also ignored');
    log.warn('visible');
    expect(captured).toHaveLength(1);
    const entry = captured[0] as Record<string, unknown>;
    expect(entry.level).toBe('warn');
  });

  it('emits all levels when set to debug', () => {
    setLogLevel('debug');
    const log = createLogger('test');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(captured).toHaveLength(4);
  });

  it('child logger prefixes name with parent', () => {
    const parent = createLogger('parent');
    const child = parent.child('child');
    child.info('from child');
    const entry = captured[0] as Record<string, unknown>;
    expect(entry.name).toBe('parent:child');
  });

  it('supports all 4 log levels API', () => {
    const log = createLogger('lvl');
    for (const level of ['debug', 'info', 'warn', 'error'] as LogLevel[]) {
      captured.length = 0;
      log[level](`msg-${level}`);
      expect((captured[0] as Record<string, unknown>).level).toBe(level);
    }
  });
});
