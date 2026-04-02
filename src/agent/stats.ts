/**
 * TokenBill — per-turn token usage tracking (E7.1).
 *
 * Each completed LLM turn writes one JSON line to
 *   ~/.agentflyer/stats/<agentId>/<YYYY-MM-DD>.jsonl
 *
 * The stats CLI command aggregates these files for display.
 */

import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../core/logger.js';
import { asAgentId, type AgentId } from '../core/types.js';

const logger = createLogger('agent:stats');

export interface TokenBill {
  /** ISO-8601 timestamp of the turn completion. */
  ts: string;
  agentId: AgentId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Cache-read tokens (Anthropic prompt cache), if reported by provider. */
  cacheReadTokens: number;
  /** Total tokens (input + output) for quick aggregation. */
  totalTokens: number;
}

export interface DailyStats {
  date: string;
  agentId: AgentId;
  model: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Append one TokenBill record to the per-agent daily JSONL stats file.
 * Failures are logged but never rethrown — stats must never break a turn.
 */
export async function recordTokenBill(dataDir: string, bill: TokenBill): Promise<void> {
  try {
    const dir = join(dataDir, 'stats', bill.agentId);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${todayStr()}.jsonl`);
    await appendFile(file, `${JSON.stringify(bill)}\n`, 'utf-8');
  } catch (err) {
    logger.warn('Failed to record token bill', { agentId: bill.agentId, error: String(err) });
  }
}

/** Read all JSONL stat entries for the given agent, from newest to oldest date. */
async function readAgentBills(
  dataDir: string,
  agentId: AgentId,
  limitDays = 30,
): Promise<TokenBill[]> {
  const dir = join(dataDir, 'stats', agentId);
  let files: string[];
  try {
    files = (await readdir(dir))
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
  const bills: TokenBill[] = [];
  for (const f of files.slice(0, limitDays)) {
    try {
      const raw = await readFile(join(dir, f), 'utf-8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          bills.push(JSON.parse(line) as TokenBill);
        } catch {
          /* skip malformed lines */
        }
      }
    } catch {
      /* skip unreadable files */
    }
  }
  return bills;
}

/** Aggregate TokenBill records into per-day-agent-model rows for display. */
function aggregate(bills: TokenBill[]): DailyStats[] {
  const map = new Map<string, DailyStats>();
  for (const b of bills) {
    const date = b.ts.slice(0, 10);
    const key = `${date}|${b.agentId}|${b.model}`;
    const existing = map.get(key);
    if (existing) {
      existing.turns += 1;
      existing.inputTokens += b.inputTokens;
      existing.outputTokens += b.outputTokens;
      existing.cacheReadTokens += b.cacheReadTokens;
      existing.totalTokens += b.totalTokens;
    } else {
      map.set(key, {
        date,
        agentId: b.agentId,
        model: b.model,
        turns: 1,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        cacheReadTokens: b.cacheReadTokens,
        totalTokens: b.totalTokens,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date));
}

/** Load and aggregate token usage stats. Pass agentId to scope to one agent. */
export async function loadStats(
  dataDir: string,
  agentId?: AgentId,
  limitDays = 30,
): Promise<DailyStats[]> {
  let agentIds: AgentId[];
  if (agentId) {
    agentIds = [agentId];
  } else {
    // List all per-agent stat dirs
    try {
      const statsDir = join(dataDir, 'stats');
      agentIds = (await readdir(statsDir))
        .map((entry) => {
          try {
            return asAgentId(entry);
          } catch {
            return null;
          }
        })
        .filter((entry): entry is AgentId => entry !== null);
    } catch {
      return [];
    }
  }
  const allBills: TokenBill[] = [];
  for (const id of agentIds) {
    const bills = await readAgentBills(dataDir, id, limitDays);
    allBills.push(...bills);
  }
  return aggregate(allBills);
}
