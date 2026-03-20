import { createLogger } from '../../../core/logger.js';
import type { RegisteredTool } from '../registry.js';
import type { ApprovalHandler } from '../policy.js';

const logger = createLogger('tools:bash');

const DEFAULT_TIMEOUT_MS = 30_000;

export interface BashToolOptions {
  /** Working directory for command execution. */
  cwd?: string;
  /** Called before executing to ask the user — must return true to proceed. */
  approvalHandler?: ApprovalHandler;
  /** Max execution time in ms. Default 30 s. */
  timeoutMs?: number;
  /** Environment variables to inject into the subprocess. */
  env?: Record<string, string>;
}

export function createBashTool(opts: BashToolOptions = {}): RegisteredTool {
  const { cwd, approvalHandler, timeoutMs = DEFAULT_TIMEOUT_MS, env = {} } = opts;

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

      try {
        const { exec } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execAsync = promisify(exec);

        logger.info('Executing bash command', { command, cwd });
        const result = await execAsync(command, {
          cwd: cwd ?? process.cwd(),
          timeout,
          maxBuffer: 10 * 1024 * 1024, // 10 MB
          env: { ...process.env, ...env },
        });

        const stdout = result.stdout.trim();
        const stderr = result.stderr.trim();
        let output = stdout;
        if (stderr) output += (stdout ? '\n\nSTDERR:\n' : 'STDERR:\n') + stderr;
        return { isError: false, content: output || '(no output)' };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        const out = [e.stdout?.trim(), e.stderr?.trim()].filter(Boolean).join('\n');
        const msg = out || e.message || String(err);
        logger.warn('Bash command failed', { command, error: msg });
        return { isError: true, content: msg };
      }
    },
  };
}
