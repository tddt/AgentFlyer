import type { Message, StreamChunk, ToolDefinition } from '../../core/types.js';

export interface RunParams {
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxTokens: number;
  temperature?: number;
}

/**
 * Unified LLM provider interface.
 * All providers must implement this interface.
 */
export interface LLMProvider {
  /** Provider identifier, e.g. 'anthropic', 'openai' */
  readonly id: string;

  /** Stream a model completion. Yields chunks until the StreamDone event. */
  run(params: RunParams): AsyncIterable<StreamChunk>;

  /** Estimate token count for the given messages (may be approximate). */
  countTokens(messages: Message[], model: string): Promise<number>;

  /** True if this provider can handle the given model string. */
  supports(model: string): boolean;
}

export interface ProviderRegistry {
  register(provider: LLMProvider): void;
  forModel(model: string): LLMProvider;
  list(): LLMProvider[];
}

/** Default provider registry — build once per gateway instance. */
export function createProviderRegistry(): ProviderRegistry {
  const providers: LLMProvider[] = [];

  return {
    register(provider) {
      providers.push(provider);
    },
    forModel(model) {
      const p = providers.find((p) => p.supports(model));
      if (!p) throw new Error(`No LLM provider registered for model: ${model}`);
      return p;
    },
    list: () => [...providers],
  };
}
