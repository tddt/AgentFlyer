import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ulid } from 'ulid';
import { createLogger } from '../core/logger.js';
import { type SandboxRunRecord, persistSandboxRunRecord } from './records.js';
import type {
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxRuntimeProvider,
} from './types.js';

const logger = createLogger('sandbox:shared');

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

export interface SandboxMirrorState {
  normalizedMirrorDirs: string[];
  baselines: Map<string, FileSnapshotEntry>[];
}

export function decodeOutput(value: string | Buffer | undefined): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return value.toString('utf8');
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
  mirrorState?: SandboxMirrorState;
  startedAt: number;
}): Promise<string[]> {
  const { workspaceDir, outputDir, mirrorState, startedAt } = options;
  if (
    !workspaceDir ||
    !mirrorState ||
    mirrorState.normalizedMirrorDirs.length === 0 ||
    mirrorState.baselines.length !== mirrorState.normalizedMirrorDirs.length
  ) {
    return [];
  }

  const workspaceRoot = resolve(workspaceDir);
  const localOutputDir = outputDir && !isAbsolute(outputDir) ? outputDir : 'output';
  const mirrorRoot = join(workspaceRoot, localOutputDir, 'skill-artifacts');
  const mirrored: string[] = [];

  for (let index = 0; index < mirrorState.normalizedMirrorDirs.length; index += 1) {
    const skillDir = mirrorState.normalizedMirrorDirs[index];
    const baseline = mirrorState.baselines[index];
    if (!skillDir || !baseline) {
      continue;
    }

    const skillFolder = sanitizePathSegment(basename(skillDir));
    const candidates = await collectMirrorCandidates(skillDir, baseline, startedAt, skillDir);

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
      } catch (error) {
        logger.warn('Failed to mirror generated sandbox artifact', {
          source: candidate.filePath,
          destination,
          error: String(error),
        });
      }
    }
  }

  return mirrored;
}

export async function captureMirrorState(mirrorDirs: string[] = []): Promise<SandboxMirrorState> {
  const normalizedMirrorDirs = Array.from(new Set(mirrorDirs.map(normalizeDirPath)));
  const baselines = await Promise.all(normalizedMirrorDirs.map((dir) => snapshotFiles(dir)));
  return {
    normalizedMirrorDirs,
    baselines,
  };
}

export async function finalizeSandboxExecution(options: {
  dataDir?: string;
  provider: SandboxRuntimeProvider;
  request: SandboxExecutionRequest;
  startedAt: number;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  ok: boolean;
  errorMessage?: string;
  mirrorState?: SandboxMirrorState;
}): Promise<SandboxExecutionResult> {
  const {
    dataDir,
    provider,
    request,
    startedAt,
    stdout,
    stderr,
    exitCode,
    timedOut,
    ok,
    errorMessage,
    mirrorState,
  } = options;

  const mirroredArtifacts = await mirrorGeneratedArtifacts({
    workspaceDir: request.workspaceDir,
    outputDir: request.outputDir,
    mirrorState,
    startedAt,
  });
  const finishedAt = Date.now();
  const runId = ulid();
  const record: SandboxRunRecord = {
    runId,
    provider,
    command: request.command,
    cwd: request.cwd,
    startedAt,
    finishedAt,
    exitCode,
    timedOut,
    ok,
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    mirroredArtifacts,
  };
  await persistSandboxRunRecord(dataDir, record, stdout, stderr);

  return {
    runId,
    provider,
    startedAt,
    finishedAt,
    exitCode,
    timedOut,
    ok,
    stdout,
    stderr,
    mirroredArtifacts,
    errorMessage,
  };
}
