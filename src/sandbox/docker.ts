import { execFile } from 'node:child_process';
import { basename, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '../core/logger.js';
import type { ResolvedSandboxProfile } from './policy.js';
import { captureMirrorState, decodeOutput, finalizeSandboxExecution } from './shared.js';
import type { SandboxRuntime } from './types.js';

const logger = createLogger('sandbox:docker');
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export interface DockerCommandRunnerOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
  encoding: 'buffer';
}

export type DockerCommandRunner = (
  file: string,
  args: string[],
  options: DockerCommandRunnerOptions,
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

export interface DockerSandboxRuntimeOptions {
  dataDir?: string;
  image?: string;
  binary?: string;
  profile: ResolvedSandboxProfile;
  commandRunner?: DockerCommandRunner;
}

interface DockerProbeResult {
  ok: boolean;
  message?: string;
}

interface DockerMount {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

interface DockerMountPlan {
  mounts: DockerMount[];
  containerCwd: string;
}

const SUPPORTED_MOUNT_SOURCES = ['workspace', 'skills', 'output'] as const;

function formatDockerMountPlanError(profileName: string, errors: string[]): string {
  return [
    `Sandbox mount profile validation failed: ${profileName}`,
    ...errors.map((error, index) => `${index + 1}. ${error}`),
  ].join('\n');
}

function toContainerPath(path: string): string {
  return path.split(sep).join('/');
}

function sanitizeContainerSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'mount';
}

function ensureContainerPath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

function splitMountSpec(spec: string): { source: string; target: string } | null {
  const separator = spec.indexOf(':');
  if (separator <= 0 || separator === spec.length - 1) {
    return null;
  }
  return {
    source: spec.slice(0, separator).trim(),
    target: ensureContainerPath(spec.slice(separator + 1).trim()),
  };
}

function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function addMount(mounts: DockerMount[], next: DockerMount, errors: string[]): void {
  const conflictingTarget = mounts.find(
    (mount) => mount.containerPath === next.containerPath && mount.hostPath !== next.hostPath,
  );
  if (conflictingTarget) {
    errors.push(
      [
        'Conflicting sandbox mounts target the same container path',
        `${conflictingTarget.hostPath} -> ${conflictingTarget.containerPath}`,
        `${next.hostPath} -> ${next.containerPath}`,
      ].join(': '),
    );
    return;
  }

  const existingIndex = mounts.findIndex(
    (mount) => mount.hostPath === next.hostPath && mount.containerPath === next.containerPath,
  );
  if (existingIndex === -1) {
    mounts.push(next);
    return;
  }

  if (!next.readOnly) {
    mounts[existingIndex] = next;
  }
}

function expandSkillsMounts(
  mirrorDirs: string[],
  targetRoot: string,
  readOnly: boolean,
): DockerMount[] {
  const counts = new Map<string, number>();
  const mounts: DockerMount[] = [];

  for (const dir of Array.from(new Set(mirrorDirs.map((item) => resolve(item))))) {
    const baseName = sanitizeContainerSegment(basename(dir));
    const seen = (counts.get(baseName) ?? 0) + 1;
    counts.set(baseName, seen);
    const suffix = seen === 1 ? baseName : `${baseName}-${seen}`;
    mounts.push({
      hostPath: dir,
      containerPath: `${targetRoot}/${suffix}`,
      readOnly,
    });
  }

  return mounts;
}

function resolveOutputHostPath(workspaceDir: string, outputDir?: string): string {
  if (!outputDir) {
    return resolve(workspaceDir, 'output');
  }
  return resolve(workspaceDir, outputDir);
}

function resolveDockerMountPlan(options: {
  cwd: string;
  workspaceDir?: string;
  outputDir?: string;
  mirrorDirs?: string[];
  profile: ResolvedSandboxProfile;
}): DockerMountPlan {
  const cwd = resolve(options.cwd);
  const workspaceDir = resolve(options.workspaceDir ?? options.cwd);
  const outputHostPath = resolveOutputHostPath(workspaceDir, options.outputDir);
  const mirrorDirs = options.mirrorDirs ?? [];
  const mounts: DockerMount[] = [];
  const errors: string[] = [];
  let workspaceContainerRoot = '/workspace';

  const applySpecs = (specs: string[], readOnly: boolean): void => {
    for (const spec of specs) {
      const parsed = splitMountSpec(spec);
      if (!parsed) {
        errors.push(`Invalid sandbox mount spec "${spec}". Expected "<source>:<containerPath>".`);
        continue;
      }

      if (parsed.source === 'workspace') {
        workspaceContainerRoot = parsed.target;
        addMount(
          mounts,
          {
            hostPath: workspaceDir,
            containerPath: parsed.target,
            readOnly,
          },
          errors,
        );
        continue;
      }

      if (parsed.source === 'skills') {
        for (const mount of expandSkillsMounts(mirrorDirs, parsed.target, readOnly)) {
          addMount(mounts, mount, errors);
        }
        continue;
      }

      if (parsed.source === 'output') {
        addMount(
          mounts,
          {
            hostPath: outputHostPath,
            containerPath: parsed.target,
            readOnly,
          },
          errors,
        );
        continue;
      }

      errors.push(
        `Unsupported sandbox mount source "${parsed.source}". Supported sources: ${SUPPORTED_MOUNT_SOURCES.join(', ')}.`,
      );
    }
  };

  applySpecs(options.profile.readOnlyMounts, true);
  applySpecs(options.profile.writableMounts, false);

  if (!mounts.some((mount) => mount.hostPath === workspaceDir)) {
    addMount(
      mounts,
      {
        hostPath: workspaceDir,
        containerPath: workspaceContainerRoot,
        readOnly: false,
      },
      errors,
    );
  }

  if (!isWithin(workspaceDir, cwd)) {
    addMount(
      mounts,
      {
        hostPath: cwd,
        containerPath: '/cwd',
        readOnly: false,
      },
      errors,
    );
    if (errors.length > 0) {
      throw new Error(formatDockerMountPlanError(options.profile.name, errors));
    }
    return {
      mounts,
      containerCwd: '/cwd',
    };
  }

  if (errors.length > 0) {
    throw new Error(formatDockerMountPlanError(options.profile.name, errors));
  }

  const relativeCwd = relative(workspaceDir, cwd);
  return {
    mounts,
    containerCwd: relativeCwd
      ? `${workspaceContainerRoot}/${toContainerPath(relativeCwd)}`
      : workspaceContainerRoot,
  };
}

function createDefaultDockerCommandRunner(): DockerCommandRunner {
  const execFileAsync = promisify(execFile);
  return (file, args, options) => execFileAsync(file, args, options);
}

function formatDockerProbeError(binary: string, error: unknown): string {
  const probeError = error as {
    code?: string | number;
    message?: string;
    stderr?: string | Buffer;
  };
  const stderr = decodeOutput(probeError.stderr).trim();

  if (probeError.code === 'ENOENT') {
    return [
      `Sandbox docker provider is enabled, but the Docker CLI binary was not found: ${binary}`,
      'Install Docker Desktop or configure a reachable docker CLI before enabling sandbox.provider=docker.',
    ].join('\n');
  }

  if (stderr) {
    return [
      'Sandbox docker provider is enabled, but Docker is not ready to serve sandbox commands.',
      stderr,
    ].join('\n\n');
  }

  return [
    'Sandbox docker provider is enabled, but Docker is not ready to serve sandbox commands.',
    probeError.message ?? String(error),
  ].join('\n\n');
}

async function probeDockerAvailability(options: {
  binary: string;
  cwd: string;
  commandRunner: DockerCommandRunner;
}): Promise<DockerProbeResult> {
  const { binary, cwd, commandRunner } = options;
  try {
    await commandRunner(binary, ['version', '--format', '{{.Server.Version}}'], {
      cwd,
      timeout: 5_000,
      maxBuffer: 512 * 1024,
      env: process.env,
      encoding: 'buffer',
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: formatDockerProbeError(binary, error),
    };
  }
}

function formatDockerImageProbeError(image: string, error: unknown): string {
  const probeError = error as {
    message?: string;
    stderr?: string | Buffer;
  };
  const stderr = decodeOutput(probeError.stderr).trim();
  const combined = `${probeError.message ?? ''}\n${stderr}`.toLowerCase();

  if (
    combined.includes('no such image') ||
    combined.includes('not found') ||
    combined.includes('unable to find image')
  ) {
    return [
      `Sandbox docker image is not available locally: ${image}`,
      `Pull or build the image before enabling sandbox.provider=docker. Example: docker pull ${image}`,
    ].join('\n');
  }

  if (stderr) {
    return [`Sandbox docker image probe failed for: ${image}`, stderr].join('\n\n');
  }

  return [
    `Sandbox docker image probe failed for: ${image}`,
    probeError.message ?? String(error),
  ].join('\n\n');
}

async function probeDockerImage(options: {
  binary: string;
  cwd: string;
  image: string;
  commandRunner: DockerCommandRunner;
}): Promise<DockerProbeResult> {
  const { binary, cwd, image, commandRunner } = options;
  try {
    await commandRunner(binary, ['image', 'inspect', image], {
      cwd,
      timeout: 5_000,
      maxBuffer: 512 * 1024,
      env: process.env,
      encoding: 'buffer',
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: formatDockerImageProbeError(image, error),
    };
  }
}

// RATIONALE: Use a dedicated user-defined bridge for egress-allowlist containers.
// This isolates them from the default Docker bridge and provides a stable interface
// name (af_sandbox0) that operators can target with iptables rules to restrict
// outbound traffic to specific subnets/hosts at the host level.
const EGRESS_SANDBOX_NETWORK = 'agentflyer-sandbox';

async function ensureDockerEgressNetwork(options: {
  binary: string;
  cwd: string;
  commandRunner: DockerCommandRunner;
}): Promise<void> {
  const { binary, cwd, commandRunner } = options;
  try {
    // Check if the network already exists
    await commandRunner(binary, ['network', 'inspect', EGRESS_SANDBOX_NETWORK], {
      cwd,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      env: process.env,
      encoding: 'buffer',
    });
  } catch {
    // Network does not exist — create it with a stable bridge name for iptables targeting
    logger.info('Creating sandbox egress network', { network: EGRESS_SANDBOX_NETWORK });
    try {
      await commandRunner(
        binary,
        [
          'network',
          'create',
          '--driver',
          'bridge',
          '--opt',
          'com.docker.network.bridge.name=af_sandbox0',
          EGRESS_SANDBOX_NETWORK,
        ],
        {
          cwd,
          timeout: 15_000,
          maxBuffer: 64 * 1024,
          env: process.env,
          encoding: 'buffer',
        },
      );
      logger.info(
        'Sandbox egress network ready. To restrict outbound traffic add iptables rules on bridge af_sandbox0.',
        { network: EGRESS_SANDBOX_NETWORK },
      );
    } catch (createError) {
      logger.warn('Failed to create sandbox egress network; container will use host bridge', {
        network: EGRESS_SANDBOX_NETWORK,
        error: createError instanceof Error ? createError.message : String(createError),
      });
    }
  }
}

function buildDockerRunArgs(options: {
  image: string;
  profile: ResolvedSandboxProfile;
  mounts: DockerMount[];
  containerCwd: string;
  command: string;
  env: Record<string, string>;
}): string[] {
  const { image, profile, mounts, containerCwd, command, env } = options;
  const args = ['run', '--rm', '--init', '--workdir', containerCwd];

  if (profile.network === 'none') {
    args.push('--network', 'none');
  } else if (profile.network === 'egress-allowlist') {
    // Uses the dedicated agentflyer-sandbox bridge (ensured before container run).
    // Operators can apply iptables rules on bridge af_sandbox0 to restrict egress.
    args.push('--network', EGRESS_SANDBOX_NETWORK);
  }

  args.push('--cpus', String(profile.cpu));
  args.push('--memory', `${profile.memoryMb}m`);

  for (const mount of mounts) {
    args.push('-v', `${mount.hostPath}:${mount.containerPath}${mount.readOnly ? ':ro' : ''}`);
  }

  for (const [key, value] of Object.entries(env)) {
    args.push('-e', `${key}=${value}`);
  }

  args.push(image, 'bash', '-lc', command);
  return args;
}

export function createDockerSandboxRuntime(options: DockerSandboxRuntimeOptions): SandboxRuntime {
  const {
    dataDir,
    image = 'node:22-bookworm-slim',
    binary = 'docker',
    profile,
    commandRunner = createDefaultDockerCommandRunner(),
  } = options;

  return {
    async execute(request) {
      const startedAt = Date.now();
      const timeoutMs = Math.min(request.timeoutMs, profile.timeoutMs);
      let mountPlan: DockerMountPlan;

      try {
        mountPlan = resolveDockerMountPlan({
          cwd: request.cwd,
          workspaceDir: request.workspaceDir,
          outputDir: request.outputDir,
          mirrorDirs: request.mirrorDirs,
          profile,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('Docker sandbox mount plan invalid', {
          profile: profile.name,
          message,
        });
        return finalizeSandboxExecution({
          dataDir,
          provider: 'docker',
          request: {
            ...request,
            timeoutMs,
          },
          startedAt,
          stdout: '',
          stderr: message,
          exitCode: null,
          timedOut: false,
          ok: false,
          errorMessage: message,
        });
      }

      const probe = await probeDockerAvailability({
        binary,
        cwd: request.cwd,
        commandRunner,
      });
      if (!probe.ok) {
        logger.warn('Docker sandbox provider unavailable', {
          binary,
          profile: profile.name,
          message: probe.message,
        });
        return finalizeSandboxExecution({
          dataDir,
          provider: 'docker',
          request: {
            ...request,
            timeoutMs,
          },
          startedAt,
          stdout: '',
          stderr: probe.message ?? 'Docker sandbox provider is unavailable',
          exitCode: null,
          timedOut: false,
          ok: false,
          errorMessage: probe.message,
        });
      }

      const imageProbe = await probeDockerImage({
        binary,
        cwd: request.cwd,
        image,
        commandRunner,
      });
      if (!imageProbe.ok) {
        logger.warn('Docker sandbox image unavailable', {
          binary,
          image,
          profile: profile.name,
          message: imageProbe.message,
        });
        return finalizeSandboxExecution({
          dataDir,
          provider: 'docker',
          request: {
            ...request,
            timeoutMs,
          },
          startedAt,
          stdout: '',
          stderr: imageProbe.message ?? 'Docker sandbox image is unavailable',
          exitCode: null,
          timedOut: false,
          ok: false,
          errorMessage: imageProbe.message,
        });
      }

      const mirrorState = await captureMirrorState(request.mirrorDirs ?? []);

      if (profile.network === 'egress-allowlist') {
        await ensureDockerEgressNetwork({ binary, cwd: request.cwd, commandRunner });
      }

      const env = { ...(request.env ?? {}) };
      const { mounts, containerCwd } = mountPlan;
      const dockerArgs = buildDockerRunArgs({
        image,
        profile,
        mounts,
        containerCwd,
        command: request.command,
        env,
      });

      let stdout = '';
      let stderr = '';
      let exitCode: number | null = 0;
      let timedOut = false;
      let ok = true;
      let errorMessage: string | undefined;

      try {
        logger.info('Executing sandbox command', {
          provider: 'docker',
          image,
          profile: profile.name,
          cwd: request.cwd,
          command: request.command,
        });

        const result = await commandRunner(binary, dockerArgs, {
          cwd: request.cwd,
          timeout: timeoutMs,
          maxBuffer: MAX_BUFFER_BYTES,
          env: { ...process.env, ...env },
          encoding: 'buffer',
        });
        stdout = decodeOutput(result.stdout);
        stderr = decodeOutput(result.stderr);
      } catch (error) {
        const execError = error as {
          stdout?: string | Buffer;
          stderr?: string | Buffer;
          message?: string;
          code?: number | string;
          killed?: boolean;
        };
        ok = false;
        stdout = decodeOutput(execError.stdout);
        stderr = decodeOutput(execError.stderr);
        exitCode = typeof execError.code === 'number' ? execError.code : null;
        timedOut = execError.killed === true;
        errorMessage = execError.message ?? String(error);
      }

      return finalizeSandboxExecution({
        dataDir,
        provider: 'docker',
        request: {
          ...request,
          timeoutMs,
        },
        startedAt,
        stdout,
        stderr,
        exitCode,
        timedOut,
        ok,
        errorMessage,
        mirrorState,
      });
    },
  };
}
