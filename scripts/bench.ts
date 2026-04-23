#!/usr/bin/env bun
/**
 * AgentFlyer performance benchmark
 *
 * Measures:
 *   1. Gateway cold-start time (process spawn → /ready returns 200)
 *   2. /health round-trip latency (100 iterations, p50/p95/p99)
 *   3. RPC throughput — concurrent agent.list calls (concurrency = 10)
 *
 * Usage:
 *   bun run scripts/bench.ts [--host http://127.0.0.1:19789] [--token <adminToken>]
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag: string, def: string) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? (args[i + 1] as string) : def;
};

const HOST = getArg('--host', 'http://127.0.0.1:19789');
const TOKEN = getArg('--token', process.env['AGENTFLYER_ADMIN_TOKEN'] ?? 'test-token');
const HEALTH_ITERS = Number(getArg('--health-iters', '100'));
const RPC_CONCURRENCY = Number(getArg('--rpc-concurrency', '10'));
const RPC_ITERS = Number(getArg('--rpc-iters', '50'));
const SPAWN_GATEWAY = args.includes('--spawn');

// ── Helpers ──────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function fmt(ms: number): string {
  return `${ms.toFixed(2)} ms`;
}

function hr() {
  process.stdout.write(`${'─'.repeat(60)}\n`);
}

// ── 1. Cold-start benchmark ──────────────────────────────────────────────────

async function benchColdStart(): Promise<void> {
  hr();
  process.stdout.write('Benchmark 1: Cold-start time\n');
  hr();

  const entrypoint = join(import.meta.dir, '..', 'src', 'cli', 'main.ts');
  if (!existsSync(entrypoint)) {
    process.stdout.write('  SKIP — entry point not found (run from repo root)\n\n');
    return;
  }

  const t0 = performance.now();
  const child = spawn('bun', ['run', entrypoint, 'start', '--no-open'], {
    stdio: 'ignore',
    detached: false,
  });

  let ready = false;
  const deadline = Date.now() + 15_000;
  while (!ready && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await fetch(`${HOST}/ready`, { signal: AbortSignal.timeout(500) });
      if (res.ok) ready = true;
    } catch {
      // not yet ready
    }
  }
  const elapsed = performance.now() - t0;
  child.kill();

  if (ready) {
    process.stdout.write(`  Cold-start to /ready: ${fmt(elapsed)}\n\n`);
  } else {
    process.stdout.write(`  Gateway did not become ready within 15 s.\n\n`);
  }
}

// ── 2. /health latency ───────────────────────────────────────────────────────

async function benchHealth(): Promise<void> {
  hr();
  process.stdout.write(`Benchmark 2: /health latency (${HEALTH_ITERS} sequential requests)\n`);
  hr();

  // Warm-up
  for (let i = 0; i < 3; i++) {
    await fetch(`${HOST}/health`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
  }

  const latencies: number[] = [];
  for (let i = 0; i < HEALTH_ITERS; i++) {
    const t0 = performance.now();
    const res = await fetch(`${HOST}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    const ms = performance.now() - t0;
    if (res?.ok) latencies.push(ms);
  }

  if (latencies.length === 0) {
    process.stdout.write(`  FAIL — gateway not reachable at ${HOST}\n\n`);
    return;
  }

  latencies.sort((a, b) => a - b);
  process.stdout.write(`  Requests:  ${latencies.length}/${HEALTH_ITERS} succeeded\n`);
  process.stdout.write(`  p50:       ${fmt(percentile(latencies, 50))}\n`);
  process.stdout.write(`  p95:       ${fmt(percentile(latencies, 95))}\n`);
  process.stdout.write(`  p99:       ${fmt(percentile(latencies, 99))}\n`);
  process.stdout.write(`  min:       ${fmt(latencies[0] ?? 0)}\n`);
  process.stdout.write(`  max:       ${fmt(latencies[latencies.length - 1] ?? 0)}\n\n`);
}

// ── 3. RPC throughput ────────────────────────────────────────────────────────

async function rpcCall(method: string, params: unknown = {}): Promise<{ ok: boolean; ms: number }> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${HOST}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    const ms = performance.now() - t0;
    return { ok: res.ok, ms };
  } catch {
    return { ok: false, ms: performance.now() - t0 };
  }
}

async function benchRpcThroughput(): Promise<void> {
  hr();
  process.stdout.write(
    `Benchmark 3: RPC throughput — agent.list (concurrency=${RPC_CONCURRENCY}, total=${RPC_ITERS * RPC_CONCURRENCY})\n`,
  );
  hr();

  // Warm-up
  await rpcCall('agent.list');

  const latencies: number[] = [];
  let failures = 0;
  const t0 = performance.now();

  for (let batch = 0; batch < RPC_ITERS; batch++) {
    const results = await Promise.all(
      Array.from({ length: RPC_CONCURRENCY }, () => rpcCall('agent.list')),
    );
    for (const r of results) {
      if (r.ok) latencies.push(r.ms);
      else failures++;
    }
  }

  const wallMs = performance.now() - t0;
  const total = RPC_ITERS * RPC_CONCURRENCY;
  const rps = (latencies.length / wallMs) * 1000;

  if (latencies.length === 0) {
    process.stdout.write(`  FAIL — all ${total} requests failed (check token and gateway)\n\n`);
    return;
  }

  latencies.sort((a, b) => a - b);
  process.stdout.write(`  Total requests: ${total}  |  failures: ${failures}\n`);
  process.stdout.write(`  Wall time:      ${fmt(wallMs)}\n`);
  process.stdout.write(`  Throughput:     ${rps.toFixed(0)} req/s\n`);
  process.stdout.write(`  p50:            ${fmt(percentile(latencies, 50))}\n`);
  process.stdout.write(`  p95:            ${fmt(percentile(latencies, 95))}\n`);
  process.stdout.write(`  p99:            ${fmt(percentile(latencies, 99))}\n\n`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

process.stdout.write(`\nAgentFlyer Gateway Benchmark\n`);
process.stdout.write(`  Host:  ${HOST}\n`);
process.stdout.write(`  Token: ${TOKEN.slice(0, 4)}${'*'.repeat(Math.max(0, TOKEN.length - 4))}\n\n`);

if (SPAWN_GATEWAY) {
  await benchColdStart();
}

await benchHealth();
await benchRpcThroughput();

hr();
process.stdout.write('Done.\n\n');
