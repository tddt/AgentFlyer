import { describe, expect, it } from 'vitest';
import type { StreamChunk } from '../../core/types.js';
import { createCompatProvider, OpenAIProvider, serializeOpenAIMessages } from './openai.js';

describe('serializeOpenAIMessages', () => {
  it('preserves Gemini thought signatures on assistant tool calls', () => {
    const messages = serializeOpenAIMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'bash',
            input: { command: 'pwd' },
            thoughtSignature: 'sig-123',
          },
        ],
      },
    ]);

    const assistantMessage = messages[0] as {
      tool_calls?: Array<Record<string, unknown>>;
    };
    const toolCall = assistantMessage.tool_calls?.[0];
    expect(toolCall?.thought_signature).toBe('sig-123');
    expect((toolCall?.function as Record<string, unknown> | undefined)?.thought_signature).toBe(
      'sig-123',
    );
  });

  it('preserves Gemini thought signatures when assistant text and tool calls share one message', () => {
    const messages = serializeOpenAIMessages([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '先检查磁盘。' },
          {
            type: 'tool_use',
            id: 'tool-2',
            name: 'default_api:bash',
            input: { command: 'wmic logicaldisk get size,freespace,caption' },
            thoughtSignature: 'sig-mixed-456',
          },
        ],
      },
    ]);

    const assistantMessage = messages[0] as {
      content?: string | null;
      tool_calls?: Array<Record<string, unknown>>;
    };

    expect(assistantMessage.content).toBe('先检查磁盘。');
    expect(assistantMessage.tool_calls?.[0]?.thought_signature).toBe('sig-mixed-456');
    expect(
      ((assistantMessage.tool_calls?.[0]?.function as Record<string, unknown> | undefined) ?? {})
        .thought_signature,
    ).toBe('sig-mixed-456');
  });
});

describe('OpenAIProvider', () => {
  it('matches compat model prefixes case-insensitively', () => {
    const provider = createCompatProvider({
      baseURL: 'https://example.invalid/v1',
      apiKey: 'test-key',
      providerId: 'openai-compat:n1n/MiniMax-M2.5',
      modelPrefixes: ['MiniMax-M2.5'],
    });

    expect(provider.supports('MiniMax-M2.5')).toBe(true);
    expect(provider.supports('minimax-m2.5')).toBe(true);
    expect(provider.supports('MiniMax-M2.5-thinking')).toBe(true);
  });

  it('captures Gemini thought signatures from streamed tool call deltas', async () => {
    const provider = new OpenAIProvider();
    const stream = async function* (): AsyncIterable<Record<string, unknown>> {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'tool-1',
                  type: 'function',
                  function: {
                    name: 'bash',
                    arguments: '{"command":"pwd"}',
                  },
                  thought_signature: 'sig-stream-1',
                },
              ],
            },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
        },
      };
    };

    (provider as unknown as {
      client: { chat: { completions: { create: () => AsyncIterable<Record<string, unknown>> } } };
    }).client = {
      chat: {
        completions: {
          create: async () => stream(),
        },
      },
    };

    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.run({
      model: 'qwen-max',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'run bash' }],
      tools: [
        {
          name: 'bash',
          description: 'Run shell command',
          inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
        },
      ],
      maxTokens: 128,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'tool_use_delta',
        id: 'tool-1',
        name: 'bash',
        thoughtSignature: 'sig-stream-1',
      }),
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'done',
        stopReason: 'tool_use',
      }),
    );
  });

  it('uses non-stream fallback for Gemini tool calls and preserves thought signatures', async () => {
    const provider = new OpenAIProvider();
    let capturedRequest: Record<string, unknown> | undefined;

    (provider as unknown as {
      client: { chat: { completions: { create: (request: Record<string, unknown>) => Promise<Record<string, unknown>> } } };
    }).client = {
      chat: {
        completions: {
          create: async (request) => {
            capturedRequest = request;
            return {
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: 'call-gemini-1',
                        type: 'function',
                        function: {
                          name: 'bash',
                          arguments: '{"command":"wmic logicaldisk get size,freespace,caption"}',
                        },
                        thought_signature: 'sig-gemini-nonstream',
                      },
                    ],
                  },
                },
              ],
              usage: {
                prompt_tokens: 17,
                completion_tokens: 5,
              },
            };
          },
        },
      },
    };

    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.run({
      model: 'gemini-3.1-flash-lite',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'check disk' }],
      tools: [
        {
          name: 'bash',
          description: 'Run shell command',
          inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
        },
      ],
      maxTokens: 128,
    })) {
      chunks.push(chunk);
    }

    expect(capturedRequest?.stream).toBeUndefined();
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'tool_use_delta',
        id: 'call-gemini-1',
        name: 'bash',
        thoughtSignature: 'sig-gemini-nonstream',
      }),
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'done',
        stopReason: 'tool_use',
      }),
    );
  });

  it('flattens Gemini tool history before follow-up requests', async () => {
    const provider = new OpenAIProvider();
    let capturedRequest: Record<string, unknown> | undefined;

    (provider as unknown as {
      client: { chat: { completions: { create: (request: Record<string, unknown>) => Promise<Record<string, unknown>> } } };
    }).client = {
      chat: {
        completions: {
          create: async (request) => {
            capturedRequest = request;
            return {
              choices: [
                {
                  finish_reason: 'stop',
                  message: {
                    content: '磁盘检查完成。',
                  },
                },
              ],
              usage: {
                prompt_tokens: 22,
                completion_tokens: 4,
              },
            };
          },
        },
      },
    };

    const chunks: StreamChunk[] = [];
    for await (const chunk of provider.run({
      model: 'gemini-3.1-flash-lite',
      systemPrompt: '',
      messages: [
        { role: 'user', content: '检查一下磁盘容量' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '先读取磁盘信息。' },
            {
              type: 'tool_use',
              id: 'call-1',
              name: 'bash',
              input: { command: 'wmic logicaldisk get size,freespace,caption' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-1',
              content: 'Caption  C:  FreeSpace 100',
            },
          ],
        },
      ],
      tools: [
        {
          name: 'bash',
          description: 'Run shell command',
          inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
        },
      ],
      maxTokens: 128,
    })) {
      chunks.push(chunk);
    }

    const requestMessages = (capturedRequest?.messages as Array<Record<string, unknown>>) ?? [];
    expect(requestMessages.some((message) => Array.isArray(message.tool_calls))).toBe(false);
    expect(requestMessages.some((message) => message.role === 'tool')).toBe(false);
    expect(requestMessages).toContainEqual(
      expect.objectContaining({
        role: 'assistant',
        content: '先读取磁盘信息。',
      }),
    );
    expect(requestMessages).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Tool execution results:'),
      }),
    );
    expect(requestMessages).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Caption  C:  FreeSpace 100'),
      }),
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'text_delta',
        text: '磁盘检查完成。',
      }),
    );
  });
});