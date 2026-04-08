import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SandboxConfig } from '../core/config/schema.js';
import { createLogger } from '../core/logger.js';
import { type DockerCommandRunner, createDockerSandboxRuntime } from './docker.js';
import { type ResolvedSandboxProfile, resolveSandboxProfile } from './policy.js';
import { captureMirrorState, decodeOutput, finalizeSandboxExecution } from './shared.js';
import type { SandboxRuntime } from './types.js';
export type {
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxRuntime,
  SandboxRuntimeProvider,
} from './types.js';

const logger = createLogger('sandbox:runtime');

export interface HostSandboxRuntimeOptions {
  dataDir?: string;
}

export interface CreateSandboxRuntimeOptions {
  dataDir?: string;
  config?: SandboxConfig;
  dockerCommandRunner?: DockerCommandRunner;
}

function stripPowerShellCliXml(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('#< CLIXML')) {
    return trimmed;
  }

  return trimmed
    .replace(/^#<\s*CLIXML\s*/u, '')
    .replace(/_x000D__x000A_/gu, '\n')
    .replace(/<Objs[^>]*>|<\/Objs>|<Obj[^>]*>|<MS>|<\/MS>/gu, '')
    .replace(/<S\s+S="Error">/gu, '')
    .replace(/<\/S>/gu, '\n')
    .replace(/<[^>]+>/gu, '')
    .trim();
}

function looksLikePowerShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }

  return (
    /(^|\s)(Get|Set|New|Remove|Invoke|ConvertTo|ConvertFrom|Select|Where|ForEach|Start|Stop|Test|Join|Split|Out)-[A-Za-z]/u.test(
      trimmed,
    ) ||
    /\$[A-Za-z_][A-Za-z0-9_:]*/u.test(trimmed) ||
    /\[[^\]]+\]::/u.test(trimmed) ||
    /\|\s*(Out-File|Out-String|Format-Table|Format-List|Select-Object)\b/u.test(trimmed) ||
    /(^|\s)(Write-Host|Write-Output|Write-Error|Write-Warning|Throw|try\s*\{|catch\s*\{|param\s*\()/u.test(
      trimmed,
    ) ||
    /(^|\s)\$?(true|false|null)\b/u.test(trimmed)
  );
}

function buildWindowsCmdCommand(command: string): { file: string; args: string[] } {
  return {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', `chcp 65001>nul & ${command}`],
  };
}

function buildWindowsCommand(command: string): { file: string; args: string[] } {
  const script = [
    '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    'chcp 65001 > $null',
    command,
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return {
    file: 'powershell.exe',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-OutputFormat',
      'Text',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encoded,
    ],
  };
}

function buildWindowsExecution(command: string): { file: string; args: string[] } {
  if (looksLikePowerShellCommand(command)) {
    return buildWindowsCommand(command);
  }
  return buildWindowsCmdCommand(command);
}

export function createHostSandboxRuntime(options: HostSandboxRuntimeOptions = {}): SandboxRuntime {
  const { dataDir } = options;
  const execAsync = promisify(exec);
  const execFileAsync = promisify(execFile);

  return {
    async execute(request) {
      const startedAt = Date.now();
      const mirrorState = await captureMirrorState(request.mirrorDirs ?? []);
      const execOptions = {
        cwd: request.cwd,
        timeout: request.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...(request.env ?? {}) },
        encoding: 'buffer' as const,
      };

      let stdout = '';
      let stderr = '';
      let exitCode: number | null = 0;
      let timedOut = false;
      let ok = true;
      let errorMessage: string | undefined;

      try {
        logger.info('Executing sandbox command', {
          provider: 'host',
          command: request.command,
          cwd: request.cwd,
        });

        const result =
          process.platform === 'win32'
            ? await execFileAsync(
                ...(() => {
                  const win = buildWindowsExecution(request.command);
                  return [win.file, win.args, execOptions] as const;
                })(),
              )
            : await execAsync(request.command, execOptions);

        stdout = stripPowerShellCliXml(decodeOutput(result.stdout));
        stderr = stripPowerShellCliXml(decodeOutput(result.stderr));
      } catch (error) {
        const execError = error as {
          stdout?: string | Buffer;
          stderr?: string | Buffer;
          message?: string;
          code?: number | string;
          killed?: boolean;
        };
        ok = false;
        stdout = stripPowerShellCliXml(decodeOutput(execError.stdout));
        stderr = stripPowerShellCliXml(decodeOutput(execError.stderr));
        exitCode = typeof execError.code === 'number' ? execError.code : null;
        timedOut = execError.killed === true;
        errorMessage = execError.message ?? String(error);
      }

      return finalizeSandboxExecution({
        dataDir,
        provider: 'host',
        request,
        startedAt,
        exitCode,
        timedOut,
        ok,
        stdout,
        stderr,
        errorMessage,
        mirrorState,
      });
    },
  };
}

export function createSandboxRuntime(options: CreateSandboxRuntimeOptions = {}): SandboxRuntime {
  const { dataDir, config, dockerCommandRunner } = options;

  if (config?.enabled && config.provider === 'docker') {
    return {
      async execute(request) {
        const startedAt = Date.now();
        let profile: ResolvedSandboxProfile;

        try {
          profile = resolveSandboxProfile(config, request.profileName);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn('Sandbox profile resolve failed', {
            profileName: request.profileName,
            message,
          });
          return finalizeSandboxExecution({
            dataDir,
            provider: 'docker',
            request,
            startedAt,
            stdout: '',
            stderr: message,
            exitCode: null,
            timedOut: false,
            ok: false,
            errorMessage: message,
          });
        }

        return createDockerSandboxRuntime({
          dataDir,
          image: config.image,
          profile,
          commandRunner: dockerCommandRunner,
        }).execute(request);
      },
    };
  }

  return createHostSandboxRuntime({ dataDir });
}
