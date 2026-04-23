import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureDataDir,
  getDefaultConfigDir,
  getDefaultConfigPath,
  loadConfig,
  saveConfig,
} from '../../../src/core/config/loader.js';

const tempDirs: string[] = [];

function createTempDirSync(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentflyer-config-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  tempDirs.splice(0).forEach((d) => { try { rmSync(d, { recursive: true, force: true }); } catch {} });
});

const MINIMAL_V2_CONFIG = JSON.stringify({
  version: 2,
  models: {},
  agents: [],
});

describe('getDefaultConfigDir / getDefaultConfigPath', () => {
  it('getDefaultConfigDir returns a string ending in .agentflyer', () => {
    const dir = getDefaultConfigDir();
    expect(typeof dir).toBe('string');
    expect(dir).toContain('.agentflyer');
  });

  it('getDefaultConfigPath returns path ending in agentflyer.json', () => {
    const path = getDefaultConfigPath();
    expect(path.endsWith('agentflyer.json')).toBe(true);
  });
});

describe('loadConfig', () => {
  it('returns a default config when the file does not exist', () => {
    const dir = createTempDirSync();
    const configPath = join(dir, 'agentflyer.json');
    const config = loadConfig(configPath);
    expect(config.version).toBe(2);
    expect(Array.isArray(config.agents)).toBe(true);
  });

  it('writes a skeleton file when config does not exist', () => {
    const dir = createTempDirSync();
    const configPath = join(dir, 'agentflyer.json');
    loadConfig(configPath);
    expect(existsSync(configPath)).toBe(true);
  });

  it('loads a valid v2 config from disk', () => {
    const dir = createTempDirSync();
    const configPath = join(dir, 'agentflyer.json');
    writeFileSync(configPath, MINIMAL_V2_CONFIG, 'utf-8');
    const config = loadConfig(configPath);
    expect(config.version).toBe(2);
  });

  it('auto-migrates a v1 config to v2', () => {
    const dir = createTempDirSync();
    const configPath = join(dir, 'agentflyer.json');
    const v1Config = JSON.stringify({
      version: 1,
      agents: { list: [{ id: 'main', name: 'Main' }], defaults: {} },
    });
    writeFileSync(configPath, v1Config, 'utf-8');
    const config = loadConfig(configPath);
    expect(config.version).toBe(2);
    expect(config.agents.length).toBeGreaterThan(0);
  });

  it('throws on JSON parse error', () => {
    const dir = createTempDirSync();
    const configPath = join(dir, 'agentflyer.json');
    writeFileSync(configPath, 'NOT { valid json !!!', 'utf-8');
    expect(() => loadConfig(configPath)).toThrow(/JSON5 parse error/);
  });

  it('throws on schema validation failure', () => {
    const dir = createTempDirSync();
    const configPath = join(dir, 'agentflyer.json');
    // version must be 2 and agents must be an array — break agents
    writeFileSync(configPath, JSON.stringify({ version: 2, agents: 'BAD' }), 'utf-8');
    expect(() => loadConfig(configPath)).toThrow(/Config validation failed/);
  });
});

describe('saveConfig', () => {
  it('writes config to disk as JSON', async () => {
    const dir = createTempDirSync();
    const configPath = join(dir, 'config.json');
    const config = loadConfig(join(dir, 'initial.json')); // get a valid Config object
    await saveConfig(config, configPath);
    const raw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(2);
  });

  it('creates a backup (.bak) of existing config before overwrite', async () => {
    const dir = createTempDirSync();
    const configPath = join(dir, 'agentflyer.json');
    writeFileSync(configPath, MINIMAL_V2_CONFIG, 'utf-8');
    const config = loadConfig(configPath);
    await saveConfig(config, configPath);
    expect(existsSync(`${configPath}.bak`)).toBe(true);
  });
});

describe('ensureDataDir', () => {
  it('creates the expected subdirectory structure', () => {
    const dir = createTempDirSync();
    ensureDataDir(dir);
    for (const sub of ['agents', 'skills-cache', 'credentials', 'locks', 'cron', 'memory']) {
      expect(existsSync(join(dir, sub))).toBe(true);
    }
  });

  it('is idempotent — calling twice does not throw', () => {
    const dir = createTempDirSync();
    ensureDataDir(dir);
    expect(() => ensureDataDir(dir)).not.toThrow();
  });
});
