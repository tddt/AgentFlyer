import { type ApprovalHandler, denyApproval } from '../agent/tools/policy.js';
import type { ToolApprovalMode } from '../core/types.js';

export function resolveSandboxApprovalHandler(
  sandboxProfile?: string,
): ApprovalHandler | undefined {
  return sandboxProfile === 'readonly-output' ? denyApproval : undefined;
}

export function resolveMcpApprovalModeForSandbox(options: {
  sandboxProfile?: string;
  toolApprovalMode: ToolApprovalMode;
}): ToolApprovalMode {
  if (options.sandboxProfile === 'readonly-output' && options.toolApprovalMode === 'inherit') {
    return 'always';
  }

  return options.toolApprovalMode;
}
