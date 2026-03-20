import { createLogger } from '../core/logger.js';
import type { AgentRunner } from '../agent/runner.js';

const logger = createLogger('gateway:hooks');

export type LifecycleEvent =
  | 'before:start'
  | 'after:start'
  | 'before:stop'
  | 'after:stop'
  | 'before:reload'
  | 'after:reload'
  | 'agent:registered'
  | 'agent:error';

export type HookHandler = (event: LifecycleEvent, ctx: HookContext) => void | Promise<void>;

export interface HookContext {
  event: LifecycleEvent;
  agentId?: string;
  error?: Error;
  runners?: Map<string, AgentRunner>;
}

export class HookRegistry {
  private hooks = new Map<LifecycleEvent, HookHandler[]>();

  on(event: LifecycleEvent, handler: HookHandler): void {
    const existing = this.hooks.get(event) ?? [];
    this.hooks.set(event, [...existing, handler]);
  }

  async emit(event: LifecycleEvent, ctx: Omit<HookContext, 'event'>): Promise<void> {
    const handlers = this.hooks.get(event) ?? [];
    for (const h of handlers) {
      try {
        await h(event, { event, ...ctx });
      } catch (err) {
        logger.error('Hook error', { event, error: String(err) });
      }
    }
  }
}
