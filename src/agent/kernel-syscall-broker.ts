import type { AgentKernel } from '../core/kernel/agent-kernel.js';
import type { AgentTurnProcessRuntime } from './process-runtime.js';

export async function drainWaitingAgentSyscalls(
  kernel: AgentKernel,
  runtime: AgentTurnProcessRuntime,
): Promise<boolean> {
  const waitingSnapshots = kernel
    .listSnapshots()
    .filter(
      (snapshot) =>
        snapshot.processType === runtime.type &&
        snapshot.status === 'waiting' &&
        snapshot.pendingSyscall,
    );

  if (waitingSnapshots.length === 0) {
    return false;
  }

  // RATIONALE: Execute all pending syscalls (LLM calls, tool calls) concurrently so
  // multiple agents can make progress in parallel. The previous sequential for-await
  // loop caused Agent B to block until Agent A's LLM response returned, making the
  // system effectively single-agent at any one time.
  await Promise.allSettled(
    waitingSnapshots.map(async (snapshot) => {
      const pendingSyscall = snapshot.pendingSyscall;
      if (!pendingSyscall) {
        return;
      }
      const state = runtime.deserialize(snapshot.state);
      const resolution = await runtime.executePendingSyscall(state, pendingSyscall, Date.now());
      // Guard: process may have been deleted (e.g. cancelled/completed) during the async syscall execution
      if (!kernel.getSnapshot(snapshot.pid)) {
        return;
      }
      await kernel.resolveSyscall(snapshot.pid, resolution);
    }),
  );

  return true;
}
