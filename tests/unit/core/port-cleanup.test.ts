import { describe, expect, it, vi } from 'vitest';
import {
  findListeningPidsOnPortSync,
  freePortSync,
  killProcessTreeSync,
  parseUnixListeningPids,
  parseWindowsListeningPids,
} from '../../../src/core/process/port-cleanup.js';

describe('port cleanup', () => {
  it('parses Windows netstat listeners for the target port', () => {
    const stdout = [
      '  TCP    0.0.0.0:19789     0.0.0.0:0      LISTENING       4321',
      '  TCP    [::]:19789        [::]:0         LISTENING       4321',
      '  TCP    0.0.0.0:3000      0.0.0.0:0      LISTENING       9999',
    ].join('\n');

    expect(parseWindowsListeningPids(stdout, 19789, 1234)).toEqual([4321]);
  });

  it('parses Unix lsof listeners', () => {
    const stdout = ['p2345', 'fcwd', 'p3456'].join('\n');
    expect(parseUnixListeningPids(stdout, 9999)).toEqual([2345, 3456]);
  });

  it('finds listeners through netstat on Windows', () => {
    const spawnSyncImpl = vi.fn().mockReturnValue({
      error: undefined,
      status: 0,
      stdout: '  TCP    127.0.0.1:19789   0.0.0.0:0      LISTENING       5432',
    });

    const pids = findListeningPidsOnPortSync(19789, {
      platform: 'win32',
      currentPid: 1,
      spawnSyncImpl,
    });

    expect(pids).toEqual([5432]);
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      'netstat',
      ['-ano', '-p', 'tcp'],
      expect.objectContaining({ encoding: 'utf8', timeout: 2000 }),
    );
  });

  it('kills process trees with taskkill on Windows', () => {
    const spawnSyncImpl = vi.fn().mockReturnValue({ error: undefined, status: 0, stdout: '' });

    expect(killProcessTreeSync(6543, { platform: 'win32', spawnSyncImpl })).toBe(true);
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '6543', '/T', '/F'],
      expect.objectContaining({ encoding: 'utf8', timeout: 10000 }),
    );
  });

  it('kills discovered listeners and reports the port as free', () => {
    const spawnSyncImpl = vi
      .fn()
      .mockReturnValueOnce({
        error: undefined,
        status: 0,
        stdout: '  TCP    127.0.0.1:19789   0.0.0.0:0      LISTENING       7777',
      })
      .mockReturnValueOnce({ error: undefined, status: 0, stdout: '' })
      .mockReturnValueOnce({ error: undefined, status: 0, stdout: '' });

    const result = freePortSync(19789, {
      platform: 'win32',
      currentPid: 1,
      spawnSyncImpl,
      sleepImpl: () => undefined,
    });

    expect(result).toEqual({
      foundPids: [7777],
      killedPids: [7777],
      remainingPids: [],
    });
  });
});