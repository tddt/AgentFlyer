type Translate = (key: string, vars?: Record<string, string | number>) => string;

const PROBLEM_CODE_LABEL_KEYS: Record<string, string> = {
  approval_required: 'problemCode.approvalRequired',
  billing: 'problemCode.billing',
  compaction_failure: 'problemCode.compactionFailure',
  context_overflow: 'problemCode.contextOverflow',
  generic: 'problemCode.generic',
  overloaded: 'problemCode.overloaded',
  rate_limit: 'problemCode.rateLimit',
  tool_loop: 'problemCode.toolLoop',
  tool_round_limit: 'problemCode.toolRoundLimit',
  transient_http: 'problemCode.transientHttp',
};

const PROBLEM_CODE_FALLBACK_LABELS: Record<string, string> = {
  approval_required: 'Pending Approval',
  billing: 'Billing or Quota',
  compaction_failure: 'Compaction Failure',
  context_overflow: 'Context Overflow',
  generic: 'Unknown Problem',
  overloaded: 'Service Overloaded',
  rate_limit: 'Rate Limited',
  tool_loop: 'Tool Loop Detected',
  tool_round_limit: 'Tool Round Limit',
  transient_http: 'Transient HTTP Error',
};

function fallbackFormatProblemCode(errorCode: string): string {
  return errorCode.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

export function isSuspendedProblemCode(errorCode: string): boolean {
  return errorCode === 'approval_required';
}

export function problemCodeBadgeVariant(errorCode: string): 'yellow' | 'red' {
  return isSuspendedProblemCode(errorCode) ? 'yellow' : 'red';
}

export function formatProblemCode(errorCode: string, t?: Translate): string {
  const labelKey = PROBLEM_CODE_LABEL_KEYS[errorCode];
  if (labelKey) {
    return t ? t(labelKey) : (PROBLEM_CODE_FALLBACK_LABELS[errorCode] ?? fallbackFormatProblemCode(errorCode));
  }

  return fallbackFormatProblemCode(errorCode);
}