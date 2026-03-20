/**
 * AgentFlyer Plugin SDK
 *
 * A plugin is a self-contained ESM module that registers tools, channels, or
 * prompt-layer hooks into a running AgentFlyer gateway without modifying core
 * code. Plugins are loaded at gateway startup from the paths listed in
 * `config.plugins`.
 *
 * Minimal plugin example:
 * ```typescript
 * import type { AgentFlyerPlugin } from '@agentflyer/plugin-sdk';
 * const plugin: AgentFlyerPlugin = {
 *   name: 'my-plugin',
 *   version: '1.0.0',
 *   async setup(ctx) {
 *     ctx.tools.register({
 *       category: 'skill',
 *       definition: { name: 'my_tool', description: '…', inputSchema: {} },
 *       handler: async (input) => ({ content: 'result' }),
 *     });
 *   },
 * };
 * export default plugin;
 * ```
 */
import type { ToolRegistry } from '../agent/tools/registry.js';
import type { Channel } from '../channels/types.js';
import type { Config } from '../core/config/schema.js';

export type { ToolRegistry };
export type { Channel };

// ── Manifest ────────────────────────────────────────────────────────────────

/**
 * Declared in the plugin package's `package.json` under
 * `"agentflyer": { "plugin": "./dist/index.js" }`.
 */
export interface PluginManifest {
  /** Entry point relative to the package root (JS, not TS). */
  plugin: string;
  /** Optional display name. Defaults to the npm package name. */
  displayName?: string;
  /** Minimum AgentFlyer gateway version (semver range). */
  requires?: string;
}

// ── Context ─────────────────────────────────────────────────────────────────

/**
 * Passed to a plugin's `setup()` call. Provides scoped access to gateway
 * internals. The gateway intentionally omits internals not meant for plugins.
 */
export interface PluginContext {
  /** Register custom tools (skills). */
  tools: Pick<ToolRegistry, 'register' | 'registerMany'>;

  /**
   * Register an additional communication channel.
   * The gateway will call `channel.start()` after all plugins are loaded.
   */
  registerChannel(channel: Channel): void;

  /** Read-only snapshot of the resolved gateway configuration. */
  config: Readonly<Config>;

  /** Emit a structured log line under the plugin's namespace. */
  log: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
}

// ── Plugin interface ─────────────────────────────────────────────────────────

export interface AgentFlyerPlugin {
  /** Unique plugin name (lower-kebab-case). Used in logs and error messages. */
  readonly name: string;
  /** SemVer version string for diagnostic output. */
  readonly version: string;

  /**
   * Called once during gateway startup after config is validated.
   * Register tools, channels, or other hooks via `ctx`.
   */
  setup(ctx: PluginContext): Promise<void>;

  /**
   * Called during graceful gateway shutdown.
   * Release DB connections, close sockets, etc.
   */
  teardown?(): Promise<void>;
}

// ── Loader helper (used by gateway, not by plugins themselves) ───────────────

/**
 * Dynamically imports a plugin module and validates the default export shape.
 * Throws a descriptive error if the export is missing required fields.
 */
export async function loadPlugin(entryPath: string): Promise<AgentFlyerPlugin> {
  const mod = await import(entryPath) as { default?: AgentFlyerPlugin };
  const plugin = mod.default;
  if (!plugin || typeof plugin !== 'object') {
    throw new Error(`Plugin at ${entryPath} has no default export.`);
  }
  if (typeof plugin.name !== 'string' || !plugin.name) {
    throw new Error(`Plugin at ${entryPath} is missing a "name" string.`);
  }
  if (typeof plugin.version !== 'string' || !plugin.version) {
    throw new Error(`Plugin at ${entryPath} is missing a "version" string.`);
  }
  if (typeof plugin.setup !== 'function') {
    throw new Error(`Plugin "${plugin.name}" is missing a setup() function.`);
  }
  return plugin;
}
