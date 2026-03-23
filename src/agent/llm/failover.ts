import { createLogger } from '../../core/logger.js';
import type { StreamChunk } from '../../core/types.js';
import type { LLMProvider, RunParams } from './provider.js';

const logger = createLogger('llm:failover');

export interface FailoverOptions {
  primary: LLMProvider;
  /** Models to try on the primary's failure (e.g. lighter model). */
  fallbackModel?: string;
  /** Alternate full provider to try if primary fails entirely. */
  fallbackProvider?: LLMProvider;
  /** Max retries on the same provider before giving up. */
  maxRetries?: number;
}

/**
 * Wraps a primary provider and a fallback.
 * On streaming error, retries up to `maxRetries` times, then attempts
 * the fallback provider / fallback model if configured.
 */
export class FailoverProvider implements LLMProvider {
  readonly id: string;
  private opts: Required<Pick<FailoverOptions, 'maxRetries'>> & Omit<FailoverOptions, 'maxRetries'>;

  constructor(opts: FailoverOptions) {
    this.id = `failover:${opts.primary.id}`;
    this.opts = { maxRetries: 1, ...opts };
  }

  supports(model: string): boolean {
    return this.opts.primary.supports(model);
  }

  async *run(params: RunParams): AsyncIterable<StreamChunk> {
    let lastError: string | undefined;

    // Try primary up to maxRetries times
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      let hadError = false;
      try {
        for await (const chunk of this.opts.primary.run(params)) {
          if (chunk.type === 'error') {
            hadError = true;
            lastError = chunk.message;
            logger.warn('Primary provider error, will retry', {
              attempt,
              error: chunk.message,
            });
            break;
          }
          yield chunk;
        }
        if (!hadError) return;
      } catch (err) {
        hadError = true;
        lastError = String(err);
        logger.warn('Primary provider threw, will retry', { attempt, error: lastError });
      }
    }

    // Try fallback model on primary provider
    if (this.opts.fallbackModel) {
      logger.info('Trying fallback model on primary provider', {
        fallbackModel: this.opts.fallbackModel,
      });
      const fallbackParams = { ...params, model: this.opts.fallbackModel };
      try {
        for await (const chunk of this.opts.primary.run(fallbackParams)) {
          if (chunk.type === 'error') {
            lastError = chunk.message;
            break;
          }
          yield chunk;
          if (chunk.type === 'done') return;
        }
      } catch (err) {
        lastError = String(err);
      }
    }

    // Try fallback provider
    if (this.opts.fallbackProvider) {
      const fbModel = this.opts.fallbackModel ?? params.model;
      const fbParams = { ...params, model: fbModel };
      if (this.opts.fallbackProvider.supports(fbModel)) {
        logger.info('Trying fallback provider', { provider: this.opts.fallbackProvider.id });
        try {
          yield* this.opts.fallbackProvider.run(fbParams);
          return;
        } catch (err) {
          lastError = String(err);
        }
      }
    }

    // All attempts exhausted
    yield { type: 'error', message: `All LLM providers failed. Last error: ${lastError}` };
  }

  async countTokens(
    messages: Parameters<LLMProvider['countTokens']>[0],
    model: string,
  ): Promise<number> {
    return this.opts.primary.countTokens(messages, model);
  }
}
