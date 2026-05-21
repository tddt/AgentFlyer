import OpenAI from 'openai';
import { createLogger } from '../../core/logger.js';
import type { Message, MessageContent, StreamChunk, ToolDefinition } from '../../core/types.js';
import type { LLMProvider, RunParams } from './provider.js';

const logger = createLogger('llm:openai');

/** Models that route to OpenAI (or compatible) endpoint. */
const OPENAI_PREFIXES = ['gpt-', 'o1', 'o3', 'o4', 'text-davinci'];
/** Models that route through OpenAI-compat API (Gemini, Ollama, etc.) */
const COMPAT_PREFIXES = ['gemini-', 'llama', 'mistral', 'mixtral', 'qwen'];

function buildLlmErrorLogContext(error: unknown): Record<string, unknown> {
  const context: Record<string, unknown> = {
    error: error instanceof Error ? error.message : String(error),
  };

  if (!error || typeof error !== 'object') {
    return context;
  }

  const record = error as Record<string, unknown>;
  if (error instanceof Error && error.name && error.name !== 'Error') {
    context.errorName = error.name;
  }
  if (typeof record.status === 'number') {
    context.status = record.status;
  }
  if (typeof record.code === 'string') {
    context.code = record.code;
  }
  if (typeof record.type === 'string') {
    context.type = record.type;
  }
  if (typeof record.param === 'string') {
    context.param = record.param;
  }
  if (typeof record.message === 'string' && record.message !== context.error) {
    context.rawMessage = record.message;
  }

  const nestedError = record.error;
  if (nestedError && typeof nestedError === 'object') {
    const nestedRecord = nestedError as Record<string, unknown>;
    if (typeof nestedRecord.message === 'string') {
      context.upstreamMessage = nestedRecord.message;
    }
    if (typeof nestedRecord.type === 'string') {
      context.upstreamType = nestedRecord.type;
    }
    if (typeof nestedRecord.code === 'string') {
      context.upstreamCode = nestedRecord.code;
    }
    if (typeof nestedRecord.param === 'string') {
      context.upstreamParam = nestedRecord.param;
    }
  }

  const cause = record.cause;
  if (cause) {
    context.cause = cause instanceof Error ? cause.message : String(cause);
  }

  return context;
}

function isGeminiModel(model: string): boolean {
  return model.toLowerCase().startsWith('gemini-');
}

function mapFinishReason(
  finishReason: string | null | undefined,
): 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' {
  return finishReason === 'tool_calls'
    ? 'tool_use'
    : finishReason === 'length'
      ? 'max_tokens'
      : 'end_turn';
}

function extractThoughtSignature(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const direct = record.thought_signature;
  if (typeof direct === 'string' && direct) {
    return direct;
  }

  const camel = record.thoughtSignature;
  if (typeof camel === 'string' && camel) {
    return camel;
  }

  const fn = record.function;
  if (fn && typeof fn === 'object') {
    const functionRecord = fn as Record<string, unknown>;
    const nestedSnake = functionRecord.thought_signature;
    if (typeof nestedSnake === 'string' && nestedSnake) {
      return nestedSnake;
    }
    const nestedCamel = functionRecord.thoughtSignature;
    if (typeof nestedCamel === 'string' && nestedCamel) {
      return nestedCamel;
    }
  }

  return undefined;
}

function stringifyToolResultContent(content: string | MessageContent[]): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .map((part) => {
      if (part.type === 'text') {
        return part.text;
      }
      return JSON.stringify(part);
    })
    .join('\n');
}

function flattenGeminiToolHistory(messages: Message[]): { messages: Message[]; flattenedTurns: number } {
  const flattened: Message[] = [];
  let flattenedTurns = 0;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message) {
      continue;
    }

    if (message.role !== 'assistant' || typeof message.content === 'string') {
      flattened.push(message);
      continue;
    }

    const assistantParts = message.content as MessageContent[];
    const toolUseParts = assistantParts.filter((part) => part.type === 'tool_use') as Array<{
      id: string;
      name: string;
      input: unknown;
    }>;
    if (toolUseParts.length === 0) {
      flattened.push(message);
      continue;
    }

    const nextMessage = messages[index + 1];
    if (
      !nextMessage ||
      nextMessage.role !== 'user' ||
      typeof nextMessage.content === 'string'
    ) {
      flattened.push(message);
      continue;
    }

    const toolResults = (nextMessage.content as MessageContent[]).filter(
      (part) => part.type === 'tool_result',
    ) as Array<{
      tool_use_id: string;
      content: string | MessageContent[];
      is_error?: boolean;
    }>;
    if (toolResults.length === 0) {
      flattened.push(message);
      continue;
    }

    flattenedTurns += 1;
    const assistantText = assistantParts
      .filter((part) => part.type === 'text')
      .map((part) => (part as { text: string }).text)
      .join('\n')
      .trim();
    if (assistantText) {
      flattened.push({
        role: 'assistant',
        content: assistantText,
        ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
      });
    }

    const toolResultMap = new Map(toolResults.map((result) => [result.tool_use_id, result]));
    const summary = toolUseParts
      .map((toolUse) => {
        const toolResult = toolResultMap.get(toolUse.id);
        const lines = [
          `Tool: ${toolUse.name}`,
          `Input: ${JSON.stringify(toolUse.input)}`,
          `Result:\n${toolResult ? stringifyToolResultContent(toolResult.content) : '[missing result]'}`,
        ];
        if (toolResult?.is_error) {
          lines.push('Error: true');
        }
        return lines.join('\n');
      })
      .join('\n\n');

    flattened.push({
      role: 'user',
      content: `Tool execution results:\n${summary}`,
    });
    index += 1;
  }

  return { messages: flattened, flattenedTurns };
}

