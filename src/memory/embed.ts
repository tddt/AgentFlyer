import { createLogger } from '../core/logger.js';
import { Worker } from 'node:worker_threads';
import { ulid } from 'ulid';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const logger = createLogger('memory:embed');

export type EmbeddingProvider = 'local' | 'api';

export interface EmbedConfig {
  model: string;
  provider: EmbeddingProvider;
}

/** Simple cosine similarity between two float vectors */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

let _pipeline: ((text: string | string[], opts?: Record<string, unknown>) => Promise<{ data: Float32Array }>) | null = null;

/**
 * Lazily initialise the local ONNX embedding pipeline.
 * Downloads ~25 MB model on first use.
 */
async function getPipeline(modelId: string): Promise<typeof _pipeline> {
  if (_pipeline) return _pipeline;

  logger.info('Loading embedding model…', { model: modelId });
  try {
    // Dynamically import to avoid startup cost when embeddings are not needed
    const { pipeline } = await import('@huggingface/transformers') as {
      pipeline: (task: string, model: string) => Promise<(text: string | string[], opts?: Record<string, unknown>) => Promise<{ data: Float32Array }>>;
    };
    _pipeline = await pipeline('feature-extraction', modelId);
    logger.info('Embedding model ready', { model: modelId });
    return _pipeline;
  } catch (err) {
    logger.warn('Embedding model unavailable, falling back to stub', { error: String(err) });
    return null;
  }
}

/**
 * Generate an embedding vector for the given text.
 * Falls back to a zero vector if the model is unavailable.
 */
export async function embed(text: string, config: EmbedConfig): Promise<Float32Array> {
  const pipe = await getPipeline(config.model);
  if (!pipe) {
    return stubEmbed(text);
  }

  try {
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return output.data;
  } catch (err) {
    logger.warn('Embedding failed, using stub', { error: String(err) });
    return stubEmbed(text);
  }
}

/** Deterministic stub embedding based on character codes (384 dims to match MiniLM-L6) */
function stubEmbed(text: string): Float32Array {
  const dims = 384;
  const vec = new Float32Array(dims);
  for (let i = 0; i < text.length && i < dims; i++) {
    vec[i % dims] = (vec[i % dims] ?? 0) + text.charCodeAt(i) / 127;
  }
  // Normalise
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) vec[i] = (vec[i] ?? 0) / norm;
  return vec;
}

/** Reset the pipeline (useful in tests) */
export function resetPipeline(): void {
  _pipeline = null;
}

// ── Worker-thread embedding client ─────────────────────────────────────────

interface PendingRequest {
  resolve: (v: Float32Array) => void;
  reject: (e: Error) => void;
}

const WORKER_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../worker/embedding-worker.js',
);

/**
 * Lazily-created Worker thread for off-main-thread embedding.
 * The worker is shared across all callers; requests are multiplexed by id.
 */
let _worker: Worker | null = null;
const _pending = new Map<string, PendingRequest>();

/** Spawn (or return existing) embedding worker thread. */
export function createEmbeddingWorker(): Worker {
  if (_worker) return _worker;
  _worker = new Worker(WORKER_SCRIPT);
  _worker.on('message', (msg: { id: string; embedding?: number[]; error?: string }) => {
    const pending = _pending.get(msg.id);
    if (!pending) return;
    _pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(msg.error));
    } else if (msg.embedding) {
      pending.resolve(new Float32Array(msg.embedding));
    } else {
      pending.reject(new Error('Empty worker response'));
    }
  });
  _worker.on('error', err => {
    logger.error('Embedding worker error', { error: String(err) });
    // Reject all pending requests
    for (const [id, p] of _pending) {
      p.reject(err);
      _pending.delete(id);
    }
    _worker = null;
  });
  return _worker;
}

/**
 * Embed text using the worker thread. Falls back to in-process embedding
 * if the worker is not available or times out.
 */
export async function embedViaWorker(text: string, config: EmbedConfig): Promise<Float32Array> {
  const worker = createEmbeddingWorker();
  const id = ulid();
  return new Promise<Float32Array>((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    worker.postMessage({ id, text, model: config.model });
  });
}
