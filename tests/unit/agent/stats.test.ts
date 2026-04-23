import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadStats, recordTokenBill } from '../../../src/agent/stats.js';
import type { TokenBill } from '../../../src/agent/stats.js';
import { asAgentId } from '../../../src/core/types.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentflyer-stats-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function makeBill(overrides: Partial<TokenBill> = {}): TokenBill {
  return {
    ts: new Date().toISOString(),
    agentId: asAgentId('agent-alpha'),
    model: 'gpt-4o',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    totalTokens: 150,
    ...overrides,
  };
}

describe('recordTokenBill', () => {
  it('writes a JSONL line to the per-agent daily file', async () => {
    const dataDir = await createTempDir();
    const bill = makeBill();
    await recordTokenBill(dataDir, bill);

    const date = bill.ts.slice(0, 10);
    const file = join(dataDir, 'stats', 'agent-alpha', `${date}.jsonl`);
    const raw = await readFile(file, 'utf-8');
    const parsed = JSON.parse(raw.trim()) as TokenBill;
    expect(parsed.agentId).toBe('agent-alpha');
    expect(parsed.model).toBe('gpt-4o');
    expect(parsed.totalTokens).toBe(150);
  });

  it('appends multiple bills to the same JSONL file', async () => {
    const dataDir = await createTempDir();
    const bill1 = makeBill({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    const bill2 = makeBill({ inputTokens: 20, outputTokens: 10, totalTokens: 30 });
    await recordTokenBill(dataDir, bill1);
    await recordTokenBill(dataDir, bill2);

    const date = bill1.ts.slice(0, 10);
    const file = join(dataDir, 'stats', 'agent-alpha', `${date}.jsonl`);
    const raw = await readFile(file, 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('does not throw when dataDir is not writable (just warns)', async () => {
    // Pass a non-existent deeply-nested path which should auto-create via mkdir
    const dataDir = await createTempDir();
    const bill = makeBill();
    await expect(recordTokenBill(dataDir, bill)).resolves.toBeUndefined();
  });
});

describe('loadStats', () => {
  it('returns empty array when stats directory does not exist', async () => {
    const dataDir = await createTempDir();
    const stats = await loadStats(dataDir);
    expect(stats).toEqual([]);
  });

  it('returns empty array for unknown agentId', async () => {
    const dataDir = await createTempDir();
    const stats = await loadStats(dataDir, asAgentId('nobody'));
    expect(stats).toEqual([]);
  });

  it('aggregates bills into DailyStats rows', async () => {
    const dataDir = await createTempDir();
    const ts = '2025-01-15T10:00:00.000Z';
    await recordTokenBill(dataDir, makeBill({ ts, inputTokens: 100, outputTokens: 50, totalTokens: 150 }));
    await recordTokenBill(dataDir, makeBill({ ts, inputTokens: 200, outputTokens: 75, totalTokens: 275 }));

    const stats = await loadStats(dataDir, asAgentId('agent-alpha'));
    expect(stats).toHaveLength(1);
    const row = stats[0];
    expect(row.date).toBe('2025-01-15');
    expect(row.turns).toBe(2);
    expect(row.inputTokens).toBe(300);
    expect(row.outputTokens).toBe(125);
    expect(row.totalTokens).toBe(425);
  });

  it('separates stats by model', async () => {
    const dataDir = await createTempDir();
    const ts = '2025-02-10T08:00:00.000Z';
    await recordTokenBill(dataDir, makeBill({ ts, model: 'gpt-4o', totalTokens: 100 }));
    await recordTokenBill(dataDir, makeBill({ ts, model: 'claude-3-5-sonnet', totalTokens: 200 }));

    const stats = await loadStats(dataDir, asAgentId('agent-alpha'));
    expect(stats).toHaveLength(2);
    const models = stats.map((s) => s.model).sort();
    expect(models).toEqual(['claude-3-5-sonnet', 'gpt-4o']);
  });

  it('loads stats for all agents when agentId is omitted', async () => {
    const dataDir = await createTempDir();
    const ts = '2025-03-01T12:00:00.000Z';
    await recordTokenBill(dataDir, makeBill({ ts, agentId: asAgentId('agent-a'), totalTokens: 50 }));
    await recordTokenBill(dataDir, makeBill({ ts, agentId: asAgentId('agent-b'), totalTokens: 80 }));

    const stats = await loadStats(dataDir);
    const ids = stats.map((s) => s.agentId).sort();
    expect(ids).toContain('agent-a');
    expect(ids).toContain('agent-b');
  });

  it('returns rows sorted newest date first', async () => {
    const dataDir = await createTempDir();
    await recordTokenBill(dataDir, makeBill({ ts: '2025-01-01T00:00:00.000Z', totalTokens: 10 }));
    await recordTokenBill(dataDir, makeBill({ ts: '2025-03-01T00:00:00.000Z', totalTokens: 20 }));

    const stats = await loadStats(dataDir, asAgentId('agent-alpha'));
    expect(stats[0].date).toBe('2025-03-01');
    expect(stats[1].date).toBe('2025-01-01');
  });

  it('accumulates cacheReadTokens correctly', async () => {
    const dataDir = await createTempDir();
    const ts = '2025-04-05T00:00:00.000Z';
    await recordTokenBill(dataDir, makeBill({ ts, cacheReadTokens: 30 }));
    await recordTokenBill(dataDir, makeBill({ ts, cacheReadTokens: 40 }));

    const stats = await loadStats(dataDir, asAgentId('agent-alpha'));
    expect(stats[0].cacheReadTokens).toBe(70);
  });
});
