import type { AgentKernel } from '../core/kernel/agent-kernel.js';
import type { AgentTurnProcessRuntime } from './process-runtime.js';

export async function drainWaitingAgentSyscalls(
  kernel: AgentKernel,
  runtime: AgentTurnProcessRuntime,
): Promise<boolean> {
  let resolvedAny = false;
  const waitingSnapshots = kernel
    .listSnapshots()
    .filter(
      (snapshot) =>
        snapshot.processType === runtime.type &&
        snapshot.status === 'waiting' &&
        snapshot.pendingSyscall,
    );

  for (const snapshot of waitingSnapshots) {
    const pendingSyscall = snapshot.pendingSyscall;
    if (!pendingSyscall) {
      continue;
    }
    const state = runtime.deserialize(snapshot.state);
    const resolution = await runtime.executePendingSyscall(state, pendingSyscall, Date.now());
    // Guard: process may have been deleted (e.g. cancelled/completed) during the async syscall execution
    if (!kernel.getSnapshot(snapshot.pid)) {
      continue;
    }
    await kernel.resolveSyscall(snapshot.pid, resolution);
    resolvedAny = true;
  }

  return resolvedAny;
}
