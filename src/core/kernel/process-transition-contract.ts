import type { ProcessSignalCode, ProcessStatus } from './types.js';

const PROCESS_SIGNAL_TO_STATUS: Record<ProcessSignalCode, ProcessStatus> = {
  YIELD: 'ready',
  WAITING_SYSCALL: 'waiting',
  SUSPENDED: 'suspended',
  DONE: 'done',
  ERROR: 'error',
  RETRYABLE_ERROR: 'ready',
};

export function deriveProcessStatusForSignal(signal: ProcessSignalCode): ProcessStatus {
  return PROCESS_SIGNAL_TO_STATUS[signal];
}

export function isRunnableProcessStatus(status: ProcessStatus): boolean {
  return status === 'ready' || status === 'running';
}

export function isTerminalProcessStatus(status: ProcessStatus): boolean {
  return status === 'done' || status === 'error';
}
