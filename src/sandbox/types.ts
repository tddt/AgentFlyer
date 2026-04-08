export type SandboxRuntimeProvider = 'host' | 'docker';

export interface SandboxExecutionRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
  profileName?: string;
  env?: Record<string, string>;
  workspaceDir?: string;
  outputDir?: string;
  mirrorDirs?: string[];
}

export interface SandboxExecutionResult {
  runId: string;
  provider: SandboxRuntimeProvider;
  startedAt: number;
  finishedAt: number;
  exitCode: number | null;
  timedOut: boolean;
  ok: boolean;
  stdout: string;
  stderr: string;
  mirroredArtifacts: string[];
  errorMessage?: string;
}

export interface SandboxRuntime {
  execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult>;
}
