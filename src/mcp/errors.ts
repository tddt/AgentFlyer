import type { McpRuntimeErrorCode, McpRuntimeErrorPhase } from './types.js';

export class McpTransportError extends Error {
  constructor(
    message: string,
    readonly code: McpRuntimeErrorCode,
    readonly phase: McpRuntimeErrorPhase,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'McpTransportError';
  }
}

export function toMcpRuntimeError(error: unknown): {
  lastError: string;
  lastErrorCode?: McpRuntimeErrorCode;
  lastErrorPhase?: McpRuntimeErrorPhase;
} {
  if (error instanceof McpTransportError) {
    return {
      lastError: error.message,
      lastErrorCode: error.code,
      lastErrorPhase: error.phase,
    };
  }

  if (error instanceof Error) {
    return {
      lastError: error.message,
    };
  }

  return {
    lastError: String(error),
  };
}
