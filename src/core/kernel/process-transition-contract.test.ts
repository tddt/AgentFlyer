import { describe, expect, it } from 'vitest';
import {
  deriveProcessStatusForSignal,
  isRunnableProcessStatus,
  isTerminalProcessStatus,
} from './process-transition-contract.js';

describe('process-transition-contract', () => {
  it('maps kernel step signals to durable process status', () => {
    expect(deriveProcessStatusForSignal('YIELD')).toBe('ready');
    expect(deriveProcessStatusForSignal('WAITING_SYSCALL')).toBe('waiting');
    expect(deriveProcessStatusForSignal('SUSPENDED')).toBe('suspended');
    expect(deriveProcessStatusForSignal('DONE')).toBe('done');
    expect(deriveProcessStatusForSignal('ERROR')).toBe('error');
    expect(deriveProcessStatusForSignal('RETRYABLE_ERROR')).toBe('ready');
  });

  it('classifies runnable and terminal process status centrally', () => {
    expect(isRunnableProcessStatus('ready')).toBe(true);
    expect(isRunnableProcessStatus('running')).toBe(true);
    expect(isRunnableProcessStatus('waiting')).toBe(false);
    expect(isRunnableProcessStatus('suspended')).toBe(false);

    expect(isTerminalProcessStatus('done')).toBe(true);
    expect(isTerminalProcessStatus('error')).toBe(true);
    expect(isTerminalProcessStatus('ready')).toBe(false);
    expect(isTerminalProcessStatus('waiting')).toBe(false);
  });
});
