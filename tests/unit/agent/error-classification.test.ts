import { describe, expect, it } from 'vitest';
import { classifyAgentFailure } from '../../../src/agent/llm/error-classification.js';

describe('classifyAgentFailure', () => {
  it('classifies rate limit errors as retryable with stable user messaging', () => {
    const result = classifyAgentFailure('429 rate limit exceeded for requests per min');

    expect(result.code).toBe('rate_limit');
    expect(result.retryableBeforeOutput).toBe(true);
    expect(result.summary).toContain('速率限制');
  });

  it('classifies overloaded or transient upstream errors as retryable', () => {
    const overloaded = classifyAgentFailure('503 Service Unavailable');
    const transient = classifyAgentFailure('fetch failed: socket hang up');

    expect(overloaded.retryableBeforeOutput).toBe(true);
    expect(transient.retryableBeforeOutput).toBe(true);
  });

  it('classifies context overflow with a stable remediation message', () => {
    const result = classifyAgentFailure('context length exceeded maximum tokens for this model');

    expect(result.code).toBe('context_overflow');
    expect(result.retryableBeforeOutput).toBe(false);
    expect(result.summary).toContain('上下文超限');
  });

  it('classifies billing and quota failures as non-retryable', () => {
    const result = classifyAgentFailure('insufficient_quota: billing hard limit reached');

    expect(result.code).toBe('billing');
    expect(result.retryableBeforeOutput).toBe(false);
    expect(result.summary).toContain('计费');
  });
});