import { estimateTokens } from '../compactor/token-count.js';
import type { PromptLayer } from './layers.js';

export interface BuiltPrompt {
  systemPrompt: string;
  estimatedTokens: number;
  layers: PromptLayer[];
}

const LAYER_SEPARATOR = '\n\n---\n\n';

/**
 * Assemble all layers into a single system prompt string.
 * Trimmable layers are dropped (tallest id first) if the prompt would
 * exceed `maxSystemTokens`.
 */
export function buildSystemPrompt(
  layers: PromptLayer[],
  maxSystemTokens = 8_000,
): BuiltPrompt {
  // Tag each layer with its token estimate
  const tagged = layers
    .filter((l) => l.content.trim().length > 0)
    .map((l) => ({ ...l, estimatedTokens: estimateTokens(l.content) }));

  let total = tagged.reduce((s, l) => s + l.estimatedTokens, 0);

  // Drop trimmable layers (highest id first) until we fit
  const active = [...tagged];
  for (let i = active.length - 1; i >= 0 && total > maxSystemTokens; i--) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const layer = active[i]!;
    if (layer.trimable) {
      total -= layer.estimatedTokens;
      active.splice(i, 1);
    }
  }

  const systemPrompt = active
    .sort((a, b) => a.id - b.id)
    .map((l) => l.content.trim())
    .join(LAYER_SEPARATOR);

  return { systemPrompt, estimatedTokens: total, layers: active };
}
