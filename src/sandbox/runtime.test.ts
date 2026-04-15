import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import type { DockerCommandRunner } from './docker.js';
import { createHostSandboxRuntime, createSandboxRuntime } from './runtime.js';

function createTempDir(label: string): string {
  return join(process.cwd(), `.tmp-${label}-${ulid()}`);
}

describe('sandbox runtime', () => {
  it('persists sandbox run records and output files', async () => {
    const dataDir = createTempDir('sandbox-runtime');

    const runtime = createHostSandboxRuntime({ dataDir });
    const nodeCommand = [
      "$ErrorActionPreference = 'Stop'",
      `& ${JSON.stringify(process.execPath)} -e \"console.log('sandbox-stdout'); console.error('sandbox-stderr')\"`,
    ].join('\n');

    const result = await runtime.execute({
      command: nodeCommand,
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('sandbox-stdout');
    expect(result.stderr).toContain('sandbox-stderr');

    const records = JSON.parse(
      await readFile(join(dataDir, 'sandbox-runs.json'), 'utf-8'),
    ) as Array<{ runId: string; ok: boolean; provider: string }>;
    expect(records[0]).toMatchObject({
      runId: result.runId,
      ok: true,
      provider: 'host',
    });

    await expect(
      readFile(join(dataDir, 'sandbox', result.runId, 'stdout.txt'), 'utf-8'),
    ).resolves.toContain('sandbox-stdout');
    await expect(
      readFile(join(dataDir, 'sandbox', result.runId, 'stderr.txt'), 'utf-8'),
    ).resolves.toContain('sandbox-stderr');
  }, 15_000);

  it('mirrors changed artifacts back into the workspace', async () => {
    const dataDir = createTempDir('sandbox-runtime-artifacts');
    const workspaceDir = join(dataDir, 'workspace');
    const skillDir = join(dataDir, 'skills', 'writer-skill');
    await mkdir(skillDir, { recursive: true });
    await mkdir(join(workspaceDir, 'output'), { recursive: true });
    await writeFile(join(skillDir, 'seed.txt'), 'before', 'utf-8');

    const runtime = createHostSandboxRuntime({ dataDir });
    const artifactPath = join(skillDir, 'report.txt');
    const nodeCommand = [
      "$ErrorActionPreference = 'Stop'",
      `Set-Content -Path ${JSON.stringify(artifactPath)} -Value 'artifact-from-sandbox'`,
    ].join('\n');
    const result = await runtime.execute({
      command: nodeCommand,
      cwd: process.cwd(),
      timeoutMs: 10_000,
      workspaceDir,
      outputDir: 'output',
      mirrorDirs: [skillDir],
    });

    expect(result.ok).toBe(true);
    expect(result.mirroredArtifacts).toEqual(['output/skill-artifacts/writer-skill--report.txt']);
    await expect(
      readFile(
        join(workspaceDir, 'output', 'skill-artifacts', 'writer-skill--report.txt'),
        'utf-8',
      ).then((content) => content.trim()),
    ).resolves.toBe('artifact-from-sandbox');
  }, 15_000);

  it('selects docker runtime when sandbox config enables docker provider', async () => {
    const runtime = createSandboxRuntime({
      config: {
        enabled: true,
        provider: 'docker',
        image: 'node:22-bookworm-slim',
        defaultProfile: 'restricted',
        profiles: {
          restricted: {
            network: 'none',
            cpu: 1,
            memoryMb: 512,
            timeoutMs: 30_000,
            writableMounts: ['workspace:/workspace'],
            readOnlyMounts: [],
          },
        },
      },
    });

    expect(runtime).not.toBe(createHostSandboxRuntime());
    expect(typeof runtime.execute).toBe('function');
  });

  it('resolves docker sandbox profile per request', async () => {
    const commandCalls: string[][] = [];
    const commandRunner: DockerCommandRunner = async (_file, args) => {
      commandCalls.push(args);
      if (args[0] === 'version') {
        return { stdout: '27.0.0', stderr: '' };
      }
      if (args[0] === 'image') {
        return { stdout: '[{"Id":"sha256:test"}]', stderr: '' };
      }
      return { stdout: 'ok', stderr: '' };
    };

    const runtime = createSandboxRuntime({
      config: {
        enabled: true,
        provider: 'docker',
        image: 'node:22-bookworm-slim',
        defaultProfile: 'restricted',
        profiles: {
          restricted: {
            network: 'none',
            cpu: 1,
            memoryMb: 512,
            timeoutMs: 30_000,
            writableMounts: ['workspace:/workspace'],
            readOnlyMounts: ['skills:/skills'],
          },
          'readonly-output': {
            network: 'none',
            cpu: 1,
            memoryMb: 512,
            timeoutMs: 30_000,
            writableMounts: ['output:/workspace/output'],
            readOnlyMounts: ['workspace:/workspace', 'skills:/skills'],
          },
        },
      },
      dockerCommandRunner: commandRunner,
    });

    const workspaceDir = createTempDir('sandbox-runtime-profile');
    const result = await runtime.execute({
      command: 'pwd',
      cwd: workspaceDir,
      timeoutMs: 10_000,
      workspaceDir,
      outputDir: 'output',
      profileName: 'readonly-output',
    });

    expect(result.ok).toBe(true);
    expect(commandCalls[2]).toContain(`${join(workspaceDir, 'output')}:/workspace/output`);
    expect(commandCalls[2]).toContain(`${workspaceDir}:/workspace:ro`);
  });

  it('returns a sandbox error when the requested docker profile is missing', async () => {
    const runtime = createSandboxRuntime({
      config: {
        enabled: true,
        provider: 'docker',
        image: 'node:22-bookworm-slim',
        defaultProfile: 'restricted',
        profiles: {
          restricted: {
            network: 'none',
            cpu: 1,
            memoryMb: 512,
            timeoutMs: 30_000,
            writableMounts: ['workspace:/workspace'],
            readOnlyMounts: [],
          },
        },
      },
    });

    const result = await runtime.execute({
      command: 'pwd',
      cwd: process.cwd(),
      timeoutMs: 10_000,
      profileName: 'missing-profile',
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('Sandbox profile not found: missing-profile');
  });
});
