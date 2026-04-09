export type McpStatusFilter = 'all' | 'connected' | 'error' | 'disabled' | 'unconfigured';
export type McpTransportFilter = 'all' | 'stdio' | 'sse';

export interface McpStatusRecord {
  serverId: string;
  transport: 'stdio' | 'sse';
  status: 'connected' | 'error' | 'disabled';
  lastErrorCode?: string;
  lastErrorPhase?: string;
}

export interface McpConfigRecord {
  id: string;
  transport: 'stdio' | 'sse';
}

export interface McpStatusSummary {
  configured: number;
  connected: number;
  errored: number;
  disabled: number;
  unconfiguredRuntime: number;
  stdio: number;
  sse: number;
}

export function summarizeMcpStatus(
  configs: McpConfigRecord[],
  runtimeStatuses: McpStatusRecord[],
): McpStatusSummary {
  const runtimeIds = new Set(runtimeStatuses.map((status) => status.serverId));

  return {
    configured: configs.length,
    connected: runtimeStatuses.filter((status) => status.status === 'connected').length,
    errored: runtimeStatuses.filter((status) => status.status === 'error').length,
    disabled: runtimeStatuses.filter((status) => status.status === 'disabled').length,
    unconfiguredRuntime: runtimeStatuses.filter((status) => !runtimeIds.has(status.serverId)).length,
    stdio: configs.filter((config) => config.transport === 'stdio').length,
    sse: configs.filter((config) => config.transport === 'sse').length,
  };
}

export function collectMcpErrorCodes(runtimeStatuses: McpStatusRecord[]): string[] {
  return Array.from(
    new Set(runtimeStatuses.map((status) => status.lastErrorCode).filter((code): code is string => !!code)),
  ).sort((left, right) => left.localeCompare(right));
}

export function collectMcpErrorPhases(runtimeStatuses: McpStatusRecord[]): string[] {
  return Array.from(
    new Set(runtimeStatuses.map((status) => status.lastErrorPhase).filter((phase): phase is string => !!phase)),
  ).sort((left, right) => left.localeCompare(right));
}

export function matchMcpServerFilter(params: {
  config: McpConfigRecord;
  runtimeStatus?: McpStatusRecord;
  statusFilter: McpStatusFilter;
  transportFilter: McpTransportFilter;
  errorCodeFilter: string;
  errorPhaseFilter: string;
}): boolean {
  const { config, runtimeStatus, statusFilter, transportFilter, errorCodeFilter, errorPhaseFilter } =
    params;

  if (transportFilter !== 'all' && config.transport !== transportFilter) {
    return false;
  }

  const effectiveStatus: McpStatusFilter = runtimeStatus?.status ?? 'unconfigured';
  if (statusFilter !== 'all' && effectiveStatus !== statusFilter) {
    return false;
  }

  if (errorCodeFilter !== 'all' && runtimeStatus?.lastErrorCode !== errorCodeFilter) {
    return false;
  }

  if (errorPhaseFilter !== 'all' && runtimeStatus?.lastErrorPhase !== errorPhaseFilter) {
    return false;
  }

  return true;
}
