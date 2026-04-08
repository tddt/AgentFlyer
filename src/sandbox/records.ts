import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SandboxRuntimeProvider } from './types.js';

export interface SandboxRunRecord {
  runId: string;
  provider: SandboxRuntimeProvider;
  command: string;
  cwd: string;
  startedAt: number;
  finishedAt: number;
  exitCode: number | null;
  timedOut: boolean;
  ok: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  mirroredArtifacts: string[];
}

const MAX_SANDBOX_RUN_RECORDS = 100;

function sandboxRunsFile(dataDir: string): string {
  return join(dataDir, 'sandbox-runs.json');
}

function sandboxRunDir(dataDir: string, runId: string): string {
  return join(dataDir, 'sandbox', runId);
}

async function readSandboxRunsFile(dataDir: string): Promise<SandboxRunRecord[]> {
  const filePath = sandboxRunsFile(dataDir);
  if (!existsSync(filePath)) {
    return [];
  }
  try {
    return JSON.parse(await readFile(filePath, 'utf-8')) as SandboxRunRecord[];
  } catch {
    return [];
  }
}

async function writeSandboxRunsFile(dataDir: string, records: SandboxRunRecord[]): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(sandboxRunsFile(dataDir), JSON.stringify(records, null, 2), 'utf-8');
}

export async function persistSandboxRunRecord(
  dataDir: string | undefined,
  record: SandboxRunRecord,
  stdout: string,
  stderr: string,
): Promise<void> {
  if (!dataDir) {
    return;
  }

  const runDir = sandboxRunDir(dataDir, record.runId);
  await mkdir(runDir, { recursive: true });
  await Promise.all([
    writeFile(join(runDir, 'stdout.txt'), stdout, 'utf-8'),
    writeFile(join(runDir, 'stderr.txt'), stderr, 'utf-8'),
    writeFile(
      join(runDir, 'artifacts.json'),
      JSON.stringify(record.mirroredArtifacts, null, 2),
      'utf-8',
    ),
    writeFile(
      join(runDir, 'exit.json'),
      JSON.stringify(
        {
          exitCode: record.exitCode,
          timedOut: record.timedOut,
          ok: record.ok,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
        },
        null,
        2,
      ),
      'utf-8',
    ),
  ]);

  const existing = await readSandboxRunsFile(dataDir);
  const updated = [record, ...existing.filter((item) => item.runId !== record.runId)].slice(
    0,
    MAX_SANDBOX_RUN_RECORDS,
  );
  await writeSandboxRunsFile(dataDir, updated);
}
