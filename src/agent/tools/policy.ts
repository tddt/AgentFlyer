import { createLogger } from '../../core/logger.js';
import type { ToolCallResult } from '../../core/types.js';

const logger = createLogger('tools:policy');

export interface ToolPolicy {
  /** Explicit allowlist — if set, only these tools are available */
  allowlist?: string[];
  /** Tools that are always blocked */
  denylist: string[];
  /** Tools that require interactive approval (prompt the user) */
  requireApproval: string[];
}

export type ApprovalHandler = (toolName: string, input: unknown) => Promise<boolean>;

export interface PolicyEnforcedResult {
  allowed: boolean;
  reason?: string;
  requiresApproval: boolean;
}

/**
 * Check whether a tool call is permitted under the given policy.
 * Returns a decision object — caller is responsible for actually running
 * the approval flow and blocking the call.
 */
export function checkPolicy(
  toolName: string,
  policy: ToolPolicy,
): PolicyEnforcedResult {
  // Hard deny
  if (policy.denylist.includes(toolName)) {
    logger.warn('Tool denied by denylist', { toolName });
    return { allowed: false, reason: `Tool '${toolName}' is blocked by policy`, requiresApproval: false };
  }

  // Allowlist gate
  if (policy.allowlist && policy.allowlist.length > 0) {
    if (!policy.allowlist.includes(toolName)) {
      logger.warn('Tool not in allowlist', { toolName });
      return {
        allowed: false,
        reason: `Tool '${toolName}' is not in the allowed tools list`,
        requiresApproval: false,
      };
    }
  }

  // Approval required (allowed, but must be confirmed)
  if (policy.requireApproval.includes(toolName)) {
    return { allowed: true, requiresApproval: true };
  }

  return { allowed: true, requiresApproval: false };
}

/** Apply policy to a list of tool names, returning only the permitted ones. */
export function filterAllowedTools(names: string[], policy: ToolPolicy): string[] {
  return names.filter((n) => {
    const result = checkPolicy(n, policy);
    return result.allowed;
  });
}

/** Default no-op approval handler — always approves (for non-interactive modes). */
export const autoApprove: ApprovalHandler = async (_toolName, _input) => true;

/** Deny-all approval handler for sandboxed/unattended runs. */
export const denyApproval: ApprovalHandler = async (toolName, _input) => {
  logger.warn('Tool approval denied (unattended mode)', { toolName });
  return false;
};

/** Returns a ToolCallResult for a policy-blocked call. */
export function policyBlockedResult(reason: string): ToolCallResult {
  return { isError: true, content: `Policy: ${reason}` };
}
