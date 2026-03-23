import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import chokidar from 'chokidar';
import JSON5 from 'json5';
import { createLogger } from '../logger.js';
import { migrateV1toV2 } from './migrate.js';
import { type Config, ConfigSchema } from './schema.js';

const logger = createLogger('config');

export function getDefaultConfigDir(): string {
  return join(homedir(), '.agentflyer');
}

export function getDefaultConfigPath(): string {
  return join(getDefaultConfigDir(), 'agentflyer.json');
}

/**
 * Load and validate agentflyer.json from disk.
 * Automatically migrates v1 configs to v2 and writes back.
 * Returns fully-merged defaults if file not found.
 * Throws on parse errors or schema validation failures.
 */
export function loadConfig(configPath?: string): Config {
  const path = configPath ?? getDefaultConfigPath();

  if (!existsSync(path)) {
    logger.info('Config file not found — writing minimal starter config', { path });
    // Parse with explicit empty models/agents so Zod defaults don't inject placeholder entries.
    // The console-ui setup wizard will guide the user through initial configuration.
    const result = ConfigSchema.safeParse({ version: 2, models: {}, agents: [] });
    if (!result.success) throw new Error(`Default config invalid: ${result.error.message}`);
    // Write a minimal skeleton so the user has a file to inspect and edit.
    const skeleton = JSON.stringify({ version: 2, models: {}, agents: [] }, null, 2);
    mkdir(dirname(path), { recursive: true })
      .then(() => writeFile(path, skeleton, 'utf-8'))
      .catch((err: unknown) =>
        logger.warn('Failed to write initial config', { error: String(err) }),
      );
    return result.data;
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read config at ${path}: ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON5.parse(raw);
  } catch (err) {
    throw new Error(`JSON5 parse error in ${path}: ${String(err)}`);
  }

  // Auto-migrate v1 → v2 if needed
  const maybeV1 = parsed as Record<string, unknown> | null;
  if (
    typeof maybeV1 === 'object' &&
    maybeV1 !== null &&
    (maybeV1.version === 1 || maybeV1.version === undefined)
  ) {
    logger.info('Detected v1 config, migrating to v2…', { path });
    parsed = migrateV1toV2(parsed);
    // Write back asynchronously so startup is not blocked
    const migrated = parsed;
    writeFile(path, JSON.stringify(migrated, null, 2), 'utf-8').catch((err: unknown) =>
      logger.warn('Failed to write migrated config', { error: String(err) }),
    );
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.errors.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Config validation failed in ${path}:\n${errors}`);
  }

  logger.info('Config loaded', { path, version: result.data.version });
  return result.data;
}

/** Persist config to disk, with automatic backup of the previous version. */
export async function saveConfig(config: Config, configPath?: string): Promise<void> {
  const path = configPath ?? getDefaultConfigPath();
  const dir = dirname(path);

  await mkdir(dir, { recursive: true });

  if (existsSync(path)) {
    const existing = await readFile(path, 'utf-8');
    await writeFile(`${path}.bak`, existing, 'utf-8');
  }

  await writeFile(path, JSON.stringify(config, null, 2), 'utf-8');
  logger.info('Config saved', { path });
}

/** Create the data directory hierarchy if it does not exist. */
export function ensureDataDir(dir?: string): void {
  const base = dir ?? getDefaultConfigDir();
  for (const sub of [
    base,
    join(base, 'agents'),
    join(base, 'skills-cache'),
    join(base, 'credentials'),
    join(base, 'locks'),
    join(base, 'cron'),
    join(base, 'federation'),
    join(base, 'workspace'),
    join(base, 'memory'),
  ]) {
    if (!existsSync(sub)) {
      mkdirSync(sub, { recursive: true });
    }
  }
}

// ─── Config watcher ───────────────────────────────────────────────────────────
export interface ConfigWatcher {
  stop(): void;
}

export function watchConfig(
  callback: (config: Config, error?: Error) => void,
  configPath?: string,
): ConfigWatcher {
  const path = configPath ?? getDefaultConfigPath();

  const watcher = chokidar.watch(path, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
  });

  watcher.on('change', () => {
    logger.info('Config changed, hot-reloading…');
    try {
      const config = loadConfig(path);
      callback(config);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.error('Config reload failed', { error: e.message });
      callback({} as unknown as Config, e);
    }
  });

  watcher.on('error', (err) => {
    logger.error('Config watcher error', { error: String(err) });
  });

  return { stop: () => void watcher.close() };
}
