import { createLogger } from '../logger.js';
import type { Message, MessageContent, ToolResultContent, ToolUseContent } from '../types.js';

const logger = createLogger('session:repair');

export interface RepairResult {
  repaired: Message[];
  removedCount: number;
  issues: string[];
}

/**
 * Validate and repair a conversation transcript.
 *
 * Ensures every `tool_use` has a matching `tool_result` and vice versa.
 * Orphaned operations are removed to prevent LLM API errors.
 */
export function repairTranscript(messages: Message[]): RepairResult {
  const issues: string[] = [];
  const repaired: Message[] = [];
  let removedCount = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const toolUses = (msg.content as MessageContent[]).filter(
        (c): c is ToolUseContent => c.type === 'tool_use',
      );

      if (toolUses.length > 0) {
        const nextMsg = messages[i + 1];
        if (!nextMsg || nextMsg.role !== 'user' || !Array.isArray(nextMsg.content)) {
          issues.push(
            `Assistant msg[${i}] has tool_use but no following user tool_result — removing`,
          );
          removedCount++;
          continue;
        }

        const toolResults = (nextMsg.content as MessageContent[]).filter(
          (c): c is ToolResultContent => c.type === 'tool_result',
        );

        for (const toolUse of toolUses) {
          if (!toolResults.some((r) => r.tool_use_id === toolUse.id)) {
            issues.push(`tool_use id=${toolUse.id} has no matching tool_result`);
          }
        }
      }
    }

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const toolResults = (msg.content as MessageContent[]).filter(
        (c): c is ToolResultContent => c.type === 'tool_result',
      );

      if (toolResults.length > 0) {
        const prevMsg = repaired[repaired.length - 1];
        if (!prevMsg || prevMsg.role !== 'assistant' || !Array.isArray(prevMsg.content)) {
          issues.push(
            `User msg[${i}] has tool_result but no preceding assistant tool_use — removing`,
          );
          removedCount++;
          continue;
        }
      }
    }

    repaired.push(msg);
  }

  // A trailing user message that contains ONLY tool_results is invalid
  const lastMsg = repaired.at(-1);
  if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
    const allResults = (lastMsg.content as MessageContent[]).every((c) => c.type === 'tool_result');
    if (allResults) {
      issues.push('Trailing orphaned tool_result message removed');
      repaired.pop();
      removedCount++;
    }
  }

  if (issues.length > 0) {
    logger.warn('Transcript repaired', { issues, removedCount });
  }

  return { repaired, removedCount, issues };
}
