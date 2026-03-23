import { describe, expect, it, vi } from 'vitest';
import {
  type ToolPolicy,
  autoApprove,
  checkPolicy,
  denyApproval,
  filterAllowedTools,
  policyBlockedResult,
} from '../../../src/agent/tools/policy.js';
import { ToolRegistry } from '../../../src/agent/tools/registry.js';

// ─── checkPolicy ─────────────────────────────────────────────────────────────
describe('checkPolicy', () => {
  const basePolicy: ToolPolicy = {
    denylist: [],
    requireApproval: [],
  };

  it('allows a tool when there are no restrictions', () => {
    const r = checkPolicy('bash', basePolicy);
    expect(r.allowed).toBe(true);
    expect(r.requiresApproval).toBe(false);
  });

  it('blocks a denylisted tool', () => {
    const policy: ToolPolicy = { ...basePolicy, denylist: ['bash'] };
    const r = checkPolicy('bash', policy);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('bash');
  });

  it('blocks a tool not on the allowlist', () => {
    const policy: ToolPolicy = {
      ...basePolicy,
      allowlist: ['read_file'],
    };
    const r = checkPolicy('bash', policy);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('bash');
  });

  it('allows a tool that is on the allowlist', () => {
    const policy: ToolPolicy = {
      ...basePolicy,
      allowlist: ['read_file', 'write_file'],
    };
    const r = checkPolicy('read_file', policy);
    expect(r.allowed).toBe(true);
  });

  it('emits requiresApproval=true for approval-required tools', () => {
    const policy: ToolPolicy = {
      ...basePolicy,
      requireApproval: ['bash'],
    };
    const r = checkPolicy('bash', policy);
    expect(r.allowed).toBe(true);
    expect(r.requiresApproval).toBe(true);
  });

  it('denylist takes priority over requireApproval', () => {
    const policy: ToolPolicy = {
      denylist: ['bash'],
      requireApproval: ['bash'],
    };
    const r = checkPolicy('bash', policy);
    expect(r.allowed).toBe(false);
  });

  it('returns allowed=true when allowlist is an empty array (no allowlist active)', () => {
    const policy: ToolPolicy = {
      denylist: [],
      requireApproval: [],
      allowlist: [],
    };
    // empty allowlist means allowlist is inactive
    const r = checkPolicy('anything', policy);
    expect(r.allowed).toBe(true);
  });
});

// ─── filterAllowedTools ───────────────────────────────────────────────────────
describe('filterAllowedTools', () => {
  it('removes denylisted tools', () => {
    const policy: ToolPolicy = { denylist: ['bash', 'exec'], requireApproval: [] };
    const result = filterAllowedTools(['read_file', 'bash', 'write_file', 'exec'], policy);
    expect(result).toEqual(['read_file', 'write_file']);
  });

  it('returns all when no restrictions', () => {
    const policy: ToolPolicy = { denylist: [], requireApproval: [] };
    const names = ['a', 'b', 'c'];
    expect(filterAllowedTools(names, policy)).toEqual(names);
  });

  it('keeps approval-required tools in the list (allowed=true)', () => {
    const policy: ToolPolicy = { denylist: [], requireApproval: ['bash'] };
    const result = filterAllowedTools(['bash', 'read_file'], policy);
    expect(result).toContain('bash');
  });
});

// ─── approval handlers ────────────────────────────────────────────────────────
describe('autoApprove', () => {
  it('always returns true', async () => {
    expect(await autoApprove('anything', {})).toBe(true);
  });
});

describe('denyApproval', () => {
  it('always returns false', async () => {
    expect(await denyApproval('anything', {})).toBe(false);
  });
});

// ─── policyBlockedResult ──────────────────────────────────────────────────────
describe('policyBlockedResult', () => {
  it('returns an isError result with reason in content', () => {
    const r = policyBlockedResult('not allowed here');
    expect(r.isError).toBe(true);
    expect(r.content).toContain('not allowed here');
  });
});

// ─── ToolRegistry ────────────────────────────────────────────────────────────
describe('ToolRegistry', () => {
  function makeRegistry() {
    return new ToolRegistry();
  }

  it('has() returns false for unregistered tool', () => {
    const reg = makeRegistry();
    expect(reg.has('unknown')).toBe(false);
  });

  it('register() and has() round-trip', () => {
    const reg = makeRegistry();
    reg.register({
      definition: { name: 'my_tool', description: 'test tool', inputSchema: {} },
      handler: async () => ({ isError: false, content: 'ok' }),
      category: 'builtin',
    });
    expect(reg.has('my_tool')).toBe(true);
  });

  it('get() returns registered tool', () => {
    const reg = makeRegistry();
    const handler = async () => ({ isError: false, content: 'result' });
    reg.register({
      definition: { name: 'tool_a', description: 'd', inputSchema: {} },
      handler,
      category: 'test',
    });
    const t = reg.get('tool_a');
    expect(t).toBeDefined();
    expect(t?.definition.name).toBe('tool_a');
    expect(t?.category).toBe('test');
  });

  it('get() returns undefined for unknown tool', () => {
    expect(makeRegistry().get('nope')).toBeUndefined();
  });

  it('getDefinitions() returns all registered definitions', () => {
    const reg = makeRegistry();
    reg.registerMany([
      {
        definition: { name: 'a', description: '', inputSchema: {} },
        handler: async () => ({ isError: false, content: '' }),
        category: 'x',
      },
      {
        definition: { name: 'b', description: '', inputSchema: {} },
        handler: async () => ({ isError: false, content: '' }),
        category: 'x',
      },
    ]);
    const defs = reg.getDefinitions();
    expect(defs).toHaveLength(2);
    expect(defs.map((d) => d.name)).toContain('a');
    expect(defs.map((d) => d.name)).toContain('b');
  });

  it('execute() calls the handler and returns result', async () => {
    const reg = makeRegistry();
    const handler = vi.fn(async () => ({ isError: false, content: 'hello' }));
    reg.register({
      definition: { name: 'greet', description: '', inputSchema: {} },
      handler,
      category: 'test',
    });
    const result = await reg.execute('greet', { name: 'world' });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('hello');
    expect(handler).toHaveBeenCalledWith({ name: 'world' });
  });

  it('execute() returns error result for unknown tool', async () => {
    const result = await makeRegistry().execute('ghost', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('ghost');
  });

  it('execute() returns error result when handler throws', async () => {
    const reg = makeRegistry();
    reg.register({
      definition: { name: 'boom', description: '', inputSchema: {} },
      handler: async () => {
        throw new Error('oops');
      },
      category: 'test',
    });
    const result = await reg.execute('boom', {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('oops');
  });

  it('list() returns all registered tools', () => {
    const reg = makeRegistry();
    reg.register({
      definition: { name: 'x', description: '', inputSchema: {} },
      handler: async () => ({ isError: false, content: '' }),
      category: 'c',
    });
    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0]?.definition.name).toBe('x');
  });
});