export function serializeOpenAIMessages(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
  // RATIONALE: Use flatMap so a single user message with N tool_result parts
  // expands into N separate OpenAI `tool` messages. OpenAI requires one `tool`
  // message per tool_call_id; sending only the first result causes 400 errors
  // when the assistant invoked multiple tools in one turn.
  return messages.flatMap(
    (m): OpenAI.ChatCompletionMessageParam | OpenAI.ChatCompletionMessageParam[] => {
      if (m.role === 'system') {
        return {
          role: 'system',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        };
      }
      if (typeof m.content === 'string') {
        if (m.role === 'assistant' && m.reasoning_content) {
          return {
            role: 'assistant',
            content: m.content,
            reasoning_content: m.reasoning_content,
          } as OpenAI.ChatCompletionAssistantMessageParam & { reasoning_content: string };
        }
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
          return toolResults.map(
            (tr): OpenAI.ChatCompletionToolMessageParam => ({
              role: 'tool',
              tool_call_id: tr.tool_use_id,
              content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
            }),
          );
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
        const result: OpenAI.ChatCompletionAssistantMessageParam & { reasoning_content?: string } =
          {
            role: 'assistant',
            content: textParts.map((p) => (p as { text: string }).text).join('\n') || null,
            tool_calls:
              toolUseParts.length > 0
                ? toolUseParts.map((p) => {
                    const toolUse = p as {
                      id: string;
                      name: string;
                      input: unknown;
                      thoughtSignature?: string;
                    };
                    return {
                      id: toolUse.id,
                      type: 'function' as const,
                      function: {
                        name: toolUse.name,
                        arguments: JSON.stringify(toolUse.input),
                        ...(toolUse.thoughtSignature
                          ? { thought_signature: toolUse.thoughtSignature }
                          : {}),
                      },
                      ...(toolUse.thoughtSignature
                        ? { thought_signature: toolUse.thoughtSignature }
                        : {}),
                    };
                  })
                : undefined,
          };
        if (m.reasoning_content) {
          result.reasoning_content = m.reasoning_content;
        }
        return result;
      }
      return { role: 'user', content: JSON.stringify(m.content) };
    },
  );
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
  private readonly baseURL?: string;

  constructor(options?: { apiKey?: string; baseURL?: string; providerId?: string }) {
    this.id = options?.providerId ?? 'openai';
    this.baseURL = options?.baseURL;
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

    const preparedMessages = isGeminiModel(model)
      ? flattenGeminiToolHistory(messages)
      : { messages, flattenedTurns: 0 };
    if (preparedMessages.flattenedTurns > 0) {
      logger.debug('Flattened Gemini tool-call history for follow-up turn', {
        model,
        flattenedTurns: preparedMessages.flattenedTurns,
      });
    }

    const allMessages: OpenAI.ChatCompletionMessageParam[] = [];
    if (systemPrompt) {
      allMessages.push({ role: 'system', content: systemPrompt });
    }
    allMessages.push(...serializeOpenAIMessages(preparedMessages.messages));

    if (model.toLowerCase().startsWith('gemini-')) {
      const assistantToolCalls = allMessages.flatMap((message, messageIndex) => {
        if (message.role !== 'assistant') {
          return [];
        }

        const toolCalls = (message as { tool_calls?: Array<Record<string, unknown>> }).tool_calls;
        return (toolCalls ?? []).map((toolCall, toolIndex) => ({
          messageIndex,
          toolIndex,
          id: typeof toolCall.id === 'string' ? toolCall.id : '',
          name:
            typeof (toolCall.function as Record<string, unknown> | undefined)?.name === 'string'
              ? ((toolCall.function as Record<string, unknown>).name as string)
              : '',
          hasThoughtSignature: Boolean(
            extractThoughtSignature(toolCall) ??
              extractThoughtSignature((toolCall as { function?: unknown }).function),
          ),
        }));
      });

      if (assistantToolCalls.length > 0) {
        logger.debug('Prepared Gemini assistant tool-call history', {
          model,
          assistantToolCalls,
        });
      }
    }

    const openAITools = toOpenAITools(tools);

    if (isGeminiModel(model) && openAITools.length > 0) {
      logger.debug('Using non-stream Gemini tool-call fallback', {
        model,
        messageCount: allMessages.length,
        toolCount: openAITools.length,
      });

      try {
        const response = await this.client.chat.completions.create({
          model,
          max_tokens: maxTokens,
          messages: allMessages,
          tools: openAITools,
          temperature,
        });

        const choice = response.choices[0];
        const message = choice?.message as
          | {
              content?: string | null;
              reasoning_content?: string;
              tool_calls?: Array<Record<string, unknown>>;
            }
          | undefined;

        if (typeof message?.reasoning_content === 'string' && message.reasoning_content) {
          yield { type: 'thinking_delta', thinking: message.reasoning_content };
        }

        if (typeof message?.content === 'string' && message.content) {
          yield { type: 'text_delta', text: message.content };
        }

        const responseToolCalls = message?.tool_calls ?? [];
        if (responseToolCalls.length > 0) {
          logger.debug('Captured Gemini tool calls from non-stream response', {
            model,
            toolCalls: responseToolCalls.map((toolCall) => ({
              id: typeof toolCall.id === 'string' ? toolCall.id : '',
              name:
                typeof (toolCall.function as Record<string, unknown> | undefined)?.name === 'string'
                  ? ((toolCall.function as Record<string, unknown>).name as string)
                  : '',
              hasThoughtSignature: Boolean(
                extractThoughtSignature(toolCall) ??
                  extractThoughtSignature((toolCall as { function?: unknown }).function),
              ),
            })),
          });
        }

        for (const toolCall of responseToolCalls) {
          const functionRecord = (toolCall.function as Record<string, unknown> | undefined) ?? {};
          yield {
            type: 'tool_use_delta',
            id: typeof toolCall.id === 'string' ? toolCall.id : '',
            name: typeof functionRecord.name === 'string' ? (functionRecord.name as string) : '',
            inputJson:
              typeof functionRecord.arguments === 'string'
                ? (functionRecord.arguments as string)
                : '',
            thoughtSignature:
              extractThoughtSignature(toolCall) ?? extractThoughtSignature(functionRecord),
          };
        }

        yield {
          type: 'done',
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
          stopReason: mapFinishReason(choice?.finish_reason),
        };
        return;
      } catch (err) {
        logger.error('OpenAI non-stream Gemini tool-call fallback error', {
          providerId: this.id,
          baseURL: this.baseURL ?? 'default',
          model,
          messageCount: allMessages.length,
          toolCount: openAITools.length,
          ...buildLlmErrorLogContext(err),
        });
        yield { type: 'error', message: String(err) };
        return;
      }
    }

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

      const toolCallAccumulator: Map<
        number,
        { id: string; name: string; argsJson: string; thoughtSignature?: string }
      > = new Map();

      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason = 'end_turn';

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta;

        // Capture reasoning_content for thinking-mode models (e.g. DeepSeek).
        // The API requires it to be passed back verbatim on the next turn.
        const reasoningDelta = (delta as Record<string, unknown>).reasoning_content;
        if (typeof reasoningDelta === 'string' && reasoningDelta) {
          yield { type: 'thinking_delta', thinking: reasoningDelta };
        }

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
              thoughtSignature: undefined,
            };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) existing.argsJson += tc.function.arguments;
            const thoughtSignature = extractThoughtSignature(tc);
            if (thoughtSignature) {
              existing.thoughtSignature = thoughtSignature;
            }
            toolCallAccumulator.set(idx, existing);
            // Emit delta
            yield {
              type: 'tool_use_delta',
              id: existing.id,
              name: existing.name,
              inputJson: tc.function?.arguments ?? '',
              thoughtSignature: existing.thoughtSignature,
            };
          }
        }

        if (choice.finish_reason) {
          stopReason = mapFinishReason(choice.finish_reason);
        }

        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens;
          outputTokens = chunk.usage.completion_tokens;
        }
      }

      if (model.toLowerCase().startsWith('gemini-') && toolCallAccumulator.size > 0) {
        logger.debug('Captured Gemini streamed tool calls', {
          model,
          toolCalls: Array.from(toolCallAccumulator.values()).map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.name,
            hasThoughtSignature: Boolean(toolCall.thoughtSignature),
          })),
        });
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
      logger.error('OpenAI stream error', {
        providerId: this.id,
        baseURL: this.baseURL ?? 'default',
        model,
        messageCount: allMessages.length,
        toolCount: openAITools.length,
        ...buildLlmErrorLogContext(err),
      });
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
  const normalizedPrefixes = options.modelPrefixes.map((prefix) => prefix.toLowerCase());
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
          normalizedPrefixes.some((prefix) => model.toLowerCase().startsWith(prefix));
      }
      return (target as unknown as Record<string | symbol, unknown>)[prop];
    },
  });
}
