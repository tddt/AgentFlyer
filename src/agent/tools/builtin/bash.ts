import { createLogger } from '../../../core/logger.js';
import { type SandboxRuntime, createHostSandboxRuntime } from '../../../sandbox/runtime.js';
import type { ApprovalHandler } from '../policy.js';
import type { RegisteredTool } from '../registry.js';

const logger = createLogger('tools:bash');

const DEFAULT_TIMEOUT_MS = 30_000;

export interface BashToolOptions {
  /** Working directory for command execution. */
  cwd?: string;
  /** Sandbox runtime used for command execution. */
  runtime?: SandboxRuntime;
  /** Data directory for sandbox run record persistence. */
  dataDir?: string;
  /** Agent workspace root for mirroring generated skill artifacts back into the workspace. */
  workspaceDir?: string;
  /** Agent output directory relative to the workspace. */
  outputDir?: string;
  /** Optional sandbox profile override for this tool instance. */
  sandboxProfile?: string;
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
    sandboxProfile,
    mirrorDirs = [],
    approvalHandler,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env = {},
    dataDir,
    runtime = createHostSandboxRuntime({ dataDir }),
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
      logger.info('Executing bash command', { command, cwd });
      const result = await runtime.execute({
        command,
        cwd: cwd ?? process.cwd(),
        timeoutMs: timeout,
        profileName: sandboxProfile,
        env,
        workspaceDir,
        outputDir,
        mirrorDirs,
      });

      let output = result.stdout;
      if (result.stderr) {
        output += (result.stdout ? '\n\nSTDERR:\n' : 'STDERR:\n') + result.stderr;
      }
      if (result.mirroredArtifacts.length > 0) {
        output += `${output ? '\n\n' : ''}Mirrored generated artifacts to workspace:\n${result.mirroredArtifacts.join('\n')}`;
      }

      if (!result.ok) {
        const msg = [output || result.errorMessage || 'Sandbox command failed']
          .filter(Boolean)
          .join('\n\n');
        logger.warn('Bash command failed', { command, error: msg, runId: result.runId });
        return { isError: true, content: msg };
      }

      return { isError: false, content: output || '(no output)' };
    },
  };
}
