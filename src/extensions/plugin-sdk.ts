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
import { GATEWAY_VERSION } from '../gateway/lifecycle.js';

export type { ToolRegistry };
export type { Channel };

// ── SemVer helpers ────────────────────────────────────────────────────────────

/**
 * Parse a semver string into [major, minor, patch].
 * Returns null on unparseable input.
 */
function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Minimal semver range evaluator supporting common range formats:
 *   ">=1.0.0", "^1.2.3", "~1.2.3", "1.x", "*", ">=1.0.0 <2.0.0"
 *
 * Returns true when `version` satisfies `range`.
 * Falls back to true on unrecognised range syntax (permissive).
 */
export function satisfiesSemver(version: string, range: string): boolean {
  const ver = parseSemver(version);
  if (!ver) return true; // unknown version — skip check
  const verTuple = ver; // narrowed const for use in closures

  /**
   * Evaluate a single comparator token like ">=1.2.3", "^1.2.3", "~1.2.0", "*", "1.x".
   */
  function evalToken(token: string): boolean {
    if (token === '*' || token === '') return true;

    // Caret: ^1.2.3 → >=1.2.3 <2.0.0
    const caretM = /^\^(\d+)\.(\d+)\.(\d+)/.exec(token);
    if (caretM) {
      const mj = Number(caretM[1]);
      const mn = Number(caretM[2]);
      const pt = Number(caretM[3]);
      const lo: [number, number, number] = [mj, mn, pt];
      const hi: [number, number, number] = [mj + 1, 0, 0];
      return compareVer(verTuple, lo) >= 0 && compareVer(verTuple, hi) < 0;
    }

    // Tilde: ~1.2.3 → >=1.2.3 <1.3.0
    const tildeM = /^~(\d+)\.(\d+)\.(\d+)/.exec(token);
    if (tildeM) {
      const mj = Number(tildeM[1]);
      const mn = Number(tildeM[2]);
      const pt = Number(tildeM[3]);
      const lo: [number, number, number] = [mj, mn, pt];
      const hi: [number, number, number] = [mj, mn + 1, 0];
      return compareVer(verTuple, lo) >= 0 && compareVer(verTuple, hi) < 0;
    }

    // Wildcard x: "1.x" → >=1.0.0 <2.0.0
    const xM = /^(\d+)\.x/.exec(token);
    if (xM) {
      const mj = Number(xM[1]);
      return verTuple[0] === mj;
    }

    // Comparator: >=1.0.0, >1.0.0, <=2.0.0, <2.0.0, =1.0.0
    const cmpM = /^(>=|<=|>|<|=)(\d+\.\d+\.\d+)/.exec(token);
    if (cmpM) {
      const op = cmpM[1] as string;
      const target = parseSemver(cmpM[2] as string);
      if (!target) return true;
      const cmp = compareVer(verTuple, target);
      if (op === '>=' ) return cmp >= 0;
      if (op === '>'  ) return cmp >  0;
      if (op === '<=' ) return cmp <= 0;
      if (op === '<'  ) return cmp <  0;
      if (op === '='  ) return cmp === 0;
    }

    // Bare version: "1.2.3"
    const bare = parseSemver(token);
    if (bare) return compareVer(verTuple, bare) === 0;

    return true; // unrecognised — permissive
  }

  function compareVer(a: [number, number, number], b: [number, number, number]): number {
    for (let i = 0; i < 3; i++) {
      const diff = (a[i] ?? 0) - (b[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  // AND-space-separated comparator groups (e.g. ">=1.0.0 <2.0.0")
  const tokens = range.trim().split(/\s+/);
  return tokens.every((t) => evalToken(t));
}

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

// ── Lifecycle hook types ──────────────────────────────────────────────────────

export interface AgentStartContext {
  agentId: string;
  /** Resolved agent config snapshot (read-only). */
  config: Readonly<Record<string, unknown>>;
}

export interface ToolCallContext {
  agentId: string;
  toolName: string;
  /** Mutable input — plugin may transform the arguments before execution. */
  input: Record<string, unknown>;
  /** Return false to deny the call. */
  deny(): void;
}

export interface MessageReceiveContext {
  channelId: string;
  /** Raw message text — plugin may transform before routing. */
  text: string;
  senderId?: string;
  /** Mutate this.text to change the message content seen by agents. */
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

  // ── Lifecycle hooks (SDK 2.0) ────────────────────────────────────────────

  /**
   * Called just before an agent runner begins processing a new turn.
   * Use to inject context or warm caches.
   */
  onAgentStart?(ctx: AgentStartContext): Promise<void> | void;

  /**
   * Interceptor invoked before every tool call.
   * Call `ctx.deny()` to block the invocation (the tool is never executed).
   * Mutate `ctx.input` to alter the arguments passed to the tool.
   */
  onToolCall?(ctx: ToolCallContext): Promise<void> | void;

  /**
   * Interceptor invoked when a message arrives from any channel.
   * Mutate `ctx.text` to pre-process the message before agent routing.
   */
  onMessageReceive?(ctx: MessageReceiveContext): Promise<void> | void;
}

// ── Loader helper (used by gateway, not by plugins themselves) ───────────────

/**
 * Dynamically imports a plugin module, validates the default export shape,
 * and checks the `requires` semver range against the running gateway version.
 * Throws a descriptive error if validation fails.
 */
export async function loadPlugin(
  entryPath: string,
  manifest?: PluginManifest,
): Promise<AgentFlyerPlugin> {
  // SemVer range check
  if (manifest?.requires) {
    if (!satisfiesSemver(GATEWAY_VERSION, manifest.requires)) {
      throw new Error(
        `Plugin at ${entryPath} requires gateway ${manifest.requires} but running ${GATEWAY_VERSION}.`,
      );
    }
  }

  const mod = (await import(entryPath)) as { default?: AgentFlyerPlugin };
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

// ── Plugin lifecycle runner (used by gateway) ─────────────────────────────────

/**
 * Run `onAgentStart` hooks for all loaded plugins.
 * Errors in individual plugins are logged but do not abort the turn.
 */
export async function runOnAgentStart(
  plugins: AgentFlyerPlugin[],
  ctx: AgentStartContext,
): Promise<void> {
  for (const plugin of plugins) {
    if (typeof plugin.onAgentStart === 'function') {
      try {
        await plugin.onAgentStart(ctx);
      } catch (err) {
        console.error(`[plugin:${plugin.name}] onAgentStart error`, err);
      }
    }
  }
}

/**
 * Run `onToolCall` hooks. Returns false if any plugin denied the call.
 * Input mutations from all plugins are applied in plugin registration order.
 */
export async function runOnToolCall(
  plugins: AgentFlyerPlugin[],
  ctx: ToolCallContext,
): Promise<boolean> {
  let denied = false;
  const denyFn = (): void => {
    denied = true;
  };
  const hookCtx = { ...ctx, deny: denyFn };
  for (const plugin of plugins) {
    if (typeof plugin.onToolCall === 'function') {
      try {
        await plugin.onToolCall(hookCtx);
      } catch (err) {
        console.error(`[plugin:${plugin.name}] onToolCall error`, err);
      }
    }
    if (denied) return false;
  }
  return !denied;
}

/**
 * Run `onMessageReceive` hooks, giving plugins a chance to pre-process
 * incoming channel messages before agent routing.
 */
export async function runOnMessageReceive(
  plugins: AgentFlyerPlugin[],
  ctx: MessageReceiveContext,
): Promise<void> {
  for (const plugin of plugins) {
    if (typeof plugin.onMessageReceive === 'function') {
      try {
        await plugin.onMessageReceive(ctx);
      } catch (err) {
        console.error(`[plugin:${plugin.name}] onMessageReceive error`, err);
      }
    }
  }
}


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

