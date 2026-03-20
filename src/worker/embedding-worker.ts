/**
 * Embedding worker — runs inside a Node.js/Bun Worker thread.
 *
 * Protocol (message-passing):
 *   Main → Worker:  EmbedRequest  { id: string; text: string; model: string }
 *   Worker → Main:  EmbedResponse { id: string; embedding: number[] }
 *                 | EmbedErrorResponse { id: string; error: string }
 *
 * The ONNX pipeline is loaded once and reused for all subsequent messages,
 * keeping the main event loop free during the ~25 MB model download and
 * inference time.
 */
import { isMainThread, parentPort } from 'node:worker_threads';

if (isMainThread || !parentPort) {
  throw new Error('embedding-worker.ts must be run as a Worker thread, not the main thread.');
}

export interface EmbedRequest {
  id: string;
  text: string;
  model: string;
}

export interface EmbedResponse {
  id: string;
  embedding: number[];
}

export interface EmbedErrorResponse {
  id: string;
  error: string;
}

type WorkerResponse = EmbedResponse | EmbedErrorResponse;

type Pipeline = (
  text: string | string[],
  opts?: Record<string, unknown>,
) => Promise<{ data: Float32Array }>;

let _pipeline: Pipeline | null = null;
let _loadedModel: string | null = null;

async function getOrLoadPipeline(model: string): Promise<Pipeline | null> {
  if (_pipeline && _loadedModel === model) return _pipeline;
  try {
    const { pipeline } = (await import('@huggingface/transformers')) as {
      pipeline: (task: string, model: string) => Promise<Pipeline>;
    };
    _pipeline = await pipeline('feature-extraction', model);
    _loadedModel = model;
    return _pipeline;
  } catch {
    return null;
  }
}

/** Deterministic stub: 384-dim normalised vector based on char codes. */
function stubEmbed(text: string): number[] {
  const dims = 384;
  const vec = new Float32Array(dims);
  for (let i = 0; i < text.length; i++) {
    vec[i % dims] = (vec[i % dims] ?? 0) + text.charCodeAt(i) / 127;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec).map(v => v / norm);
}

parentPort.on('message', async (req: EmbedRequest) => {
  const port = parentPort!;
  try {
    const pipe = await getOrLoadPipeline(req.model);
    if (pipe) {
      const output = await pipe(req.text, { pooling: 'mean', normalize: true });
      const response: EmbedResponse = { id: req.id, embedding: Array.from(output.data) };
      port.postMessage(response);
    } else {
      const response: EmbedResponse = { id: req.id, embedding: stubEmbed(req.text) };
      port.postMessage(response);
    }
  } catch (err) {
    const response: EmbedErrorResponse = { id: req.id, error: String(err) };
    port.postMessage(response as WorkerResponse);
  }
});
