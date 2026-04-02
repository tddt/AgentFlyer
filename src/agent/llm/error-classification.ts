import type { SessionErrorCode } from '../../core/session/meta.js';

export type AgentFailureCode = Exclude<SessionErrorCode, 'tool_loop' | 'tool_round_limit'>;

export interface AgentFailureClassification {
  code: AgentFailureCode;
  retryableBeforeOutput: boolean;
  summary: string;
  rawMessage: string;
}

const RATE_LIMIT_PATTERNS = [/\b429\b/i, /rate\s*limit/i, /too many requests/i];
const OVERLOADED_PATTERNS = [/overload(?:ed)?/i, /server busy/i, /service busy/i, /capacity/i];
const CONTEXT_OVERFLOW_PATTERNS = [
  /context length/i,
  /context window/i,
  /context overflow/i,
  /maximum context/i,
  /max(?:imum)? tokens/i,
  /prompt is too long/i,
  /token limit/i,
  /request too large/i,
];
const COMPACTION_FAILURE_PATTERNS = [
  /compaction/i,
  /summari[sz]e.*history/i,
  /truncated due to context length/i,
];
const TRANSIENT_HTTP_PATTERNS = [
  /\b5(?:02|03|04|21|22|24)\b/i,
  /temporar(?:ily)? unavailable/i,
  /timeout/i,
  /timed out/i,
  /network error/i,
  /fetch failed/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ECONNABORTED/i,
  /ETIMEDOUT/i,
  /EPIPE/i,
  /socket hang up/i,
];
const BILLING_PATTERNS = [
  /billing/i,
  /payment required/i,
  /insufficient[_\s-]?quota/i,
  /credit/i,
  /balance/i,
  /quota exceeded/i,
];

function matchesAny(message: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

export function classifyAgentFailure(rawMessage: string): AgentFailureClassification {
  const message = rawMessage.trim();

  if (matchesAny(message, BILLING_PATTERNS)) {
    return {
      code: 'billing',
      retryableBeforeOutput: false,
      summary: '模型服务的计费或配额状态异常，请检查 API Key、余额或项目配额。',
      rawMessage,
    };
  }

  if (matchesAny(message, CONTEXT_OVERFLOW_PATTERNS)) {
    return {
      code: 'context_overflow',
      retryableBeforeOutput: false,
      summary: '上下文超限，当前会话对这个模型过长。请缩短输入、清理历史，或切换到更大上下文模型。',
      rawMessage,
    };
  }

  if (matchesAny(message, COMPACTION_FAILURE_PATTERNS)) {
    return {
      code: 'compaction_failure',
      retryableBeforeOutput: false,
      summary: '会话压缩失败，已无法继续安全压缩历史。请重试，或缩短上下文后再继续。',
      rawMessage,
    };
  }

  if (matchesAny(message, RATE_LIMIT_PATTERNS)) {
    return {
      code: 'rate_limit',
      retryableBeforeOutput: true,
      summary: 'API 速率限制已触发，请稍后再试。',
      rawMessage,
    };
  }

  if (matchesAny(message, OVERLOADED_PATTERNS)) {
    return {
      code: 'overloaded',
      retryableBeforeOutput: true,
      summary: 'AI 服务当前过载，请稍后再试。',
      rawMessage,
    };
  }

  if (matchesAny(message, TRANSIENT_HTTP_PATTERNS)) {
    return {
      code: 'transient_http',
      retryableBeforeOutput: true,
      summary: 'AI 服务暂时不可用，请稍后再试。',
      rawMessage,
    };
  }

  return {
    code: 'generic',
    retryableBeforeOutput: false,
    summary: message || '发生未知错误。',
    rawMessage,
  };
}
