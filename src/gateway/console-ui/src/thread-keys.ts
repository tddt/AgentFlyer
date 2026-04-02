export function createConsoleThreadKey(agentId: string, now = Date.now()): string {
  return `console:${agentId}:${now}`;
}