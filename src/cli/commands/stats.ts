import chalk from 'chalk';
import { defineCommand } from 'citty';
import type { DailyStats } from '../../agent/stats.js';
import { loadStats } from '../../agent/stats.js';
import { getDefaultConfigDir } from '../../core/config/loader.js';
import { asAgentId } from '../../core/types.js';

function padEnd(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

function fmtNum(n: number): string {
  return n.toLocaleString();
}

function printTable(rows: DailyStats[]): void {
  const COL = {
    date: 10,
    agent: 24,
    model: 28,
    turns: 6,
    input: 10,
    output: 10,
    cache: 10,
    total: 12,
  };
  const header = [
    padEnd('Date', COL.date),
    padEnd('Agent', COL.agent),
    padEnd('Model', COL.model),
    padEnd('Turns', COL.turns),
    padEnd('Input', COL.input),
    padEnd('Output', COL.output),
    padEnd('Cached', COL.cache),
    padEnd('Total', COL.total),
  ].join('  ');

  const sep = '-'.repeat(header.length);
  process.stdout.write(chalk.bold(`\n${header}\n`));
  process.stdout.write(chalk.gray(`${sep}\n`));

  for (const row of rows) {
    const line = [
      padEnd(row.date, COL.date),
      padEnd(row.agentId, COL.agent),
      padEnd(row.model, COL.model),
      padEnd(String(row.turns), COL.turns),
      padEnd(fmtNum(row.inputTokens), COL.input),
      padEnd(fmtNum(row.outputTokens), COL.output),
      padEnd(fmtNum(row.cacheReadTokens), COL.cache),
      padEnd(fmtNum(row.totalTokens), COL.total),
    ].join('  ');
    process.stdout.write(`${line}\n`);
  }

  // Totals row
  const totals = rows.reduce(
    (acc, r) => ({
      turns: acc.turns + r.turns,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
      totalTokens: acc.totalTokens + r.totalTokens,
    }),
    { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 },
  );

  process.stdout.write(chalk.gray(`${sep}\n`));
  const totLine = [
    padEnd('TOTAL', COL.date),
    padEnd('', COL.agent),
    padEnd('', COL.model),
    padEnd(String(totals.turns), COL.turns),
    padEnd(fmtNum(totals.inputTokens), COL.input),
    padEnd(fmtNum(totals.outputTokens), COL.output),
    padEnd(fmtNum(totals.cacheReadTokens), COL.cache),
    chalk.bold(padEnd(fmtNum(totals.totalTokens), COL.total)),
  ].join('  ');
  process.stdout.write(`${totLine}\n\n`);
}

export const statsCommand = defineCommand({
  meta: {
    name: 'stats',
    description: 'Show token usage statistics per agent / model / day',
  },
  args: {
    agent: {
      type: 'string',
      alias: 'a',
      description: 'Filter by agent ID',
    },
    days: {
      type: 'string',
      alias: 'd',
      description: 'How many past days to show (default 30)',
      default: '30',
    },
  },
  async run({ args }) {
    const dataDir = getDefaultConfigDir();
    const limitDays = Math.max(1, Number.parseInt(args.days as string, 10) || 30);
    const agentArg = args.agent as string | undefined;
    const agentId = agentArg?.trim() ? asAgentId(agentArg) : undefined;

    const rows = await loadStats(dataDir, agentId, limitDays);

    if (rows.length === 0) {
      process.stdout.write(
        `${
          chalk.yellow('\nNo token usage stats found') + (agentId ? ` for agent '${agentId}'` : '')
        }.\n${chalk.gray('Stats are recorded automatically once the gateway processes a turn.\n\n')}`,
      );
      process.exit(0);
    }

    printTable(rows);
    process.exit(0);
  },
});
