import { describe, expect, it } from 'vitest';
import {
  type AppError,
  type ErrorCode,
  type Result,
  err,
  makeSessionKey,
  ok,
  parseSessionKey,
} from './types.js';

// ─── ErrorCode ────────────────────────────────────────────────────────────────

describe('ErrorCode domain coverage', () => {
  it('accepts all defined domain codes', () => {
    const codes: ErrorCode[] = [
      'CORE_INVALID_ARG',
      'CORE_IO_ERROR',
      'CORE_NOT_FOUND',
      'AGENT_RUN_FAILED',
      'AGENT_TOOL_DENIED',
      'AGENT_TOOL_TIMEOUT',
      'AGENT_LLM_ERROR',
      'GATEWAY_AUTH_FAILED',
      'GATEWAY_RATE_LIMITED',
      'GATEWAY_RPC_UNKNOWN',
      'MCP_CONNECT_FAILED',
      'MCP_TOOL_CALL_ERROR',
      'MESH_DELEGATE_FAILED',
      'FED_PEER_UNREACHABLE',
    ];
    // 14 domain codes defined in types.ts
    expect(codes).toHaveLength(14);
  });
});

// ─── AppError ─────────────────────────────────────────────────────────────────

describe('AppError', () => {
  it('has required fields', () => {
    const e: AppError = { code: 'CORE_NOT_FOUND', message: 'item missing' };
    expect(e.code).toBe('CORE_NOT_FOUND');
    expect(e.message).toBe('item missing');
    expect(e.details).toBeUndefined();
  });

  it('accepts optional details', () => {
    const e: AppError = {
      code: 'AGENT_LLM_ERROR',
      message: 'LLM call failed',
      details: { model: 'claude', status: 429 },
    };
    expect(e.details).toStrictEqual({ model: 'claude', status: 429 });
  });
});

// ─── Result<T, E> ─────────────────────────────────────────────────────────────

describe('ok()', () => {
  it('creates a successful result', () => {
    const r: Result<number> = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(42);
    }
  });

  it('works with string', () => {
    const r = ok('hello');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('hello');
  });

  it('works with object', () => {
    const r = ok({ x: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toStrictEqual({ x: 1 });
  });
});

describe('err()', () => {
  it('creates a failed result with AppError', () => {
    const r: Result<string> = err({ code: 'CORE_INVALID_ARG', message: 'bad input' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('CORE_INVALID_ARG');
      expect(r.error.message).toBe('bad input');
    }
  });

  it('works with custom error type', () => {
    type MyErr = { kind: 'timeout' };
    const r: Result<number, MyErr> = err({ kind: 'timeout' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('timeout');
  });
});

describe('Result discriminated union', () => {
  function divide(a: number, b: number): Result<number, AppError> {
    if (b === 0) return err({ code: 'CORE_INVALID_ARG', message: 'division by zero' });
    return ok(a / b);
  }

  it('returns ok on valid division', () => {
    const r = divide(10, 2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(5);
  });

  it('returns err on division by zero', () => {
    const r = divide(10, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('CORE_INVALID_ARG');
    }
  });
});

// ─── Session key helpers (smoke tests) ───────────────────────────────────────

describe('makeSessionKey / parseSessionKey', () => {
  it('round-trips a valid key', () => {
    const key = makeSessionKey('a1' as never, 'thread:t1' as never);
    expect(key).toBe('agent:a1:thread:t1');
    const parsed = parseSessionKey(key);
    expect(parsed).not.toBeNull();
    expect(parsed?.agentId).toBe('a1');
    expect(parsed?.threadKey).toBe('thread:t1');
  });

  it('throws on blank agentId', () => {
    expect(() => makeSessionKey(' ' as never, 'thread:t1' as never)).toThrow();
  });

  it('throws on blank threadKey', () => {
    expect(() => makeSessionKey('a1' as never, '  ' as never)).toThrow();
  });
});
