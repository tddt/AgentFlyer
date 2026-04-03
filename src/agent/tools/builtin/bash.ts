import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createLogger } from '../../../core/logger.js';
import type { ApprovalHandler } from '../policy.js';
import type { RegisteredTool } from '../registry.js';

const logger = createLogger('tools:bash');

const DEFAULT_TIMEOUT_MS = 30_000;
const MIRROR_SCAN_MAX_DEPTH = 3;
const MIRROR_MAX_FILE_SIZE = 50 * 1024 * 1024;
const MIRROR_LOOKBACK_MS = 1_000;
const SKIP_SCAN_DIRS = new Set([
  '.git',
  '.idea',
  '.next',
  '.venv',
  '.vscode',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'venv',
]);

interface FileSnapshotEntry {
  mtimeMs: number;
  size: number;
}

interface MirrorCandidate {
  filePath: string;
  relativePath: string;
}

function decodeOutput(value: string | Buffer | undefined): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return value.toString('utf8');
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

function buildWindowsExecution(command: string): {
  file: string;
  args: string[];
  shell: 'cmd' | 'powershell';
} {
  if (looksLikePowerShellCommand(command)) {
    return { ...buildWindowsCommand(command), shell: 'powershell' };
  }
  return { ...buildWindowsCmdCommand(command), shell: 'cmd' };
}

function normalizeDirPath(dir: string): string {
  return resolve(dir).replace(/[\\/]+$/u, '');
}

function sanitizePathSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'file';
}

async function snapshotFiles(
  dir: string,
  depth = 0,
  maxDepth = MIRROR_SCAN_MAX_DEPTH,
  snapshot = new Map<string, FileSnapshotEntry>(),
): Promise<Map<string, FileSnapshotEntry>> {
  if (depth > maxDepth) {
    return snapshot;
  }

  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    return snapshot;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.DS_Store')) {
      continue;
    }

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_SCAN_DIRS.has(entry.name)) {
        continue;
      }
      await snapshotFiles(fullPath, depth + 1, maxDepth, snapshot);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    try {
      const fileStat = await stat(fullPath);
      snapshot.set(fullPath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size });
    } catch {
      // Ignore files that disappear between directory scan and stat.
    }
  }

  return snapshot;
}

async function collectMirrorCandidates(
  dir: string,
  baseline: Map<string, FileSnapshotEntry>,
  startedAt: number,
  rootDir: string,
  depth = 0,
  maxDepth = MIRROR_SCAN_MAX_DEPTH,
  seen = new Set<string>(),
): Promise<MirrorCandidate[]> {
  if (depth > maxDepth) {
    return [];
  }

  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    return [];
  }

  const results: MirrorCandidate[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_SCAN_DIRS.has(entry.name)) {
        continue;
      }
      results.push(
        ...(await collectMirrorCandidates(
          fullPath,
          baseline,
          startedAt,
          rootDir,
          depth + 1,
          maxDepth,
          seen,
        )),
      );
      continue;
    }

    if (!entry.isFile() || seen.has(fullPath)) {
      continue;
    }

    try {
      const fileStat = await stat(fullPath);
      if (fileStat.size > MIRROR_MAX_FILE_SIZE) {
        continue;
      }
      if (fileStat.mtimeMs < startedAt - MIRROR_LOOKBACK_MS) {
        continue;
      }
      const previous = baseline.get(fullPath);
      const changed =
        !previous || previous.mtimeMs !== fileStat.mtimeMs || previous.size !== fileStat.size;
      if (!changed) {
        continue;
      }
      seen.add(fullPath);
      results.push({
        filePath: fullPath,
        relativePath: relative(rootDir, fullPath),
      });
    } catch {
      // Ignore files that disappear between directory scan and stat.
    }
  }

  return results;
}

async function mirrorGeneratedArtifacts(options: {
  workspaceDir?: string;
  outputDir?: string;
  mirrorDirs: string[];
  startedAt: number;
  baselines: Map<string, FileSnapshotEntry>[];
}): Promise<string[]> {
  const { workspaceDir, outputDir, mirrorDirs, startedAt, baselines } = options;
  if (!workspaceDir || mirrorDirs.length === 0 || baselines.length !== mirrorDirs.length) {
    return [];
  }

  const workspaceRoot = resolve(workspaceDir);
  const localOutputDir = outputDir && !isAbsolute(outputDir) ? outputDir : 'output';
  const mirrorRoot = join(workspaceRoot, localOutputDir, 'skill-artifacts');
  const mirrored: string[] = [];

  for (let index = 0; index < mirrorDirs.length; index += 1) {
    const skillDir = mirrorDirs[index];
    const baseline = baselines[index];
    if (!skillDir || !baseline) {
      continue;
    }

    const rootDir = normalizeDirPath(skillDir);
    const skillFolder = sanitizePathSegment(basename(rootDir));
    const candidates = await collectMirrorCandidates(rootDir, baseline, startedAt, rootDir);

    for (const candidate of candidates) {
      const flattened = candidate.relativePath
        .split(/[\\/]+/u)
        .map(sanitizePathSegment)
        .join('__');
      const destination = join(mirrorRoot, `${skillFolder}--${flattened}`);
      try {
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(candidate.filePath, destination);
        mirrored.push(relative(workspaceRoot, destination).split(sep).join('/'));
      } catch (err) {
        logger.warn('Failed to mirror generated skill artifact', {
          source: candidate.filePath,
          destination,
          error: String(err),
        });
      }
    }
  }

  return mirrored;
}

