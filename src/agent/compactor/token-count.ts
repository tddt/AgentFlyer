import { createLogger } from '../../core/logger.js';
import type { Message } from '../../core/types.js';

const logger = createLogger('compactor:token-count');

/**
 * Rough character-to-token ratio used when no precise counter is available.
 * OpenAI/Claude average: ~4 chars per token for English text.
 */
const CHARS_PER_TOKEN = 4;

/** Count tokens precisely using tiktoken (lazy-loaded). */
let tiktokenReady = false;
let tiktokenMod: {
  encoding_for_model: (m: string) => { encode: (t: string) => Uint32Array };
} | null = null;

async function getTiktoken(): Promise<typeof tiktokenMod> {
  if (tiktokenReady) return tiktokenMod;
  try {
    tiktokenMod = (await import('tiktoken')) as typeof tiktokenMod;
    tiktokenReady = true;
  } catch {
    // tiktoken optional - graceful degradation
    tiktokenReady = true;
  }
  return tiktokenMod;
}

/** Fast synchronous estimate (never touches I/O). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Estimate total tokens across all messages (fast, no I/O). */
export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return sum + estimateTokens(content) + 4; // per-message overhead
  }, 0);
}

/** Precise token count using tiktoken if available, otherwise falls back to estimate. */
export async function countTokensPrecise(text: string, model = 'gpt-4'): Promise<number> {
  const tk = await getTiktoken();
  if (!tk) return estimateTokens(text);
  try {
    const enc = tk.encoding_for_model(model as Parameters<typeof tk.encoding_for_model>[0]);
    return enc.encode(text).length;
  } catch {
    logger.debug('tiktoken failed for model, using estimate', { model });
    return estimateTokens(text);
  }
}

/** How many tokens remain in the context window. */
export function remainingTokens(used: number, contextWindow: number): number {
  return Math.max(0, contextWindow - used);
}

/** Common Anthropic context windows. */
export const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-5': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-3-5': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-haiku-20241022': 200_000,
  'claude-3-opus-20240229': 200_000,
  'gpt-4o': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'gpt-3.5-turbo': 16_385,
};

export function contextWindowFor(model: string): number {
  const exact = CONTEXT_WINDOWS[model];
  if (exact) return exact;
  if (model.startsWith('claude-')) return 200_000;
  if (model.startsWith('gpt-4o')) return 128_000;
  if (model.startsWith('gpt-4')) return 8_192;
  return 32_768; // conservative default
}
