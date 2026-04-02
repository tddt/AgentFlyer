import { classifyAgentFailure } from './error-classification.js';

export function isRecoverableStreamError(message: string): boolean {
  return classifyAgentFailure(message).retryableBeforeOutput;
}