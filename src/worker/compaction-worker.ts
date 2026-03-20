/**
 * Compaction worker — runs inside a Node.js/Bun Worker thread.
 *
 * Accepts a ready-to-send compaction request (pre-built prompt + LLM API
 * config), makes the fetch() call directly, and returns the raw text.
 * Keeping the blocking HTTP + streaming work in a worker thread frees the
 * main event loop during long compaction runs.
 *
 * Protocol:
 *   Main → Worker:  CompactRequest
 *   Worker → Main:  CompactResponse | CompactErrorResponse
 */
import { isMainThread, parentPort } from 'node:worker_threads';

if (isMainThread || !parentPort) {
  throw new Error('compaction-worker.ts must be run as a Worker thread, not the main thread.');
}

export interface LLMApiConfig {
  /** Full URL, e.g. https://api.anthropic.com/v1/messages */
  url: string;
  /** Raw API key value (not the header name). */
  apiKey: string;
  model: string;
  maxTokens?: number;
  /** 'anthropic' | 'openai' — controls request/response shape. */
  provider: 'anthropic' | 'openai';
}

export interface CompactRequest {
  id: string;
  /** Pre-built compaction prompt (output of buildCompactionPrompt). */
  prompt: string;
  api: LLMApiConfig;
}

export interface CompactResponse {
  id: string;
  /** Raw LLM text output (JSON string of CompactionSummary). */
  text: string;
}

export interface CompactErrorResponse {
  id: string;
  error: string;
}

type WorkerResponse = CompactResponse | CompactErrorResponse;

async function callAnthropicCompact(prompt: string, api: LLMApiConfig): Promise<string> {
  const res = await fetch(api.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': api.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: api.model,
      max_tokens: api.maxTokens ?? 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  const json = await res.json() as { content?: Array<{ type: string; text?: string }> };
  return json.content?.find(c => c.type === 'text')?.text ?? '';
}

async function callOpenAICompact(prompt: string, api: LLMApiConfig): Promise<string> {
  const res = await fetch(api.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${api.apiKey}`,
    },
    body: JSON.stringify({
      model: api.model,
      max_tokens: api.maxTokens ?? 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? '';
}

parentPort.on('message', async (req: CompactRequest) => {
  const port = parentPort!;
  try {
    let text: string;
    if (req.api.provider === 'openai') {
      text = await callOpenAICompact(req.prompt, req.api);
    } else {
      text = await callAnthropicCompact(req.prompt, req.api);
    }
    const response: CompactResponse = { id: req.id, text };
    port.postMessage(response as WorkerResponse);
  } catch (err) {
    const response: CompactErrorResponse = { id: req.id, error: String(err) };
    port.postMessage(response as WorkerResponse);
  }
});