export interface BashToolOptions {
  /** Working directory for command execution. */
  cwd?: string;
  /** Agent workspace root for mirroring generated skill artifacts back into the workspace. */
  workspaceDir?: string;
  /** Agent output directory relative to the workspace. */
  outputDir?: string;
  /** Skill directories whose generated artifacts should be mirrored back into the workspace. */
  mirrorDirs?: string[];
  /** Called before executing to ask the user — must return true to proceed. */
  approvalHandler?: ApprovalHandler;
  /** Max execution time in ms. Default 30 s. */
  timeoutMs?: number;
  /** Environment variables to inject into the subprocess. */
  env?: Record<string, string>;
}

export function createBashTool(opts: BashToolOptions = {}): RegisteredTool {
  const {
    cwd,
    workspaceDir,
    outputDir,
    mirrorDirs = [],
    approvalHandler,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env = {},
  } = opts;

  return {
    category: 'builtin',
    definition: {
      name: 'bash',
      description:
        'Execute a shell command in the workspace. ' +
        'Requires user approval unless running in auto-approve mode. ' +
        'Avoid interactive commands or long-running processes.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
          timeout_ms: {
            type: 'number',
            description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})`,
          },
        },
        required: ['command'],
      },
    },
    async handler(input) {
      const { command, timeout_ms } = input as { command: string; timeout_ms?: number };

      if (approvalHandler) {
        const approved = await approvalHandler('bash', { command });
        if (!approved) {
          return { isError: true, content: 'Command not approved by user' };
        }
      }

      const timeout = timeout_ms ?? timeoutMs;
      const startedAt = Date.now();
      const normalizedMirrorDirs = Array.from(new Set(mirrorDirs.map(normalizeDirPath)));
      const baselines = await Promise.all(normalizedMirrorDirs.map((dir) => snapshotFiles(dir)));

      try {
        const { exec, execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execAsync = promisify(exec);
        const execFileAsync = promisify(execFile);

        logger.info('Executing bash command', { command, cwd });
        const result =
          process.platform === 'win32'
            ? await execFileAsync(
                ...(() => {
                  const win = buildWindowsExecution(command);
                  return [
                    win.file,
                    win.args,
                    {
                      cwd: cwd ?? process.cwd(),
                      timeout,
                      maxBuffer: 10 * 1024 * 1024,
                      env: { ...process.env, ...env },
                      encoding: 'buffer' as const,
                    },
                  ] as const;
                })(),
              )
            : await execAsync(command, {
                cwd: cwd ?? process.cwd(),
                timeout,
                maxBuffer: 10 * 1024 * 1024,
                env: { ...process.env, ...env },
              });

        const stdout = stripPowerShellCliXml(decodeOutput(result.stdout));
        const stderr = stripPowerShellCliXml(decodeOutput(result.stderr));
        const mirrored = await mirrorGeneratedArtifacts({
          workspaceDir,
          outputDir,
          mirrorDirs: normalizedMirrorDirs,
          startedAt,
          baselines,
        });
        let output = stdout;
        if (stderr) output += (stdout ? '\n\nSTDERR:\n' : 'STDERR:\n') + stderr;
        if (mirrored.length > 0) {
          output += `${output ? '\n\n' : ''}Mirrored generated artifacts to workspace:\n${mirrored.join('\n')}`;
        }
        return { isError: false, content: output || '(no output)' };
      } catch (err) {
        const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
        const mirrored = await mirrorGeneratedArtifacts({
          workspaceDir,
          outputDir,
          mirrorDirs: normalizedMirrorDirs,
          startedAt,
          baselines,
        });
        const out = [
          stripPowerShellCliXml(decodeOutput(e.stdout)),
          stripPowerShellCliXml(decodeOutput(e.stderr)),
        ]
          .filter(Boolean)
          .join('\n');
        const msg = [
          out || e.message || String(err),
          mirrored.length > 0
            ? `Mirrored generated artifacts to workspace:\n${mirrored.join('\n')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n');
        logger.warn('Bash command failed', { command, error: msg });
        return { isError: true, content: msg };
      }
    },
  };
}
