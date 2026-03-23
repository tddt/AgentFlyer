import { createLogger } from '../../core/logger.js';
/**
 * Channel Adapter Factory
 *
 * Provides a registration table for mapping channel-type identifiers (e.g.
 * "telegram", "discord") to factory functions that construct Channel instances
 * from config. Plugins can register new channel factories via the Plugin SDK.
 */
import type { Channel } from '../types.js';

const logger = createLogger('channels:adapters');

// ── Factory interface ────────────────────────────────────────────────────────

/**
 * A channel-specific config block (the value of `channels.<type>` in
 * agentflyer.json). The exact shape is channel-specific; the factory is
 * responsible for validating it.
 */
export type ChannelConfig = Record<string, unknown>;

/**
 * A factory that creates a Channel instance from a config block.
 * Factories should be pure: same config → same logical channel (idempotent).
 */
export type ChannelAdapterFactory = (config: ChannelConfig) => Channel;

// ── Registry ────────────────────────────────────────────────────────────────

const _registry = new Map<string, ChannelAdapterFactory>();

/**
 * Register a factory for a channel type.
 * Call this once at module load time (or in a plugin's `setup()`).
 */
export function registerChannelAdapter(type: string, factory: ChannelAdapterFactory): void {
  if (_registry.has(type)) {
    logger.warn('Overwriting existing channel adapter factory', { type });
  }
  _registry.set(type, factory);
  logger.debug('Registered channel adapter', { type });
}

/** Return the factory registered for `type`, or undefined. */
export function getChannelAdapter(type: string): ChannelAdapterFactory | undefined {
  return _registry.get(type);
}

/** List all registered channel type identifiers. */
export function listChannelAdapterTypes(): string[] {
  return Array.from(_registry.keys());
}

/**
 * Build a Channel for the given `type` and `config`.
 * Throws a descriptive error if no factory is registered for `type`.
 */
export function buildChannel(type: string, config: ChannelConfig): Channel {
  const factory = _registry.get(type);
  if (!factory) {
    throw new Error(
      `No channel adapter registered for type "${type}". ` +
        `Available: ${listChannelAdapterTypes().join(', ') || '(none)'}`,
    );
  }
  return factory(config);
}
