/**
 * channel-tools — tools that let an agent send text or files to registered channels.
 *
 * Two tools are provided:
 *   send_text_to_channel   — send a plain-text message to a channel thread
 *   send_file_to_channel   — send a file/image from the agent's workspace to a channel thread
 */
import { existsSync } from 'node:fs';
import { resolve, basename, extname } from 'node:path';
import { createLogger } from '../../../core/logger.js';
import type { Channel } from '../../../channels/types.js';
import type { AgentId, ThreadKey } from '../../../core/types.js';
import type { RegisteredTool } from '../registry.js';

const logger = createLogger('tools:channel');

// ── MIME helper (no external dep) ─────────────────────────────────────────────

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',  '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',  '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav',   '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
};

function mimeForFile(filePath: string): string {
  return EXT_MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export interface ChannelToolDeps {
  /** Live channel map (same reference held by gateway/lifecycle). */
  channels: Map<string, Channel>;
  /** This agent's id — used as the sender identity for channel targets. */
  agentId: AgentId;
  /** Workspace root — file paths are resolved relative to this. */
  workspaceDir: string;
}

export function createChannelTools(deps: ChannelToolDeps): RegisteredTool[] {
  const { channels, agentId, workspaceDir } = deps;

  // ── send_text_to_channel ──────────────────────────────────────────────────

  const sendTextTool: RegisteredTool = {
    category: 'builtin',
    definition: {
      name: 'send_text_to_channel',
      description:
        'Send a plain-text message to a communication channel (e.g. feishu, telegram, discord, qq). ' +
        'Use this when you want to push a summary, notification or reply to an external chat.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description:
              'Target channel identifier. Known values: "feishu", "telegram", "discord", "qq". ' +
              'Use "all" to broadcast to every active channel.',
          },
          thread_key: {
            type: 'string',
            description:
              'Thread / chat key to deliver the message to, e.g. "feishu:oc_xxxxx". ' +
              'Leave empty to have each channel use its default/last-active thread.',
          },
          text: {
            type: 'string',
            description: 'The message text to send.',
          },
        },
        required: ['channel_id', 'text'],
      },
    },
    async handler(raw) {
      const { channel_id, thread_key, text } = raw as {
        channel_id: string;
        thread_key?: string;
        text: string;
      };

      const targets =
        channel_id === 'all'
          ? Array.from(channels.keys())
          : [channel_id];

      const results: string[] = [];
      for (const id of targets) {
        const ch = channels.get(id);
        if (!ch) {
          results.push(`${id}: channel not found or not active`);
          continue;
        }
        const threadKey = (thread_key ?? `${id}:default`) as ThreadKey;
        try {
          await ch.send({ agentId, threadKey }, text);
          results.push(`${id}: sent`);
          logger.info('send_text_to_channel', { channelId: id, threadKey });
        } catch (err) {
          results.push(`${id}: error — ${String(err)}`);
          logger.warn('send_text_to_channel failed', { channelId: id, error: String(err) });
        }
      }
      return { isError: false, content: results.join('\n') };
    },
  };

  // ── send_file_to_channel ──────────────────────────────────────────────────

  const sendFileTool: RegisteredTool = {
    category: 'builtin',
    definition: {
      name: 'send_file_to_channel',
      description:
        'Send a file or image from your workspace to a communication channel. ' +
        'The channel must support attachments (e.g. feishu, telegram sends photos/documents). ' +
        'Path is relative to the workspace root.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description:
              'Target channel identifier, e.g. "feishu", "telegram", "discord". ' +
              'Use "all" to send to every active channel that supports attachments.',
          },
          thread_key: {
            type: 'string',
            description:
              'Thread / chat key, e.g. "feishu:oc_xxxxx". Leave empty to use the last-active thread.',
          },
          path: {
            type: 'string',
            description: 'File path relative to the workspace root (e.g. "output/report.png").',
          },
          display_name: {
            type: 'string',
            description: 'Optional display name shown to the recipient. Defaults to the filename.',
          },
        },
        required: ['channel_id', 'path'],
      },
    },
    async handler(raw) {
      const { channel_id, thread_key, path, display_name } = raw as {
        channel_id: string;
        thread_key?: string;
        path: string;
        display_name?: string;
      };

      // Resolve and validate file path inside workspace
      const absPath = resolve(workspaceDir, path);
      if (!absPath.startsWith(resolve(workspaceDir))) {
        return { isError: true, content: `Path escapes workspace: ${path}` };
      }
      if (!existsSync(absPath)) {
        return { isError: true, content: `File not found: ${path}` };
      }

      const mimeType = mimeForFile(absPath);
      const name = display_name ?? basename(absPath);

      const targets =
        channel_id === 'all'
          ? Array.from(channels.keys())
          : [channel_id];

      const results: string[] = [];
      for (const id of targets) {
        const ch = channels.get(id);
        if (!ch) {
          results.push(`${id}: channel not found or not active`);
          continue;
        }
        if (!ch.sendAttachment) {
          results.push(`${id}: does not support attachments`);
          continue;
        }
        const threadKey = (thread_key ?? `${id}:default`) as ThreadKey;
        try {
          await ch.sendAttachment({ agentId, threadKey }, { filePath: absPath, mimeType, name });
          results.push(`${id}: sent "${name}"`);
          logger.info('send_file_to_channel', { channelId: id, threadKey, path, mimeType });
        } catch (err) {
          results.push(`${id}: error — ${String(err)}`);
          logger.warn('send_file_to_channel failed', { channelId: id, path, error: String(err) });
        }
      }
      return { isError: false, content: results.join('\n') };
    },
  };

  return [sendTextTool, sendFileTool];
}
