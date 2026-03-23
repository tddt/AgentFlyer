import { createLogger } from '../../core/logger.js';

const logger = createLogger('llm:auth-rotation');

/**
 * Round-robin API key rotation.
 * Reads keys from explicit list or from a comma-separated env var.
 */
export class ApiKeyRotator {
  private keys: string[];
  private index = 0;

  constructor(keys: string[] | string) {
    if (Array.isArray(keys)) {
      this.keys = keys.filter(Boolean);
    } else {
      this.keys = keys
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
    }
    if (this.keys.length === 0) {
      throw new Error('ApiKeyRotator: no API keys provided');
    }
  }

  /**
   * Return the next API key in round-robin order.
   * Advances the cursor so successive calls get a different key.
   */
  next(): string {
    const key = this.keys[this.index % this.keys.length]!;
    this.index = (this.index + 1) % this.keys.length;
    return key;
  }

  /** Total number of keys managed. */
  get count(): number {
    return this.keys.length;
  }
}

/**
 * Build an ApiKeyRotator from env or explicit list.
 * Priority: explicit `keys` arg → `envVar` → `fallbackEnv`.
 */
export function buildRotator(options: {
  keys?: string[];
  envVar?: string;
  fallbackEnv?: string;
}): ApiKeyRotator | null {
  const { keys, envVar, fallbackEnv } = options;

  if (keys && keys.length > 0) {
    logger.debug('Using explicit API keys', { count: keys.length });
    return new ApiKeyRotator(keys);
  }

  const fromEnv = envVar ? process.env[envVar] : undefined;
  if (fromEnv) {
    const parsed = fromEnv
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    logger.debug('Using API keys from env var', { envVar, count: parsed.length });
    return new ApiKeyRotator(parsed);
  }

  const fallback = fallbackEnv ? process.env[fallbackEnv] : undefined;
  if (fallback) {
    return new ApiKeyRotator([fallback]);
  }

  return null;
}
