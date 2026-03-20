import type { Message } from '../../core/types.js';
import {
  estimateMessagesTokens,
  contextWindowFor,
} from './token-count.js';
import {
  buildCompactionPrompt,
  parseSummaryJson,
  summaryToMessage,
  splitForCompaction,
  type CompactionResult,
} from './structured.js';
import { createLogger } from '../../core/logger.js';

export * from './token-count.js';
export * from './structured.js';

const logger = createLogger('compactor');

/** Number of recent messages to always keep after compaction. */
const KEEP_RECENT = 20;

export interface CompactorOptions {
  model: string;
  maxTokens?: number;
  /** Fill fraction at which compaction is triggered (0.0–1.0). Defaults to 0.75. */
  threshold?: number;
}

export interface CompactionTrigger {
  shouldCompact: boolean;
  usedTokens: number;
  contextWindow: number;
  fillFraction: number;
}

/** Check whether the current conversation needs compaction. */
export function checkCompactionNeeded(
  messages: Message[],
  opts: CompactorOptions,
): CompactionTrigger {
  const contextWindow = opts.maxTokens ?? contextWindowFor(opts.model);
  const usedTokens = estimateMessagesTokens(messages);
  const fillFraction = usedTokens / contextWindow;
  const shouldCompact = fillFraction >= (opts.threshold ?? 0.75);
  if (shouldCompact) {
    logger.info('Compaction threshold reached', {
      usedTokens,
      contextWindow,
      fillFraction: fillFraction.toFixed(2),
    });
  }
  return { shouldCompact, usedTokens, contextWindow, fillFraction };
}

/**
 * Run compaction using an LLM call.
 * The caller must provide a `callLLM` function that accepts a prompt string
 * and returns the raw LLM response text (non-streaming, single turn).
 */
export async function runCompaction(
  messages: Message[],
  callLLM: (prompt: string) => Promise<string>,
): Promise<CompactionResult> {
  const { toCompact, toKeep } = splitForCompaction(messages, KEEP_RECENT);

  if (toCompact.length === 0) {
    return { summaryMessage: summaryToMessage({
      from: new Date().toISOString(),
      to: new Date().toISOString(),
      messageCount: 0,
      narrative: '',
      facts: [],
      pendingWork: [],
    }), keptMessages: toKeep, compactedCount: 0 };
  }

  const prompt = buildCompactionPrompt(toCompact);
  logger.info('Running LLM compaction', { messagesToCompact: toCompact.length });

  let raw: string;
  try {
    raw = await callLLM(prompt);
  } catch (err) {
    logger.error('Compaction LLM call failed', { error: String(err) });
    // Emergency: just drop old messages, no summary
    return {
      summaryMessage: {
        role: 'user',
        content: '[Prior conversation history truncated due to context length]',
      },
      keptMessages: toKeep,
      compactedCount: toCompact.length,
    };
  }

  const summary = parseSummaryJson(raw);
  summary.messageCount = toCompact.length;

  return {
    summaryMessage: summaryToMessage(summary),
    keptMessages: toKeep,
    compactedCount: toCompact.length,
  };
}
