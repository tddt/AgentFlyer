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
 * Orphaned and malformed entries are removed to prevent LLM API errors.
 *
 * The function iterates until no further changes occur so that cascading
 * orphans created by earlier removals are also eliminated (up to 10 passes).
 *
 * Cases handled:
 * 1. Empty/null content messages → removed
 * 2. Assistant tool_use with missing id or name (malformed) → pair removed
 * 3. Assistant tool_use where ANY id has no matching tool_result → pair removed
 * 4. Assistant tool_use with no following user message → removed
 * 5. User tool_result with no preceding assistant tool_use → removed
 * 6. Trailing user message containing ONLY tool_results → removed
 */
export function repairTranscript(messages: Message[]): RepairResult {
  const issues: string[] = [];
  let removedCount = 0;
  let current = messages;

  for (let pass = 0; pass < 10; pass++) {
    const out: Message[] = [];
    let changed = false;
    let i = 0;

    while (i < current.length) {
      const msg = current[i];
      if (!msg) {
        i++;
        continue;
      }

      // Case 1: empty or null content
      if (
        msg.content == null ||
        (typeof msg.content === 'string' && msg.content.trim() === '') ||
        (Array.isArray(msg.content) && msg.content.length === 0)
      ) {
        issues.push(`Pass ${pass + 1}: msg[${i}] role=${msg.role} has empty content — removing`);
        removedCount++;
        changed = true;
        i++;
        continue;
      }

      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const toolUses = (msg.content as MessageContent[]).filter(
          (c): c is ToolUseContent => c.type === 'tool_use',
        );

        if (toolUses.length > 0) {
          // Case 2: malformed tool_use entries (missing id or name)
          const malformed = toolUses.filter((tu) => !tu.id || !tu.name);
          if (malformed.length > 0) {
            issues.push(
              `Pass ${pass + 1}: Assistant msg[${i}] has ${malformed.length} malformed tool_use(s) (missing id/name) — removing pair`,
            );
            removedCount++;
            changed = true;
            const nextMsg = current[i + 1];
            if (
              nextMsg?.role === 'user' &&
              Array.isArray(nextMsg.content) &&
              (nextMsg.content as MessageContent[]).some((c) => c.type === 'tool_result')
            ) {
              i++;
              removedCount++;
            }
            i++;
            continue;
          }

          // Case 4: no following user message at all
          const nextMsg = current[i + 1];
          if (!nextMsg || nextMsg.role !== 'user' || !Array.isArray(nextMsg.content)) {
            issues.push(
              `Pass ${pass + 1}: Assistant msg[${i}] has tool_use but no following user tool_result — removing`,
            );
            removedCount++;
            changed = true;
            i++;
            continue;
          }

          const toolResults = (nextMsg.content as MessageContent[]).filter(
            (c): c is ToolResultContent => c.type === 'tool_result',
          );
          const resultIds = new Set(toolResults.map((r) => r.tool_use_id));

          // Case 3: ANY tool_use id has no matching result → drop the entire pair
          const missingIds = toolUses.map((tu) => tu.id).filter((id) => !resultIds.has(id));
          if (missingIds.length > 0) {
            issues.push(
              `Pass ${pass + 1}: Assistant msg[${i}] tool_use ids [${missingIds.join(', ')}] have no matching tool_result — removing pair`,
            );
            removedCount += 2;
            changed = true;
            i += 2;
            continue;
          }
        }
      }

      // Case 5: user tool_results without preceding assistant tool_use
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const toolResults = (msg.content as MessageContent[]).filter(
          (c): c is ToolResultContent => c.type === 'tool_result',
        );
        if (toolResults.length > 0) {
          const prevMsg = out[out.length - 1];
          if (!prevMsg || prevMsg.role !== 'assistant' || !Array.isArray(prevMsg.content)) {
            issues.push(
              `Pass ${pass + 1}: User msg[${i}] has tool_result but no preceding assistant tool_use — removing`,
            );
            removedCount++;
            changed = true;
            i++;
            continue;
          }
        }
      }

      out.push(msg);
      i++;
    }

    current = out;
    if (!changed) break;
  }

  // Case 6: trailing user message containing ONLY tool_results is invalid
  const lastMsg = current.at(-1);
  if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
    const allResults = (lastMsg.content as MessageContent[]).every(
      (c) => c.type === 'tool_result',
    );
    if (allResults) {
      issues.push('Trailing orphaned tool_result message removed');
      current = current.slice(0, -1);
      removedCount++;
    }
  }

  if (issues.length > 0) {
    logger.warn('Transcript repaired', { issues, removedCount });
  }

  return { repaired: current, removedCount, issues };
}
