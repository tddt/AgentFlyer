import { describe, it, expect, vi } from 'vitest';
import { ApiKeyRotator, buildRotator } from '../../../src/agent/llm/auth-rotation.js';
import { FailoverProvider } from '../../../src/agent/llm/failover.js';
import type { LLMProvider } from '../../../src/agent/llm/provider.js';
import type { StreamChunk } from '../../../src/core/types.js';

// ─── ApiKeyRotator ────────────────────────────────────────────────────────────
describe('ApiKeyRotator', () => {
  it('round-robins through multiple keys', () => {
    const r = new ApiKeyRotator(['key-a', 'key-b', 'key-c']);
    expect(r.next()).toBe('key-a');
    expect(r.next()).toBe('key-b');
    expect(r.next()).toBe('key-c');
    expect(r.next()).toBe('key-a'); // wraps around
  });

  it('accepts a comma-separated string', () => {
    const r = new ApiKeyRotator('alpha,beta, gamma ');
    expect(r.count).toBe(3);
    expect(r.next()).toBe('alpha');
    expect(r.next()).toBe('beta');
    expect(r.next()).toBe('gamma');
  });

  it('filters empty entries from array', () => {
    const r = new ApiKeyRotator(['k1', '', 'k2']);
    expect(r.count).toBe(2);
  });

  it('throws when no keys are provided', () => {
    expect(() => new ApiKeyRotator([])).toThrow('no API keys provided');
    expect(() => new ApiKeyRotator('')).toThrow('no API keys provided');
    expect(() => new ApiKeyRotator(', , ')).toThrow('no API keys provided');
  });

  it('count returns number of managed keys', () => {
    expect(new ApiKeyRotator(['x', 'y']).count).toBe(2);
  });

  it('single key always returns the same key', () => {
    const r = new ApiKeyRotator(['only-key']);
    expect(r.next()).toBe('only-key');
    expect(r.next()).toBe('only-key');
  });
});

// ─── buildRotator ─────────────────────────────────────────────────────────────
describe('buildRotator', () => {
  it('returns rotator from explicit keys', () => {
    const r = buildRotator({ keys: ['k1', 'k2'] });
    expect(r).not.toBeNull();
    expect(r!.count).toBe(2);
  });

  it('returns rotator from env var', () => {
    process.env['TEST_ROTATOR_KEYS'] = 'env1,env2';
    const r = buildRotator({ envVar: 'TEST_ROTATOR_KEYS' });
    delete process.env['TEST_ROTATOR_KEYS'];
    expect(r).not.toBeNull();
    expect(r!.count).toBe(2);
    expect(r!.next()).toBe('env1');
  });

  it('falls back to fallbackEnv', () => {
    process.env['TEST_FALLBACK_KEY'] = 'fallback-value';
    const r = buildRotator({ fallbackEnv: 'TEST_FALLBACK_KEY' });
    delete process.env['TEST_FALLBACK_KEY'];
    expect(r).not.toBeNull();
    expect(r!.count).toBe(1);
    expect(r!.next()).toBe('fallback-value');
  });

  it('returns null when no source available', () => {
    const r = buildRotator({});
    expect(r).toBeNull();
  });

  it('explicit keys take priority over env var', () => {
    process.env['TEST_ROTATOR_KEYS'] = 'from-env';
    const r = buildRotator({ keys: ['from-keys'], envVar: 'TEST_ROTATOR_KEYS' });
    delete process.env['TEST_ROTATOR_KEYS'];
    expect(r!.next()).toBe('from-keys');
  });
});

// ─── FailoverProvider helpers ─────────────────────────────────────────────────
function makeProvider(
  id: string,
  chunks: StreamChunk[],
  opts: { throws?: string; supportsAll?: boolean } = {},
): LLMProvider {
  return {
    id,
    supports: () => opts.supportsAll !== false,
    async *run() {
      if (opts.throws) throw new Error(opts.throws);
      for (const c of chunks) yield c;
    },
    async countTokens() { return 10; },
  };
}
describe('FailoverProvider', () => {
  it('id is prefixed with failover:', () => {
    const p = makeProvider('primary', []);
    const fp = new FailoverProvider({ primary: p });
    expect(fp.id).toBe('failover:primary');
  });

  it('supports() delegates to primary', () => {
    const p = makeProvider('p', [], { supportsAll: true });
    const fp = new FailoverProvider({ primary: p });
    expect(fp.supports('any-model')).toBe(true);
  });

  it('streams chunks from primary on success', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
      { type: 'done', stopReason: 'end_turn', inputTokens: 0, outputTokens: 0 },
    ];
    const fp = new FailoverProvider({ primary: makeProvider('p', chunks) });
    const results: StreamChunk[] = [];
    for await (const c of fp.run({ model: 'm', systemPrompt: '', messages: [], tools: [], maxTokens: 100 })) {
      results.push(c);
    }
    expect(results).toHaveLength(3);
    expect((results[0] as { text: string }).text).toBe('hello ');
  });

  it('retries on error chunk from primary', async () => {
    let calls = 0;
    const retryProvider: LLMProvider = {
      id: 'p',
      supports: () => true,
      async *run() {
        calls++;
        yield { type: 'error' as const, message: 'transient' };
      },
      async countTokens() { return 10; },
    };
    const fp = new FailoverProvider({ primary: retryProvider, maxRetries: 2 });
    const results: StreamChunk[] = [];
    for await (const c of fp.run({ model: 'm', systemPrompt: '', messages: [], tools: [], maxTokens: 100 })) {
      results.push(c);
    }
    // Should have tried maxRetries+1 times then emitted final error
    expect(calls).toBe(3); // 1 initial + 2 retries
    expect(results.at(-1)?.type).toBe('error');
  });

  it('falls back to fallback provider on exhausted retries', async () => {
    const alwaysError = makeProvider('p', [{ type: 'error', message: 'bad' }]);
    const fallback = makeProvider('fb', [
      { type: 'text', text: 'from fallback' },
      { type: 'done', stopReason: 'end_turn', inputTokens: 0, outputTokens: 0 },
    ]);
    const fp = new FailoverProvider({ primary: alwaysError, fallbackProvider: fallback, maxRetries: 0 });
    const results: StreamChunk[] = [];
    for await (const c of fp.run({ model: 'm', systemPrompt: '', messages: [], tools: [], maxTokens: 100 })) {
      results.push(c);
    }
    const textChunk = results.find((c) => c.type === 'text') as { text: string } | undefined;
    expect(textChunk?.text).toBe('from fallback');
  });

  it('countTokens delegates to primary', async () => {
    const primary = makeProvider('p', []);
    const fp = new FailoverProvider({ primary });
    const n = await fp.countTokens([], 'model-x');
    expect(n).toBe(10);
  });

  it('yields error when all providers fail', async () => {
    const alwaysFail = makeProvider('p', [{ type: 'error', message: 'fail' }]);
    const fp = new FailoverProvider({ primary: alwaysFail, maxRetries: 0 });
    const results: StreamChunk[] = [];
    for await (const c of fp.run({ model: 'm', systemPrompt: '', messages: [], tools: [], maxTokens: 100 })) {
      results.push(c);
    }
    expect(results.at(-1)?.type).toBe('error');
  });
});
