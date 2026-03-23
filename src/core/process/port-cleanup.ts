import { spawnSync } from 'node:child_process';

type KillSignal = NodeJS.Signals | number;
type KillFn = (pid: number, signal?: KillSignal) => boolean;

interface CommandResult {
  error?: unknown;
  status: number | null;
  stdout: string;
}

interface PortCleanupOptions {
  platform?: NodeJS.Platform;
  currentPid?: number;
  spawnSyncImpl?: typeof spawnSync;
  killImpl?: KillFn;
  sleepImpl?: (ms: number) => void;
}

export interface PortCleanupResult {
  foundPids: number[];
  killedPids: number[];
  remainingPids: number[];
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const lock = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(lock, 0, 0, ms);
}

function parsePortFromAddress(address: string): number | null {
  const match = /:(\d+)$/.exec(address.trim());
  if (!match) return null;
  const value = match[1];
  if (!value) return null;
  const port = Number.parseInt(value, 10);
  return Number.isFinite(port) ? port : null;
}

export function parseWindowsListeningPids(
  stdout: string,
  port: number,
  currentPid = process.pid,
): number[] {
  const pids = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const protocol = parts[0];
    const localAddress = parts[1];
    const stateValue = parts[3];
    const pidValue = parts[4];
    if (
      !protocol ||
      !localAddress ||
      !stateValue ||
      !pidValue ||
      protocol.toUpperCase() !== 'TCP'
    ) {
      continue;
    }

    const localPort = parsePortFromAddress(localAddress);
    const state = stateValue.toUpperCase();
    const pid = Number.parseInt(pidValue, 10);
    if (localPort !== port || state !== 'LISTENING' || !Number.isFinite(pid) || pid <= 0) {
      continue;
    }
    if (pid !== currentPid) {
      pids.add(pid);
    }
  }
  return [...pids];
}

export function parseUnixListeningPids(stdout: string, currentPid = process.pid): number[] {
  const pids = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('p')) continue;
    const pid = Number.parseInt(trimmed.slice(1), 10);
    if (Number.isFinite(pid) && pid > 0 && pid !== currentPid) {
      pids.add(pid);
    }
  }
  return [...pids];
}

export function findListeningPidsOnPortSync(
  port: number,
  options: PortCleanupOptions = {},
): number[] {
  const platform = options.platform ?? process.platform;
  const currentPid = options.currentPid ?? process.pid;
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;

  if (platform === 'win32') {
    const result = spawnSyncImpl('netstat', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      timeout: 2000,
    }) as CommandResult;
    if (result.error || result.status !== 0) {
      return [];
    }
    return parseWindowsListeningPids(result.stdout, port, currentPid);
  }

  const result = spawnSyncImpl('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
    encoding: 'utf8',
    timeout: 5000,
  }) as CommandResult;
  if (result.error) {
    return [];
  }
  if (result.status === 1) {
    return [];
  }
  if (result.status !== 0) {
    return [];
  }
  return parseUnixListeningPids(result.stdout, currentPid);
}

export function killProcessTreeSync(pid: number, options: PortCleanupOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const sleepImpl = options.sleepImpl ?? sleepSync;

  if (platform === 'win32') {
    const result = spawnSyncImpl('taskkill', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      timeout: 10000,
    }) as CommandResult;
    return !result.error && result.status === 0;
  }

  try {
    killImpl(pid, 'SIGTERM');
  } catch {
    return false;
  }

  sleepImpl(200);

  try {
    killImpl(pid, 0);
    killImpl(pid, 'SIGKILL');
  } catch {
    return true;
  }

  return true;
}

export function freePortSync(port: number, options: PortCleanupOptions = {}): PortCleanupResult {
  const sleepImpl = options.sleepImpl ?? sleepSync;
  const foundPids = findListeningPidsOnPortSync(port, options);
  const killedPids: number[] = [];

  for (const pid of foundPids) {
    if (killProcessTreeSync(pid, options)) {
      killedPids.push(pid);
    }
  }

  if (killedPids.length > 0) {
    sleepImpl(1000);
  }

  const remainingPids = findListeningPidsOnPortSync(port, options);
  return {
    foundPids,
    killedPids,
    remainingPids,
  };
}
