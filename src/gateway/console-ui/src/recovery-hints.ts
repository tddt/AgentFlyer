export interface RecoveryHint {
  title: string;
  description: string;
  action?: 'clear' | 'chat';
  actionLabel: string;
}

export function getRecoveryHint(
  errorCode: string,
  t: (key: string) => string,
): RecoveryHint {
  switch (errorCode) {
    case 'context_overflow':
      return {
        title: t('sessions.recovery.contextOverflowTitle'),
        description: t('sessions.recovery.contextOverflowDesc'),
        action: 'clear',
        actionLabel: t('sessions.recovery.action.clear'),
      };
    case 'compaction_failure':
      return {
        title: t('sessions.recovery.compactionFailureTitle'),
        description: t('sessions.recovery.compactionFailureDesc'),
        action: 'clear',
        actionLabel: t('sessions.recovery.action.clear'),
      };
    case 'tool_loop':
      return {
        title: t('sessions.recovery.toolLoopTitle'),
        description: t('sessions.recovery.toolLoopDesc'),
        action: 'chat',
        actionLabel: t('sessions.recovery.action.inspect'),
      };
    case 'tool_round_limit':
      return {
        title: t('sessions.recovery.toolRoundLimitTitle'),
        description: t('sessions.recovery.toolRoundLimitDesc'),
        action: 'chat',
        actionLabel: t('sessions.recovery.action.splitTask'),
      };
    case 'rate_limit':
      return {
        title: t('sessions.recovery.rateLimitTitle'),
        description: t('sessions.recovery.rateLimitDesc'),
        action: 'chat',
        actionLabel: t('sessions.recovery.action.retry'),
      };
    case 'overloaded':
    case 'transient_http':
      return {
        title: t('sessions.recovery.transientTitle'),
        description: t('sessions.recovery.transientDesc'),
        action: 'chat',
        actionLabel: t('sessions.recovery.action.retry'),
      };
    case 'billing':
      return {
        title: t('sessions.recovery.billingTitle'),
        description: t('sessions.recovery.billingDesc'),
        actionLabel: t('sessions.recovery.action.credentials'),
      };
    case 'approval_required':
      return {
        title: t('sessions.recovery.approvalRequiredTitle'),
        description: t('sessions.recovery.approvalRequiredDesc'),
        action: 'chat',
        actionLabel: t('sessions.recovery.action.inspect'),
      };
    default:
      return {
        title: t('sessions.recovery.genericTitle'),
        description: t('sessions.recovery.genericDesc'),
        action: 'chat',
        actionLabel: t('sessions.recovery.action.inspect'),
      };
  }
}