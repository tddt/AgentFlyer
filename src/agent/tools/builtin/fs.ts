import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  stat,
  access,
} from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createLogger } from '../../../core/logger.js';
import type { RegisteredTool } from '../registry.js';

const logger = createLogger('tools:fs');

/** Recursively list directory up to `maxDepth`. */
async function listRecursive(
  dir: string,
  maxDepth: number,
  depth = 0,
): Promise<string[]> {
  if (depth > maxDepth) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const lines: string[] = [];
  for (const e of entries) {
    const prefix = '  '.repeat(depth);
    if (e.isDirectory()) {
      lines.push(`${prefix}${e.name}/`);
      const sub = await listRecursive(join(dir, e.name), maxDepth, depth + 1);
      lines.push(...sub);
    } else {
      lines.push(`${prefix}${e.name}`);
    }
  }
  return lines;
}

export function createFsTools(workspaceDir: string, allowedDirs: string[] = []): RegisteredTool[] {
  // Resolve workspace dir once for path validation
  const wsResolved = resolve(workspaceDir);
  // Additional read-allowed dirs (e.g. skill directories)
  const allowedResolved = allowedDirs.map((d) => resolve(d));

  function safeResolve(p: string, writeOp = false): string {
    // Absolute paths are used as-is (skill dirs pass absolute paths)
    const abs = resolve(wsResolved, p);
    if (abs.startsWith(wsResolved)) return abs;
    // For read-only ops, also allow configured extra dirs
    if (!writeOp && allowedResolved.some((d) => abs.startsWith(d))) return abs;
    throw new Error(`Path escapes workspace: ${p}`);
  }

  const readFileTool: RegisteredTool = {
    category: 'builtin',
    definition: {
      name: 'read_file',
      description: 'Read the contents of a file. Path is relative to the workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to workspace)' },
          start_line: { type: 'number', description: 'Optional 1-based start line' },
          end_line: { type: 'number', description: 'Optional 1-based end line (inclusive)' },
        },
        required: ['path'],
      },
    },
    async handler(input) {
      const { path, start_line, end_line } = input as {
        path: string;
        start_line?: number;
        end_line?: number;
      };
      const abs = safeResolve(path);
      const content = await readFile(abs, 'utf-8');
      if (start_line !== undefined || end_line !== undefined) {
        const lines = content.split('\n');
        const s = (start_line ?? 1) - 1;
        const e = end_line !== undefined ? end_line : lines.length;
        return { isError: false, content: lines.slice(s, e).join('\n') };
      }
      return { isError: false, content };
    },
  };

  const writeFileTool: RegisteredTool = {
    category: 'builtin',
    definition: {
      name: 'write_file',
      description: 'Write content to a file. Creates parent directories if needed.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to workspace)' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
    async handler(input) {
      const { path, content } = input as { path: string; content: string };
      const abs = safeResolve(path, true);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf-8');
      return { isError: false, content: `Written ${content.length} bytes to ${path}` };
    },
  };

  const listDirTool: RegisteredTool = {
    category: 'builtin',
    definition: {
      name: 'list_directory',
      description: 'List directory contents. Returns a tree view.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (relative to workspace, default ".")' },
          depth: { type: 'number', description: 'Max recursion depth (default 2, max 5)' },
        },
      },
    },
    async handler(input) {
      const { path = '.', depth = 2 } = (input ?? {}) as { path?: string; depth?: number };
      const abs = safeResolve(path);
      try {
        await access(abs);
      } catch {
        return { isError: true, content: `Directory not found: ${path}` };
      }
      const maxDepth = Math.min(Math.max(0, depth), 5);
      const lines = await listRecursive(abs, maxDepth);
      return { isError: false, content: `${path}/\n${lines.join('\n')}` };
    },
  };

  const statTool: RegisteredTool = {
    category: 'builtin',
    definition: {
      name: 'file_stat',
      description: 'Get metadata for a file or directory (size, mtime, type).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path (relative to workspace)' },
        },
        required: ['path'],
      },
    },
    async handler(input) {
      const { path } = input as { path: string };
      const abs = safeResolve(path);
      try {
        const s = await stat(abs);
        return {
          isError: false,
          content: JSON.stringify({
            path,
            size: s.size,
            isFile: s.isFile(),
            isDirectory: s.isDirectory(),
            mtime: s.mtime.toISOString(),
          }),
        };
      } catch (err) {
        return { isError: true, content: `stat failed: ${String(err)}` };
      }
    },
  };

  logger.debug('FS tools created', { workspace: wsResolved });
  return [readFileTool, writeFileTool, listDirTool, statTool];
}
