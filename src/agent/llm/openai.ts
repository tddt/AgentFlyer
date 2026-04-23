import OpenAI from 'openai';
import { createLogger } from '../../core/logger.js';
import type { Message, MessageContent, StreamChunk, ToolDefinition } from '../../core/types.js';
import type { LLMProvider, RunParams } from './provider.js';

const logger = createLogger('llm:openai');

/** Models that route to OpenAI (or compatible) endpoint. */
const OPENAI_PREFIXES = ['gpt-', 'o1', 'o3', 'o4', 'text-davinci'];
/** Models that route through OpenAI-compat API (Gemini, Ollama, etc.) */
const COMPAT_PREFIXES = ['gemini-', 'llama', 'mistral', 'mixtral', 'qwen'];

function toOpenAIMessages(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
  // RATIONALE: Use flatMap so a single user message with N tool_result parts
  // expands into N separate OpenAI `tool` messages. OpenAI requires one `tool`
  // message per tool_call_id; sending only the first result causes 400 errors
  // when the assistant invoked multiple tools in one turn.
  return messages.flatMap((m): OpenAI.ChatCompletionMessageParam | OpenAI.ChatCompletionMessageParam[] => {
    if (m.role === 'system') {
      return {
        role: 'system',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      };
    }
    if (typeof m.content === 'string') {
      return { role: m.role as 'user' | 'assistant', content: m.content };
    }
    const parts = m.content as MessageContent[];
    if (m.role === 'user') {
      // Expand each tool_result into its own OpenAI `tool` message.
      const toolResults = parts.filter((p) => p.type === 'tool_result') as {
        type: 'tool_result';
        tool_use_id: string;
        content: unknown;
      }[];
      if (toolResults.length > 0) {
        return toolResults.map((tr): OpenAI.ChatCompletionToolMessageParam => ({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content:
            typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
        }));
      }
      const textParts = parts.filter((p) => p.type === 'text');
      return {
        role: 'user',
        content: textParts.map((p) => (p as { text: string }).text).join('\n'),
      };
    }
    if (m.role === 'assistant') {
      const textParts = parts.filter((p) => p.type === 'text');
      const toolUseParts = parts.filter((p) => p.type === 'tool_use');
      const result: OpenAI.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: textParts.map((p) => (p as { text: string }).text).join('\n') || null,
        tool_calls:
          toolUseParts.length > 0
            ? toolUseParts.map((p) => ({
                id: (p as { id: string }).id,
                type: 'function' as const,
                function: {
                  name: (p as { name: string }).name,
                  arguments: JSON.stringify((p as { input: unknown }).input),
                },
              }))
            : undefined,
      };
      return result;
    }
    return { role: 'user', content: JSON.stringify(m.content) };
  });
}

function toOpenAITools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

export class OpenAIProvider implements LLMProvider {
  readonly id: string;
  private client: OpenAI;

  constructor(options?: { apiKey?: string; baseURL?: string; providerId?: string }) {
    this.id = options?.providerId ?? 'openai';
    // Use a placeholder key to defer validation until actual API call.
    // The real key is resolved from env when needed.
    this.client = new OpenAI({
      apiKey: options?.apiKey ?? process.env.OPENAI_API_KEY ?? 'not-set',
      baseURL: options?.baseURL,
    });
  }

  supports(model: string): boolean {
    const m = model.toLowerCase();
    return (
      OPENAI_PREFIXES.some((p) => m.startsWith(p)) || COMPAT_PREFIXES.some((p) => m.startsWith(p))
    );
  }

  async *run(params: RunParams): AsyncIterable<StreamChunk> {
    const { model, systemPrompt, messages, tools, maxTokens, temperature } = params;
    logger.debug('Starting OpenAI stream', { model, messageCount: messages.length });

    const allMessages: OpenAI.ChatCompletionMessageParam[] = [];
    if (systemPrompt) {
      allMessages.push({ role: 'system', content: systemPrompt });
    }
    allMessages.push(...toOpenAIMessages(messages));

    const openAITools = toOpenAITools(tools);

    try {
      const stream = await this.client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages: allMessages,
        tools: openAITools.length ? openAITools : undefined,
        temperature,
        stream: true,
        stream_options: { include_usage: true },
      });

      const toolCallAccumulator: Map<number, { id: string; name: string; argsJson: string }> =
        new Map();

      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason = 'end_turn';

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta;

        if (delta.content) {
          yield { type: 'text_delta', text: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            const existing = toolCallAccumulator.get(idx) ?? {
              id: tc.id ?? '',
              name: tc.function?.name ?? '',
              argsJson: '',
            };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) existing.argsJson += tc.function.arguments;
            toolCallAccumulator.set(idx, existing);
            // Emit delta
            yield {
              type: 'tool_use_delta',
              id: existing.id,
              name: existing.name,
              inputJson: tc.function?.arguments ?? '',
            };
          }
        }

        if (choice.finish_reason) {
          stopReason =
            choice.finish_reason === 'tool_calls'
              ? 'tool_use'
              : choice.finish_reason === 'length'
                ? 'max_tokens'
                : 'end_turn';
        }

        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens;
          outputTokens = chunk.usage.completion_tokens;
        }
      }

      // RATIONALE: Partial deltas were already emitted during streaming above.
      // The runner accumulates them with +=, so re-emitting the full argsJson here
      // would cause the JSON to be duplicated and fail to parse. No re-emit needed.

      yield {
        type: 'done',
        inputTokens,
        outputTokens,
        stopReason: stopReason as 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence',
      };
    } catch (err) {
      logger.error('OpenAI stream error', { error: String(err) });
      yield { type: 'error', message: String(err) };
    }
  }

  async countTokens(messages: Message[], _model: string): Promise<number> {
    // Approximate: 4 chars per token
    const totalChars = messages.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : (JSON.stringify(m.content) ?? '');
      return sum + content.length;
    }, 0);
    return Math.ceil(totalChars / 4);
  }
}

/** Create an OpenAI-compatible provider for Ollama/Gemini/etc. */
export function createCompatProvider(options: {
  baseURL: string;
  apiKey?: string;
  providerId: string;
  modelPrefixes: string[];
}): LLMProvider {
  const base = new OpenAIProvider({
    apiKey: options.apiKey ?? 'unused',
    baseURL: options.baseURL,
    providerId: options.providerId,
  });
  // Override supports() to use custom prefixes
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'supports') {
        return (model: string) =>
          options.modelPrefixes.some((p) => model.toLowerCase().startsWith(p));
      }
      return (target as unknown as Record<string | symbol, unknown>)[prop];
    },
  });
}
