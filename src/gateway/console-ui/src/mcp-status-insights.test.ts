import { describe, expect, it } from 'vitest';
import {
  collectMcpErrorCodes,
  collectMcpErrorPhases,
  matchMcpServerFilter,
  summarizeMcpStatus,
} from './mcp-status-insights.js';

describe('mcp-status-insights', () => {
  const configs = [
    { id: 'github', transport: 'stdio' as const },
    { id: 'filesystem', transport: 'sse' as const },
  ];
  const runtimeStatuses = [
    {
      serverId: 'github',
      transport: 'stdio' as const,
      status: 'connected' as const,
    },
    {
      serverId: 'filesystem',
      transport: 'sse' as const,
      status: 'error' as const,
      lastErrorCode: 'SSE_CONNECT_HTTP',
      lastErrorPhase: 'connect',
    },
  ];
  const githubConfig = configs[0];
  const filesystemConfig = configs[1];
  const githubStatus = runtimeStatuses[0];
  const filesystemStatus = runtimeStatuses[1];

  if (!githubConfig || !filesystemConfig || !githubStatus || !filesystemStatus) {
    throw new Error('Expected MCP test fixtures to be present');
  }

  it('summarizes MCP config and runtime counts', () => {
    expect(summarizeMcpStatus(configs, runtimeStatuses)).toEqual({
      configured: 2,
      connected: 1,
      errored: 1,
      disabled: 0,
      unconfiguredRuntime: 0,
      stdio: 1,
      sse: 1,
    });
  });

  it('collects stable error filter options', () => {
    expect(collectMcpErrorCodes(runtimeStatuses)).toEqual(['SSE_CONNECT_HTTP']);
    expect(collectMcpErrorPhases(runtimeStatuses)).toEqual(['connect']);
  });

  it('matches combined MCP filters against config and runtime state', () => {
    expect(
      matchMcpServerFilter({
        config: filesystemConfig,
        runtimeStatus: filesystemStatus,
        statusFilter: 'error',
        transportFilter: 'sse',
        errorCodeFilter: 'SSE_CONNECT_HTTP',
        errorPhaseFilter: 'connect',
      }),
    ).toBe(true);

    expect(
      matchMcpServerFilter({
        config: githubConfig,
        runtimeStatus: githubStatus,
        statusFilter: 'error',
        transportFilter: 'all',
        errorCodeFilter: 'all',
        errorPhaseFilter: 'all',
      }),
    ).toBe(false);
  });
});
