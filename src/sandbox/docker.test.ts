import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { describe, expect, it, vi } from 'vitest';
import { type DockerCommandRunner, createDockerSandboxRuntime } from './docker.js';

function createTempDir(label: string): string {
  return join(process.cwd(), `.tmp-${label}-${ulid()}`);
}

describe('docker sandbox runtime', () => {
  it('runs commands through docker and persists docker run records', async () => {
    const dataDir = createTempDir('sandbox-docker');
    const commandRunner = vi
      .fn<DockerCommandRunner>()
      .mockResolvedValueOnce({
        stdout: '27.0.0',
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: '[{"Id":"sha256:test"}]',
        stderr: '',
      })
      .mockResolvedValueOnce({
        stdout: 'docker stdout',
        stderr: '',
      });
    const runtime = createDockerSandboxRuntime({
      dataDir,
      image: 'node:22-bookworm-slim',
      profile: {
        name: 'restricted',
        network: 'none',
        cpu: 1,
        memoryMb: 512,
        timeoutMs: 30_000,
        writableMounts: ['workspace:/workspace'],
        readOnlyMounts: [],
      },
      commandRunner,
    });

    const result = await runtime.execute({
      command: 'echo from-docker',
      cwd: process.cwd(),
      timeoutMs: 10_000,
      env: { HELLO: 'world' },
      workspaceDir: process.cwd(),
    });

    expect(result.ok).toBe(true);
    expect(result.provider).toBe('docker');
    expect(commandRunner).toHaveBeenNthCalledWith(
      1,
      'docker',
      ['version', '--format', '{{.Server.Version}}'],
      expect.objectContaining({ cwd: process.cwd(), timeout: 5_000 }),
    );
    expect(commandRunner).toHaveBeenNthCalledWith(
      2,
      'docker',
      ['image', 'inspect', 'node:22-bookworm-slim'],
      expect.objectContaining({ cwd: process.cwd(), timeout: 5_000 }),
    );
    expect(commandRunner).toHaveBeenNthCalledWith(
      3,
      'docker',
      expect.arrayContaining([
        'run',
        '--rm',
        '--init',
        '--network',
        'none',
        '--cpus',
        '1',
        '--memory',
        '512m',
        '-e',
        'HELLO=world',
        'node:22-bookworm-slim',
        'bash',
        '-lc',
        'echo from-docker',
      ]),
      expect.objectContaining({ cwd: process.cwd(), timeout: 10_000 }),
    );

    const records = JSON.parse(
      await readFile(join(dataDir, 'sandbox-runs.json'), 'utf-8'),
    ) as Array<{ provider: string; runId: string }>;
    expect(records[0]).toMatchObject({
      provider: 'docker',
      runId: result.runId,
    });
    await expect(
      readFile(join(dataDir, 'sandbox', result.runId, 'artifacts.json'), 'utf-8'),
    ).resolves.toBe('[]');
  });

  it('maps workspace and skills mounts from sandbox profile into docker args', async () => {
    const workspaceDir = createTempDir('sandbox-workspace');
    const skillDirA = join(workspaceDir, 'skills', 'writer');
    const skillDirB = join(workspaceDir, 'skills', 'research');
    const commandRunner = vi
      .fn<DockerCommandRunner>()
      .mockResolvedValueOnce({ stdout: '27.0.0', stderr: '' })
      .mockResolvedValueOnce({ stdout: '[{"Id":"sha256:test"}]', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'docker stdout', stderr: '' });
    const runtime = createDockerSandboxRuntime({
      image: 'node:22-bookworm-slim',
      profile: {
        name: 'restricted',
        network: 'none',
        cpu: 1,
        memoryMb: 512,
        timeoutMs: 30_000,
        writableMounts: ['workspace:/workspace'],
        readOnlyMounts: ['skills:/skills'],
      },
      commandRunner,
    });

    const result = await runtime.execute({
      command: 'pwd',
      cwd: join(workspaceDir, 'nested', 'dir'),
      timeoutMs: 10_000,
      workspaceDir,
      mirrorDirs: [skillDirA, skillDirB],
    });

    expect(result.ok).toBe(true);
    expect(commandRunner).toHaveBeenNthCalledWith(
      3,
      'docker',
      expect.arrayContaining([
        '--workdir',
        '/workspace/nested/dir',
        '-v',
        `${workspaceDir}:/workspace`,
        '-v',
        `${skillDirA}:/skills/writer:ro`,
        '-v',
        `${skillDirB}:/skills/research:ro`,
      ]),
      expect.anything(),
    );
  });

  it('respects read-only workspace mount profiles', async () => {
    const workspaceDir = createTempDir('sandbox-readonly-workspace');
    const commandRunner = vi
      .fn<DockerCommandRunner>()
      .mockResolvedValueOnce({ stdout: '27.0.0', stderr: '' })
      .mockResolvedValueOnce({ stdout: '[{"Id":"sha256:test"}]', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'docker stdout', stderr: '' });
    const runtime = createDockerSandboxRuntime({
      image: 'node:22-bookworm-slim',
      profile: {
        name: 'readonly',
        network: 'none',
        cpu: 1,
        memoryMb: 512,
        timeoutMs: 30_000,
        writableMounts: ['output:/workspace/output'],
        readOnlyMounts: ['workspace:/workspace'],
      },
      commandRunner,
    });

    await runtime.execute({
      command: 'pwd',
      cwd: workspaceDir,
      timeoutMs: 10_000,
      workspaceDir,
      outputDir: 'output',
    });

    expect(commandRunner).toHaveBeenNthCalledWith(
      3,
      'docker',
      expect.arrayContaining([
        '-v',
        `${workspaceDir}:/workspace:ro`,
        '-v',
        `${join(workspaceDir, 'output')}:/workspace/output`,
      ]),
      expect.anything(),
    );
  });

  it('maps output mount source to the agent output directory', async () => {
    const workspaceDir = createTempDir('sandbox-output-mount');
    const commandRunner = vi
      .fn<DockerCommandRunner>()
      .mockResolvedValueOnce({ stdout: '27.0.0', stderr: '' })
      .mockResolvedValueOnce({ stdout: '[{"Id":"sha256:test"}]', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'docker stdout', stderr: '' });
    const runtime = createDockerSandboxRuntime({
      image: 'node:22-bookworm-slim',
      profile: {
        name: 'output-only',
        network: 'none',
        cpu: 1,
        memoryMb: 512,
        timeoutMs: 30_000,
        writableMounts: ['output:/artifacts'],
        readOnlyMounts: ['workspace:/workspace'],
      },
      commandRunner,
    });

    await runtime.execute({
      command: 'pwd',
      cwd: workspaceDir,
      timeoutMs: 10_000,
      workspaceDir,
      outputDir: 'deliverables',
    });

    expect(commandRunner).toHaveBeenNthCalledWith(
      3,
      'docker',
      expect.arrayContaining(['-v', `${join(workspaceDir, 'deliverables')}:/artifacts`]),
      expect.anything(),
    );
  });

  it('returns a clear error when docker cli is unavailable', async () => {
    const runtime = createDockerSandboxRuntime({
      image: 'node:22-bookworm-slim',
      profile: {
        name: 'restricted',
        network: 'none',
        cpu: 1,
        memoryMb: 512,
        timeoutMs: 30_000,
        writableMounts: ['workspace:/workspace'],
        readOnlyMounts: [],
      },
      commandRunner: vi.fn<DockerCommandRunner>().mockRejectedValue({
        code: 'ENOENT',
        message: 'spawn docker ENOENT',
      }),
    });

    const result = await runtime.execute({
      command: 'echo from-docker',
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(false);
    expect(result.provider).toBe('docker');
    expect(result.stderr).toContain('Docker CLI binary was not found');
    expect(result.errorMessage).toContain('sandbox.provider=docker');
  });

  it('returns a clear error when docker image is unavailable locally', async () => {
    const runtime = createDockerSandboxRuntime({
      image: 'custom/agentflyer-sandbox:missing',
      profile: {
        name: 'restricted',
        network: 'none',
        cpu: 1,
        memoryMb: 512,
        timeoutMs: 30_000,
        writableMounts: ['workspace:/workspace'],
        readOnlyMounts: [],
      },
      commandRunner: vi
        .fn<DockerCommandRunner>()
        .mockResolvedValueOnce({
          stdout: '27.0.0',
          stderr: '',
        })
        .mockRejectedValueOnce({
          stderr: 'Error response from daemon: No such image: custom/agentflyer-sandbox:missing',
          message: 'image inspect failed',
        }),
    });

    const result = await runtime.execute({
      command: 'echo from-docker',
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(false);
    expect(result.provider).toBe('docker');
    expect(result.stderr).toContain('Sandbox docker image is not available locally');
    expect(result.stderr).toContain('docker pull custom/agentflyer-sandbox:missing');
  });

  it('fails fast when sandbox mount spec is invalid', async () => {
    const commandRunner = vi.fn<DockerCommandRunner>();
    const runtime = createDockerSandboxRuntime({
      image: 'node:22-bookworm-slim',
      profile: {
        name: 'invalid-spec',
        network: 'none',
        cpu: 1,
        memoryMb: 512,
        timeoutMs: 30_000,
        writableMounts: ['workspace'],
        readOnlyMounts: [],
      },
      commandRunner,
    });

    const result = await runtime.execute({
      command: 'pwd',
      cwd: process.cwd(),
      timeoutMs: 10_000,
      workspaceDir: process.cwd(),
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('Sandbox mount profile validation failed');
    expect(result.stderr).toContain('Invalid sandbox mount spec');
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it('fails fast when sandbox mounts conflict on the same container path', async () => {
    const commandRunner = vi.fn<DockerCommandRunner>();
    const runtime = createDockerSandboxRuntime({
      image: 'node:22-bookworm-slim',
      profile: {
        name: 'conflict',
        network: 'none',
        cpu: 1,
        memoryMb: 512,
        timeoutMs: 30_000,
        writableMounts: ['workspace:/workspace', 'output:/workspace'],
        readOnlyMounts: [],
      },
      commandRunner,
    });

    const result = await runtime.execute({
      command: 'pwd',
      cwd: process.cwd(),
      timeoutMs: 10_000,
      workspaceDir: process.cwd(),
      outputDir: 'output',
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('Conflicting sandbox mounts target the same container path');
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it('uses --network agentflyer-sandbox when egress-allowlist profile and network exists', async () => {
    const commandRunner = vi
      .fn<DockerCommandRunner>()
      .mockResolvedValueOnce({ stdout: '27.0.0', stderr: '' }) // version probe
      .mockResolvedValueOnce({ stdout: '[{"Id":"sha256:test"}]', stderr: '' }) // image inspect
      .mockResolvedValueOnce({ stdout: '[{}]', stderr: '' }) // network inspect — exists
      .mockResolvedValueOnce({ stdout: 'egress-stdout', stderr: '' }); // docker run
    const runtime = createDockerSandboxRuntime({
      image: 'node:22-bookworm-slim',
      profile: {
        name: 'egress-profile',
        network: 'egress-allowlist',
        cpu: 1,
        memoryMb: 512,
        timeoutMs: 30_000,
        writableMounts: ['workspace:/workspace'],
        readOnlyMounts: [],
      },
      commandRunner,
    });

    const result = await runtime.execute({
      command: 'echo hello',
      cwd: process.cwd(),
      timeoutMs: 10_000,
      workspaceDir: process.cwd(),
    });

    expect(result.ok).toBe(true);
    // Verify the network inspect was called for agentflyer-sandbox
    expect(commandRunner).toHaveBeenCalledWith(
      'docker',
      ['network', 'inspect', 'agentflyer-sandbox'],
      expect.objectContaining({ timeout: 5_000 }),
    );
    // Verify the docker run uses the named bridge, not the default bridge
    expect(commandRunner).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['--network', 'agentflyer-sandbox']),
      expect.anything(),
    );
  });

  it('creates egress network when it does not exist yet', async () => {
    const commandRunner = vi
      .fn<DockerCommandRunner>()
      .mockResolvedValueOnce({ stdout: '27.0.0', stderr: '' }) // version probe
      .mockResolvedValueOnce({ stdout: '[{"Id":"sha256:test"}]', stderr: '' }) // image inspect
      .mockRejectedValueOnce(new Error('No such network')) // network inspect — not found
      .mockResolvedValueOnce({ stdout: 'agentflyer-sandbox', stderr: '' }) // network create
      .mockResolvedValueOnce({ stdout: 'created-stdout', stderr: '' }); // docker run

    const runtime = createDockerSandboxRuntime({
      image: 'node:22-bookworm-slim',
      profile: {
        name: 'egress-profile',
        network: 'egress-allowlist',
        cpu: 1,
        memoryMb: 512,
        timeoutMs: 30_000,
        writableMounts: ['workspace:/workspace'],
        readOnlyMounts: [],
      },
      commandRunner,
    });

    const result = await runtime.execute({
      command: 'echo hello',
      cwd: process.cwd(),
      timeoutMs: 10_000,
      workspaceDir: process.cwd(),
    });

    expect(result.ok).toBe(true);
    // Verify network create was called with the stable bridge name
    expect(commandRunner).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['network', 'create', '--opt', 'com.docker.network.bridge.name=af_sandbox0', 'agentflyer-sandbox']),
      expect.anything(),
    );
  });

  it('captures docker run execution errors into result', async () => {
    const commandRunner = vi
      .fn<DockerCommandRunner>()
      .mockResolvedValueOnce({ stdout: '27.0.0', stderr: '' })
      .mockResolvedValueOnce({ stdout: '[{"Id":"sha256:test"}]', stderr: '' })
      .mockRejectedValueOnce({
        stdout: Buffer.from('partial output'),
        stderr: Buffer.from('command not found'),
        message: 'Process exited with code 127',
        code: 127,
        killed: false,
      });

    const runtime = createDockerSandboxRuntime({
      image: 'node:22-bookworm-slim',
      profile: {
        name: 'restricted',
        network: 'none',
        cpu: 1,
        memoryMb: 512,
        timeoutMs: 30_000,
        writableMounts: ['workspace:/workspace'],
        readOnlyMounts: [],
      },
      commandRunner,
    });

    const result = await runtime.execute({
      command: 'bad-command',
      cwd: process.cwd(),
      timeoutMs: 10_000,
      workspaceDir: process.cwd(),
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('command not found');
    expect(result.stdout).toContain('partial output');
    expect(result.errorMessage).toBe('Process exited with code 127');
  });
});
