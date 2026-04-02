/**
 * IntentRouter — lightweight, zero-LLM message-to-agent routing (E6.1).
 *
 * Modes
 * ─────
 * simple     : Regex pattern matching only. First-match-wins, case-insensitive.
 * capability : Phase 2 — semantic capability-vector pre-check (not yet implemented);
 *              falls through to simple mode.
 * llm        : Phase 2 — full LLM classification (not yet implemented);
 *              falls through to simple mode.
 *
 * Usage
 * ─────
 * const router = new IntentRouter(config.routing);
 * const agentId = router.route(userMessage);   // always returns a string
 */

import type { RoutingConfig } from '../core/config/schema.js';
import { createLogger } from '../core/logger.js';
import { type AgentId, asAgentId } from '../core/types.js';

const logger = createLogger('gateway:intent-router');

interface CompiledRule {
  regex: RegExp;
  agent: AgentId;
  fallback: AgentId;
}

export class IntentRouter {
  private rules: CompiledRule[];
  private defaultAgent: AgentId;
  private mode: RoutingConfig['mode'];

  constructor(cfg: RoutingConfig) {
    this.mode = cfg.mode;
    this.defaultAgent = asAgentId(cfg.defaultAgent);

    this.rules = cfg.rules.map((r) => ({
      // RATIONALE: Use case-insensitive flag so Chinese / mixed-case messages work without
      // the user needing to write separate patterns for every capitalisation variant.
      regex: new RegExp(r.pattern, 'i'),
      agent: asAgentId(r.agent),
      fallback: asAgentId(r.fallback ?? cfg.defaultAgent),
    }));

    if (this.mode !== 'simple') {
      // capability / llm modes are Phase 2; log once so operators know what's active.
      logger.info(
        'IntentRouter: capability/llm modes not yet implemented — using simple fallback',
        {
          mode: this.mode,
        },
      );
    }

    logger.debug('IntentRouter initialised', {
      mode: this.mode,
      rules: this.rules.length,
      defaultAgent: this.defaultAgent,
    });
  }

  /**
   * Determine which agent should handle the given message.
   * Returns the matched agent ID, or `defaultAgent` when no rule matches.
   */
  route(message: string): AgentId {
    // Both capability and llm fall through to simple until Phase 2.
    for (const rule of this.rules) {
      if (rule.regex.test(message)) {
        logger.debug('IntentRouter matched rule', {
          agent: rule.agent,
          pattern: rule.regex.source,
        });
        return rule.agent;
      }
    }
    return this.defaultAgent;
  }

  /**
   * Like `route()` but also returns the fallback agent for the matched rule.
   * Useful when the caller wants to try the fallback if the primary is unavailable.
   */
  routeWithFallback(message: string): { agent: AgentId; fallback: AgentId } {
    for (const rule of this.rules) {
      if (rule.regex.test(message)) {
        return { agent: rule.agent, fallback: rule.fallback };
      }
    }
    return { agent: this.defaultAgent, fallback: this.defaultAgent };
  }

  get ruleCount(): number {
    return this.rules.length;
  }
}
