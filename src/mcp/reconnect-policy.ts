import type { McpAutoReconnectPolicy, McpRuntimeErrorCode } from './types.js';

export const DEFAULT_MCP_AUTO_RECONNECT_POLICY: McpAutoReconnectPolicy = {
  enabled: true,
  pollIntervalMs: 5_000,
  baseDelayMs: 15_000,
  maxDelayMs: 5 * 60_000,
};

const NON_RETRYABLE_ERROR_CODES = new Set<McpRuntimeErrorCode>([
  'UNKNOWN_TRANSPORT',
  'STDIO_COMMAND_MISSING',
  'STDIO_FRAME_INVALID',
  'SSE_URL_MISSING',
  'SSE_CONNECT_NO_BODY',
  'SSE_ENDPOINT_INVALID',
]);

export function isMcpAutoRetryEligible(errorCode?: McpRuntimeErrorCode): boolean {
  if (!errorCode) {
    return true;
  }

  return !NON_RETRYABLE_ERROR_CODES.has(errorCode);
}

export function resolveMcpAutoReconnectPolicy(
  policy?: Partial<McpAutoReconnectPolicy>,
): McpAutoReconnectPolicy {
  const baseDelayMs = Math.max(
    1_000,
    policy?.baseDelayMs ?? DEFAULT_MCP_AUTO_RECONNECT_POLICY.baseDelayMs,
  );
  const maxDelayMs = Math.max(
    baseDelayMs,
    policy?.maxDelayMs ?? DEFAULT_MCP_AUTO_RECONNECT_POLICY.maxDelayMs,
  );

  return {
    enabled: policy?.enabled ?? DEFAULT_MCP_AUTO_RECONNECT_POLICY.enabled,
    pollIntervalMs: Math.max(
      1_000,
      policy?.pollIntervalMs ?? DEFAULT_MCP_AUTO_RECONNECT_POLICY.pollIntervalMs,
    ),
    baseDelayMs,
    maxDelayMs,
  };
}

export function computeMcpRetryDelayMs(
  retryCount: number,
  policy?: Partial<McpAutoReconnectPolicy>,
): number {
  const resolvedPolicy = resolveMcpAutoReconnectPolicy(policy);
  const normalizedRetryCount = Math.max(1, retryCount);
  return Math.min(
    resolvedPolicy.baseDelayMs * 2 ** (normalizedRetryCount - 1),
    resolvedPolicy.maxDelayMs,
  );
}

export function computeMcpNextRetryAt(
  now: number,
  retryCount: number,
  policy?: Partial<McpAutoReconnectPolicy>,
): number {
  return now + computeMcpRetryDelayMs(retryCount, policy);
}
