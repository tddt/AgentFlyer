import { describe, expect, it, vi } from 'vitest';
import { createBashTool } from './bash.js';

describe('bash tool', () => {
  it('delegates command execution to sandbox runtime', async () => {
    const execute = vi.fn().mockResolvedValue({
      runId: 'sandbox-run-1',
      provider: 'host',
      startedAt: 1,
      finishedAt: 2,
      exitCode: 0,
      timedOut: false,
      ok: true,
      stdout: 'sandbox stdout',
      stderr: '',
      mirroredArtifacts: [],
    });

    const tool = createBashTool({
      cwd: process.cwd(),
      sandboxProfile: 'readonly-output',
      runtime: { execute },
    });

    const result = await tool.handler({ command: 'echo hello' });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'echo hello',
        cwd: process.cwd(),
        profileName: 'readonly-output',
      }),
    );
    expect(result).toEqual({ isError: false, content: 'sandbox stdout' });
  });

  it('returns error output when sandbox runtime reports failure', async () => {
    const tool = createBashTool({
      cwd: process.cwd(),
      runtime: {
        execute: vi.fn().mockResolvedValue({
          runId: 'sandbox-run-2',
          provider: 'host',
          startedAt: 1,
          finishedAt: 2,
          exitCode: 1,
          timedOut: false,
          ok: false,
          stdout: 'partial stdout',
          stderr: 'broken stderr',
          mirroredArtifacts: ['output/skill-artifacts/demo.txt'],
          errorMessage: 'Command failed',
        }),
      },
    });

    const result = await tool.handler({ command: 'bad-command' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('partial stdout');
    expect(result.content).toContain('broken stderr');
    expect(result.content).toContain('Mirrored generated artifacts to workspace:');
  });
});
