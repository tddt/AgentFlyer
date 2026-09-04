import type { AgentKernel } from '../core/kernel/agent-kernel.js';
import type { KernelProcessSnapshot, SyscallResolution } from '../core/kernel/types.js';
import { RuntimeResourceGovernor } from '../core/runtime-resource-governor.js';
import type { AgentTurnProcessRuntime } from './process-runtime.js';

const sharedResourceGovernor = new RuntimeResourceGovernor();

export async function drainWaitingAgentSyscalls(
  kernel: AgentKernel,
  runtime: AgentTurnProcessRuntime,
  resourceGovernor = sharedResourceGovernor,
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

  await Promise.all(
    waitingSnapshots.map((snapshot) =>
      executeWaitingAgentSyscall(kernel, runtime, snapshot, resourceGovernor),
    ),
  );

  return true;
}

export async function executeWaitingAgentSyscall(
  kernel: AgentKernel,
  runtime: AgentTurnProcessRuntime,
  snapshot: KernelProcessSnapshot,
  resourceGovernor: RuntimeResourceGovernor,
  signal?: AbortSignal,
): Promise<void> {
  const pendingSyscall = snapshot.pendingSyscall;
  if (!pendingSyscall || !kernel.getSnapshot(snapshot.pid)) {
    return;
  }
  const state = runtime.deserialize(snapshot.state);
  const lane =
    pendingSyscall.kind === 'llm.generate'
      ? 'llm'
      : pendingSyscall.kind === 'tool.call'
        ? 'tool'
        : null;
  const priority =
    snapshot.priority === 'critical' || snapshot.priority === 'high'
      ? 'interactive'
      : snapshot.priority === 'low'
        ? 'scheduler'
        : 'workflow';
  const execute = (): Promise<
    Awaited<ReturnType<AgentTurnProcessRuntime['executePendingSyscall']>>
  > => runtime.executePendingSyscall(state, pendingSyscall, Date.now());

  let resolution: SyscallResolution;
  try {
    resolution = lane
      ? await resourceGovernor.run(
          {
            lane,
            agentId: snapshot.metadata.agentId ?? 'unknown',
            priority,
            signal,
          },
          execute,
        )
      : await execute();
  } catch (error) {
    resolution = {
      requestId: pendingSyscall.id,
      ok: false,
      error: {
        code: signal?.aborted ? 'AGENT_TURN_SYSCALL_ABORTED' : 'AGENT_TURN_SYSCALL_ERROR',
        message: error instanceof Error ? error.message : String(error),
        retryable: !signal?.aborted,
      },
      resolvedAt: Date.now(),
    };
  }
  if (kernel.getSnapshot(snapshot.pid)) {
    await kernel.resolveSyscall(snapshot.pid, resolution);
  }
}
