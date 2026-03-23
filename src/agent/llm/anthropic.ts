import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../../core/logger.js';
import type { Message, MessageContent, StreamChunk, ToolDefinition } from '../../core/types.js';
import type { LLMProvider, RunParams } from './provider.js';

const logger = createLogger('llm:anthropic');

/** Models handled by this provider. */
const ANTHROPIC_PREFIXES = ['claude-'];

function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (typeof m.content === 'string') {
        return { role: m.role as 'user' | 'assistant', content: m.content };
      }
      // Array content – map our types to Anthropic's
      const content = (m.content as MessageContent[]).map((c) => {
        if (c.type === 'text') return { type: 'text' as const, text: c.text };
        if (c.type === 'tool_use') {
          return {
            type: 'tool_use' as const,
            id: c.id,
            name: c.name,
            input: c.input as Record<string, unknown>,
          };
        }
        if (c.type === 'tool_result') {
          const resultContent =
            typeof c.content === 'string'
              ? c.content
              : (c.content as Array<{ type: string; text: string }>).map((x) => ({
                  type: 'text' as const,
                  text: x.text,
                }));
          return {
            type: 'tool_result' as const,
            tool_use_id: c.tool_use_id,
            content: resultContent,
            is_error: c.is_error,
          };
        }
        throw new Error(`Unknown content type: ${(c as { type: string }).type}`);
      });
      return { role: m.role as 'user' | 'assistant', content };
    });
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY });
  }

  supports(model: string): boolean {
    return ANTHROPIC_PREFIXES.some((p) => model.toLowerCase().startsWith(p));
  }

  async *run(params: RunParams): AsyncIterable<StreamChunk> {
    const { model, systemPrompt, messages, tools, maxTokens, temperature } = params;
    logger.debug('Starting Anthropic stream', { model, messageCount: messages.length });

    const anthropicMessages = toAnthropicMessages(messages);
    const anthropicTools = toAnthropicTools(tools);

    const requestParams: Anthropic.MessageStreamParams = {
      model,
      max_tokens: maxTokens,
      system: systemPrompt || undefined,
      messages: anthropicMessages,
      tools: anthropicTools.length ? anthropicTools : undefined,
      temperature,
    };

    try {
      const stream = this.client.messages.stream(requestParams);
      let doneSent = false;

      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { type: 'text_delta', text: event.delta.text };
          } else if (event.delta.type === 'input_json_delta') {
            yield {
              type: 'tool_use_delta',
              id: '', // filled later via content_block_start
              name: '',
              inputJson: event.delta.partial_json,
            };
          }
        } else if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            yield {
              type: 'tool_use_delta',
              id: event.content_block.id,
              name: event.content_block.name,
              inputJson: '',
            };
          }
        } else if (event.type === 'message_delta' && event.delta.stop_reason) {
          const final = await stream.finalMessage();
          const usage = final.usage as {
            input_tokens: number;
            output_tokens: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          doneSent = true;
          yield {
            type: 'done',
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheReadTokens: usage.cache_read_input_tokens,
            cacheWriteTokens: usage.cache_creation_input_tokens,
            stopReason: (event.delta.stop_reason ?? 'end_turn') as
              | 'end_turn'
              | 'tool_use'
              | 'max_tokens'
              | 'stop_sequence',
          };
        }
      }

      if (!doneSent) {
        // Fallback: emit done from finalMessage
        const final = await stream.finalMessage();
        const usage = final.usage as {
          input_tokens: number;
          output_tokens: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
        yield {
          type: 'done',
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens,
          cacheWriteTokens: usage.cache_creation_input_tokens,
          stopReason: (final.stop_reason ?? 'end_turn') as
            | 'end_turn'
            | 'tool_use'
            | 'max_tokens'
            | 'stop_sequence',
        };
      }
    } catch (err) {
      logger.error('Anthropic stream error', { error: String(err) });
      yield { type: 'error', message: String(err) };
    }
  }

  async countTokens(messages: Message[], model: string): Promise<number> {
    try {
      const resp = await this.client.messages.countTokens({
        model,
        messages: toAnthropicMessages(messages),
      });
      return resp.input_tokens;
    } catch {
      // Fallback estimate: ~4 chars per token
      const totalChars = messages.reduce((sum, m) => {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return sum + content.length;
      }, 0);
      return Math.ceil(totalChars / 4);
    }
  }
}
