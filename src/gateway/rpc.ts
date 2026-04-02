import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cron } from 'croner';
import { ulid } from 'ulid';
import type { AgentRunner } from '../agent/runner.js';
import { summarizeSessionErrors } from '../core/session/error-stats.js';
import { buildClearedSessionUpdates, findFailedSessionsForAgent } from '../core/session/recovery.js';
import type { ScheduledTaskMeta } from '../agent/tools/builtin/scheduler-tools.js';
import type { Channel } from '../channels/types.js';
import type { Config } from '../core/config/schema.js';
import { createLogger } from '../core/logger.js';
import type { SessionMetaStore } from '../core/session/meta.js';
import type { SessionStore, StoredMessage } from '../core/session/store.js';
import { asSessionKey, type MessageContent } from '../core/types.js';
import type { EmbedConfig } from '../memory/embed.js';
import { searchMemory } from '../memory/search.js';
import type { MemoryStore } from '../memory/store.js';
import type { MeshRegistry } from '../mesh/registry.js';
import type { CronScheduler } from '../scheduler/cron.js';
import { scanSkillsDir } from '../skills/registry.js';
import type { ContentStore } from './content-store.js';
import {
  type WorkflowRpcMethod,
  dispatchWorkflowRpc,
  runWorkflowForScheduler,
} from './workflow-backend.js';

const logger = createLogger('gateway:rpc');
// Package root: src/gateway/rpc.ts → ../../  (or dist/gateway/rpc.js → ../../)
const _pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
type OutputChannel = 'logs' | 'cli' | 'web';

/** Supported RPC methods. */
export type RpcMethod =
  | 'agent.list'
  | 'agent.chat'
  | 'agent.reload'
  | 'agent.status'
  | 'session.list'
  | 'session.messages'
  | 'session.clear'
  | 'gateway.status'
  | 'gateway.ping'
  | 'config.get'
  | 'config.save'
  | 'scheduler.list'
  | 'scheduler.create'
  | 'scheduler.update'
  | 'scheduler.preview'
  | 'scheduler.runNow'
  | 'scheduler.cancel'
  | 'scheduler.running'
  | 'scheduler.history'
  | 'gateway.shutdown'
  | 'skill.list'
  | 'skill.validateDir'
  | 'content.list'
  | 'content.share'
  | 'memory.search'
  | 'memory.delete'
  | 'stats.get'
  | 'mesh.status'
  | 'federation.peers'
  | 'docs.list'
  | 'docs.get'
  | WorkflowRpcMethod;

export interface RpcRequest {
  id: string | number;
  method: RpcMethod;
  params?: unknown;
}

export interface RpcResponse {
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface RpcContext {
  runners: Map<string, AgentRunner>;
  gatewayVersion: string;
  startedAt: number;
  dataDir: string;
  getConfig: () => Config;
  saveAndReload: (raw: unknown) => Promise<{ reloaded: string[] }>;
  scheduler: CronScheduler;
  shutdown: () => Promise<void>;
  /** Reload agent(s) from the config file on disk. Pass agentId to refresh a single agent. */
  reload: (agentId?: string) => Promise<{ reloaded: string[] }>;
  /** Return skill metadata from the current registry. */
  listSkills: () => import('../skills/registry.js').SkillMeta[];
  /** Session message store — used by session.list and session.messages RPC methods. */
  sessionStore: SessionStore;
  metaStore: SessionMetaStore;
  /** Content catalog for agent-generated files. */
  contentStore: ContentStore;
  /** All registered channels — used for content.share. */
  channels: Map<string, Channel>;
  /** Mesh registry — used for mesh.status. */
  meshRegistry?: MeshRegistry;
  /** Memory store — used for memory.search and memory.delete. */
  memoryStore?: MemoryStore;
  /** Embed config — used by memory.search. */
  embedConfig?: EmbedConfig;
  /** Federation node — used for federation.peers. */
  federationNode?: {
    listPeers(): Array<{
      nodeId: string;
      host: string;
      port: number;
      status: string;
      latencyMs?: number;
      lastSeen?: number;
    }>;
  };
  /** In-memory registry of currently executing scheduler tasks (cleared on restart). */
  runningTasks: Map<
    string,
    { taskId: string; taskName: string; startedAt: number; agentId?: string; workflowId?: string }
  >;
}

function sanitizeConfig(cfg: unknown): unknown {
  // RATIONALE: Running on a personal host — API keys are stored and served as
  // plaintext so the config editor can read and round-trip them correctly.
  // Do NOT re-enable masking here; masked values get written back to disk on
  // config.save and the real key is permanently lost.
  return cfg;
}

function mergeWithOriginal(incoming: unknown, original: unknown): unknown {
  if (typeof incoming === 'string' && typeof original === 'string') {
    return incoming.includes('***') ? original : incoming;
  }
  if (
    typeof incoming === 'object' &&
    incoming !== null &&
    !Array.isArray(incoming) &&
    typeof original === 'object' &&
    original !== null &&
    !Array.isArray(original)
  ) {
    const result: Record<string, unknown> = { ...(original as Record<string, unknown>) };
    for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
      const orig = (original as Record<string, unknown>)[k];
      result[k] = mergeWithOriginal(v, orig !== undefined ? orig : v);
    }
    return result;
  }
  return incoming;
}

function intervalToCron(minutes: number): string {
  if (minutes < 1) throw new Error('intervalMinutes must be >= 1');
  if (minutes === 60) return '0 * * * *';
  if (minutes < 60) return `*/${minutes} * * * *`;
  const hours = Math.round(minutes / 60);
  return `0 */${hours} * * *`;
}

async function readTasksFile(dataDir: string): Promise<ScheduledTaskMeta[]> {
  const tasksFile = join(dataDir, 'scheduled-tasks.json');
  if (!existsSync(tasksFile)) return [];
  try {
    const raw = await readFile(tasksFile, 'utf-8');
    return JSON.parse(raw) as ScheduledTaskMeta[];
  } catch {
    return [];
  }
}

async function writeTasksFile(dataDir: string, tasks: ScheduledTaskMeta[]): Promise<void> {
  const tasksFile = join(dataDir, 'scheduled-tasks.json');
  await writeFile(tasksFile, JSON.stringify(tasks, null, 2), 'utf-8');
}

async function runAgentTask(
  ctx: RpcContext,
  task: ScheduledTaskMeta,
  thread: string,
): Promise<string> {
  const agentId = task.agentId;
  if (!agentId) throw new Error(`Task ${task.id} has no agentId`);
  const runner = ctx.runners.get(agentId);
  if (!runner) throw new Error(`Agent not found: ${agentId}`);

  const previous = runner.currentSessionKey;
  runner.setThread(thread);
  try {
    let output = '';
    const gen = runner.turn(task.message);
    let next = await gen.next();
    while (!next.done) {
      const chunk = next.value;
      if (chunk.type === 'text_delta') output += chunk.text;
      next = await gen.next();
    }
    return next.value.text || output || '(no output)';
  } finally {
    const parts = previous.split(':');
    if (parts.length >= 3) runner.setThread(parts.slice(2).join(':'));
  }
}

interface TaskRunRecord {
  taskId: string;
  taskName: string;
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  result: string;
  agentId?: string;
  workflowId?: string;
}

const HISTORY_MAX_PER_TASK = 50;

async function readHistoryFile(dataDir: string): Promise<TaskRunRecord[]> {
  const file = join(dataDir, 'task-run-history.json');
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as TaskRunRecord[];
  } catch {
    return [];
  }
}

async function appendHistoryRecord(dataDir: string, record: TaskRunRecord): Promise<void> {
  let history = await readHistoryFile(dataDir);
  history.unshift(record);
  // Keep at most HISTORY_MAX_PER_TASK records per task; cap total at 1000
  const countByTask = new Map<string, number>();
  history = history.filter((r) => {
    const n = (countByTask.get(r.taskId) ?? 0) + 1;
    countByTask.set(r.taskId, n);
    return n <= HISTORY_MAX_PER_TASK;
  });
  if (history.length > 1000) history = history.slice(0, 1000);
  await writeFile(
    join(dataDir, 'task-run-history.json'),
    JSON.stringify(history, null, 2),
    'utf-8',
  );
}

function scheduleRuntimeTask(ctx: RpcContext, taskId: string): void {
  void (async () => {
    const tasks = await readTasksFile(ctx.dataDir);
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.enabled === false) return;

    ctx.scheduler.cancel(taskId);
    ctx.scheduler.schedule({
      id: task.id,
      expression: task.cronExpr,
      name: task.name,
      handler: async () => {
        const currentTasks = await readTasksFile(ctx.dataDir);
        const current = currentTasks.find((t) => t.id === task.id);
        if (!current || current.enabled === false) return;

        const startedAt = Date.now();
        ctx.runningTasks.set(task.id, {
          taskId: task.id,
          taskName: current.name,
          startedAt,
          agentId: current.agentId,
          workflowId: current.workflowId,
        });

        let result = '';
        let runOk = false;
        try {
          if (current.workflowId) {
            result = await runWorkflowForScheduler(ctx, current.workflowId, current.message);
          } else {
            result = await runAgentTask(
              ctx,
              current,
              `sched-${current.id}-run-${current.runCount + 1}`,
            );
          }
          runOk = !result.startsWith('Error:');
        } catch (err) {
          result = `Error: ${String(err)}`;
          runOk = false;
        }

        ctx.runningTasks.delete(task.id);
        const finishedAt = Date.now();
        await appendHistoryRecord(ctx.dataDir, {
          taskId: current.id,
          taskName: current.name,
          startedAt,
          finishedAt,
          ok: runOk,
          result: result.slice(0, 2000),
          agentId: current.agentId,
          workflowId: current.workflowId,
        }).catch((e) => logger.warn('Failed to write task run history', { error: String(e) }));

        const channel =
          current.outputChannel ??
          (ctx.getConfig().channels?.defaults?.schedulerOutput as OutputChannel | undefined) ??
          (ctx.getConfig().channels?.defaults?.output as OutputChannel | undefined) ??
          'logs';
        // RATIONALE: AgentFlyer has pluggable channel interfaces but gateway runtime currently guarantees log channel visibility.
        // Emit scheduler events to logs as the default/system channel sink and keep channel id in payload.
        logger.info('Scheduler task result', {
          channel,
          taskId: current.id,
          taskName: current.name,
          agentId: current.agentId,
          workflowId: current.workflowId,
          ok: runOk,
          resultPreview: result.slice(0, 200),
        });

        const patched = currentTasks.map((t) =>
          t.id === current.id
            ? {
                ...t,
                runCount: t.runCount + 1,
                lastRunAt: finishedAt,
                lastResult: result.slice(0, 500),
              }
            : t,
        );
        await writeTasksFile(ctx.dataDir, patched);

        if (current.reportTo) {
          const reporter = ctx.runners.get(current.reportTo);
          if (reporter) {
            const targetLabel = current.workflowId
              ? `执行工作流: ${current.workflowId}`
              : `执行智能体: ${current.agentId ?? ''}`;
            await runAgentTask(
              ctx,
              {
                ...current,
                agentId: current.reportTo,
                message: `[定时任务汇报] ${current.name}\n${targetLabel}\n\n${result}`,
              },
              `sched-report-${current.id}`,
            ).catch(() => undefined);
          }
        }
      },
    });
  })().catch((err) => {
    logger.error('Failed to schedule runtime task', { taskId, error: String(err) });
  });
}

interface DisplayMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tools?: Array<{ name: string; input: string }>;
  toolResults?: Array<{ content: string; isError?: boolean }>;
  timestamp: number;
  isToolResult: boolean;
}

function convertToDisplay(msg: StoredMessage): DisplayMessage {
  const { content } = msg;
  let text = '';
  const tools: Array<{ name: string; input: string }> = [];
  const toolResults: Array<{ content: string; isError?: boolean }> = [];
  let isToolResult = false;

  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content as MessageContent[]) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        tools.push({
          name: block.name,
          input:
            typeof block.input === 'object'
              ? JSON.stringify(block.input, null, 2)
              : String(block.input ?? ''),
        });
      } else if (block.type === 'tool_result') {
        isToolResult = true;
        const resultContent =
          typeof block.content === 'string'
            ? block.content
            : block.content
                .filter((item) => item.type === 'text')
                .map((item) => item.text)
                .join('');
        toolResults.push({ content: resultContent.trim(), isError: block.is_error });
      }
    }
  }

  return {
    id: msg.id,
    role: msg.role as 'user' | 'assistant',
    text: text.trim(),
    tools: tools.length > 0 ? tools : undefined,
    toolResults: toolResults.length > 0 ? toolResults : undefined,
    timestamp: msg.timestamp,
    isToolResult,
  };
}

export function buildErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
): RpcResponse {
  return { id, error: { code, message } };
}

/**
 * Dispatch an RPC request and return a response object.
 * Streaming (agent.chat) is handled separately via WebSocket.
 */
export async function dispatchRpc(req: RpcRequest, ctx: RpcContext): Promise<RpcResponse> {
  const { id, method, params } = req;

  try {
    switch (method) {
      case 'gateway.ping':
        return { id, result: { pong: true, ts: Date.now() } };

      case 'gateway.status':
        return {
          id,
          result: {
            version: ctx.gatewayVersion,
            uptime: Date.now() - ctx.startedAt,
            agents: ctx.runners.size,
          },
        };

      case 'agent.list': {
        const cfgAgents = ctx.getConfig().agents ?? [];
        return {
          id,
          result: {
            agents: Array.from(ctx.runners.keys()).map((agentId) => {
              const cfg = cfgAgents.find((a) => a.id === agentId);
              return {
                agentId,
                name: cfg?.name ?? agentId,
                model:
                  cfg?.model ?? (ctx.getConfig().defaults as Record<string, unknown>)?.model ?? '',
                role: (cfg as unknown as Record<string, unknown>)?.role ?? 'worker',
              };
            }),
          },
        };
      }

      case 'agent.chat': {
        const { agentId, message, thread } = (params ?? {}) as {
          agentId?: string;
          message?: string;
          thread?: string;
        };
        if (!agentId || !message) {
          return buildErrorResponse(id, -32602, 'agentId and message are required');
        }
        const runner = ctx.runners.get(agentId);
        if (!runner) {
          return buildErrorResponse(id, 404, `Agent not found: ${agentId}`);
        }
        if (thread) runner.setThread(thread);

        let replyText = '';
        try {
          const gen = runner.turn(message);
          let next = await gen.next();
          while (!next.done) {
            const chunk = next.value as { type: string; text?: string; message?: string };
            if (chunk.type === 'text_delta' && chunk.text) replyText += chunk.text;
            else if (chunk.type === 'error') throw new Error(chunk.message ?? 'Agent error');
            next = await gen.next();
          }
        } catch (err) {
          return buildErrorResponse(id, -32603, `Agent error: ${String(err)}`);
        }
        return { id, result: { reply: replyText.trim() } };
      }

      case 'agent.reload': {
        const { agentId } = (params ?? {}) as { agentId?: string };
        const result = await ctx.reload(agentId);
        return { id, result };
      }

      case 'agent.status': {
        const { agentId } = (params ?? {}) as { agentId?: string };
        if (!agentId || !ctx.runners.has(agentId)) {
          return buildErrorResponse(id, 404, `Agent not found: ${agentId}`);
        }
        return { id, result: { agentId, status: 'idle' } };
      }

      case 'session.list': {
        const sessions = await ctx.metaStore.listAll();
        sessions.sort((a, b) => b.lastActivity - a.lastActivity);
        return { id, result: { sessions } };
      }

      case 'session.messages': {
        const { sessionKey, includeToolResults } = (params ?? {}) as {
          sessionKey?: string;
          includeToolResults?: boolean;
        };
        if (!sessionKey) return buildErrorResponse(id, -32602, 'sessionKey is required');
        const safeSessionKey = asSessionKey(sessionKey);
        const stored = await ctx.sessionStore.readAll(safeSessionKey);
        const messages = stored
          .map(convertToDisplay)
          .filter((m) => includeToolResults || !m.isToolResult);
        return { id, result: { sessionKey: safeSessionKey, messages } };
      }

      case 'session.clear': {
        const { agentId, sessionKey, failedOnly, errorCode } = (params ?? {}) as {
          agentId?: string;
          sessionKey?: string;
          failedOnly?: boolean;
          errorCode?: import('../core/session/meta.js').SessionErrorCode;
        };
        // Clear by explicit sessionKey if provided
        if (sessionKey) {
          const safeSessionKey = asSessionKey(sessionKey);
          await ctx.sessionStore.overwrite(safeSessionKey, []);
          await ctx.metaStore.update(safeSessionKey, buildClearedSessionUpdates());
          return { id, result: { cleared: true, sessionKey: safeSessionKey } };
        }

        if (failedOnly) {
          if (!agentId) return buildErrorResponse(id, -32602, 'agentId is required');
          const sessions = await ctx.metaStore.listAll();
          const agentFailedSessions = findFailedSessionsForAgent(sessions, agentId);
          const failedSessions = findFailedSessionsForAgent(sessions, agentId, errorCode);
          const updates = buildClearedSessionUpdates();
          for (const session of failedSessions) {
            await ctx.sessionStore.overwrite(session.sessionKey, []);
            await ctx.metaStore.update(session.sessionKey, updates);
          }
          return {
            id,
            result: {
              cleared: true,
              agentId,
              failedOnly: true,
              errorCode,
              clearedSessions: failedSessions.length,
              remainingMatchingFailedSessions: 0,
              remainingFailedSessionsForAgent: Math.max(0, agentFailedSessions.length - failedSessions.length),
            },
          };
        }

        const runner = agentId ? ctx.runners.get(agentId) : undefined;
        if (!runner) return buildErrorResponse(id, 404, `Agent not found: ${agentId}`);
        await runner.clearHistory();
        return { id, result: { cleared: true, agentId } };
      }

      case 'config.get':
        return { id, result: sanitizeConfig(ctx.getConfig()) };

      case 'config.save': {
        // mergeWithOriginal is kept but is now effectively a pass-through for
        // apiKey fields since no masking occurs on config.get.
        const merged = mergeWithOriginal(params ?? {}, ctx.getConfig());
        const result = await ctx.saveAndReload(merged);
        return { id, result };
      }

      case 'scheduler.list': {
        const tasks = await readTasksFile(ctx.dataDir);
        const enriched = tasks.map((t) => ({
          ...t,
          nextRunAt: ctx.scheduler.get(t.id)?.nextRunAt,
        }));
        return { id, result: { tasks: enriched } };
      }

      case 'scheduler.create': {
        const p = (params ?? {}) as {
          name?: string;
          agentId?: string;
          workflowId?: string;
          message?: string;
          cronExpr?: string;
          intervalMinutes?: number;
          reportTo?: string;
          outputChannel?: OutputChannel;
          enabled?: boolean;
        };
        if (!p.name || (!p.agentId && !p.workflowId) || !p.message) {
          return buildErrorResponse(
            id,
            -32602,
            'name, (agentId or workflowId) and message are required',
          );
        }
        if (p.agentId && !ctx.runners.has(p.agentId)) {
          return buildErrorResponse(id, 404, `Agent not found: ${p.agentId}`);
        }
        if (p.reportTo && !ctx.runners.has(p.reportTo)) {
          return buildErrorResponse(id, 404, `reportTo agent not found: ${p.reportTo}`);
        }
        const cronExpr =
          p.cronExpr ??
          (typeof p.intervalMinutes === 'number' ? intervalToCron(p.intervalMinutes) : undefined);
        if (!cronExpr) {
          return buildErrorResponse(id, -32602, 'cronExpr or intervalMinutes is required');
        }

        const task: ScheduledTaskMeta = {
          id: ulid(),
          name: p.name,
          agentId: p.agentId,
          workflowId: p.workflowId,
          message: p.message,
          cronExpr,
          reportTo: p.reportTo,
          outputChannel:
            p.outputChannel ??
            (ctx.getConfig().channels?.defaults?.schedulerOutput as OutputChannel | undefined) ??
            (ctx.getConfig().channels?.defaults?.output as OutputChannel | undefined) ??
            'logs',
          createdAt: Date.now(),
          runCount: 0,
          enabled: p.enabled !== false,
        };

        const tasks = await readTasksFile(ctx.dataDir);
        tasks.push(task);
        await writeTasksFile(ctx.dataDir, tasks);
        if (task.enabled !== false) scheduleRuntimeTask(ctx, task.id);

        return { id, result: { task } };
      }

      case 'scheduler.update': {
        const p = (params ?? {}) as {
          taskId?: string;
          name?: string;
          agentId?: string;
          workflowId?: string;
          message?: string;
          cronExpr?: string;
          intervalMinutes?: number;
          reportTo?: string;
          outputChannel?: OutputChannel;
          enabled?: boolean;
        };
        if (!p.taskId) return buildErrorResponse(id, -32602, 'taskId is required');

        const tasks = await readTasksFile(ctx.dataDir);
        const idx = tasks.findIndex((t) => t.id === p.taskId);
        if (idx < 0) return buildErrorResponse(id, 404, `Task not found: ${p.taskId}`);

        const current = tasks[idx];
        if (!current) return buildErrorResponse(id, 404, `Task not found: ${p.taskId}`);
        // workflowId takes precedence; if switching target, clear the other
        const nextWorkflowId = 'workflowId' in p ? p.workflowId : current.workflowId;
        const nextAgentId = nextWorkflowId
          ? (p.agentId ?? (nextWorkflowId !== current.workflowId ? undefined : current.agentId))
          : (p.agentId ?? current.agentId);
        if (nextAgentId && !ctx.runners.has(nextAgentId)) {
          return buildErrorResponse(id, 404, `Agent not found: ${nextAgentId}`);
        }
        const nextReportTo = p.reportTo ?? current.reportTo;
        if (nextReportTo && !ctx.runners.has(nextReportTo)) {
          return buildErrorResponse(id, 404, `reportTo agent not found: ${nextReportTo}`);
        }
        const nextCronExpr =
          p.cronExpr ??
          (typeof p.intervalMinutes === 'number'
            ? intervalToCron(p.intervalMinutes)
            : current.cronExpr);

        const updated: ScheduledTaskMeta = {
          ...current,
          name: p.name ?? current.name,
          agentId: nextAgentId,
          workflowId: nextWorkflowId,
          message: p.message ?? current.message,
          cronExpr: nextCronExpr,
          reportTo: nextReportTo,
          outputChannel: p.outputChannel ?? current.outputChannel ?? 'logs',
          enabled: p.enabled ?? current.enabled ?? true,
        };

        tasks[idx] = updated;
        await writeTasksFile(ctx.dataDir, tasks);
        ctx.scheduler.cancel(updated.id);
        if (updated.enabled !== false) scheduleRuntimeTask(ctx, updated.id);

        return { id, result: { task: updated } };
      }

      case 'scheduler.preview': {
        const p = (params ?? {}) as { cronExpr?: string; intervalMinutes?: number };
        const cronExpr =
          p.cronExpr ??
          (typeof p.intervalMinutes === 'number' ? intervalToCron(p.intervalMinutes) : undefined);
        if (!cronExpr) {
          return buildErrorResponse(id, -32602, 'cronExpr or intervalMinutes is required');
        }
        try {
          const cron = new Cron(cronExpr, () => undefined);
          const next = cron.nextRun();
          cron.stop();
          return {
            id,
            result: {
              valid: true,
              cronExpr,
              nextRunAt: next ? next.getTime() : null,
            },
          };
        } catch (err) {
          return {
            id,
            result: {
              valid: false,
              cronExpr,
              error: String(err),
            },
          };
        }
      }

      case 'scheduler.runNow': {
        const { taskId } = (params ?? {}) as { taskId?: string };
        if (!taskId) return buildErrorResponse(id, -32602, 'taskId is required');

        const tasks = await readTasksFile(ctx.dataDir);
        const current = tasks.find((t) => t.id === taskId);
        if (!current) return buildErrorResponse(id, 404, `Task not found: ${taskId}`);

        const startedAt = Date.now();
        ctx.runningTasks.set(taskId, {
          taskId,
          taskName: current.name,
          startedAt,
          agentId: current.agentId,
          workflowId: current.workflowId,
        });

        let result = '';
        let runOk = false;
        try {
          if (current.workflowId) {
            result = await runWorkflowForScheduler(ctx, current.workflowId, current.message);
          } else {
            result = await runAgentTask(ctx, current, `sched-${current.id}-manual-${startedAt}`);
          }
          runOk = !result.startsWith('Error:');
        } catch (err) {
          result = `Error: ${String(err)}`;
          runOk = false;
        }

        ctx.runningTasks.delete(taskId);
        const finishedAt = Date.now();
        await appendHistoryRecord(ctx.dataDir, {
          taskId: current.id,
          taskName: current.name,
          startedAt,
          finishedAt,
          ok: runOk,
          result: result.slice(0, 2000),
          agentId: current.agentId,
          workflowId: current.workflowId,
        }).catch((e) => logger.warn('Failed to write task run history', { error: String(e) }));

        const channel =
          current.outputChannel ??
          (ctx.getConfig().channels?.defaults?.schedulerOutput as OutputChannel | undefined) ??
          (ctx.getConfig().channels?.defaults?.output as OutputChannel | undefined) ??
          'logs';
        logger.info('Scheduler manual run result', {
          channel,
          taskId: current.id,
          taskName: current.name,
          agentId: current.agentId,
          workflowId: current.workflowId,
          ok: runOk,
          resultPreview: result.slice(0, 200),
        });

        const patched = tasks.map((t) =>
          t.id === current.id
            ? {
                ...t,
                runCount: t.runCount + 1,
                lastRunAt: finishedAt,
                lastResult: result.slice(0, 500),
              }
            : t,
        );
        await writeTasksFile(ctx.dataDir, patched);

        return { id, result: { ok: runOk, taskId, channel, result: result.slice(0, 500) } };
      }

      case 'scheduler.cancel': {
        const { taskId } = (params ?? {}) as { taskId?: string };
        if (!taskId) return buildErrorResponse(id, -32602, 'taskId is required');
        const ok = ctx.scheduler.cancel(taskId);
        const tasks = await readTasksFile(ctx.dataDir);
        await writeTasksFile(
          ctx.dataDir,
          tasks.filter((t) => t.id !== taskId),
        );
        return { id, result: { cancelled: ok, taskId } };
      }

      case 'scheduler.running':
        return { id, result: { running: Array.from(ctx.runningTasks.values()) } };

      case 'scheduler.history': {
        const { taskId: histTaskId } = (params ?? {}) as { taskId?: string };
        const allHistory = await readHistoryFile(ctx.dataDir);
        const records = histTaskId ? allHistory.filter((r) => r.taskId === histTaskId) : allHistory;
        return { id, result: { records: records.slice(0, 100) } };
      }

      case 'gateway.shutdown': {
        setTimeout(() => void ctx.shutdown(), 100);
        return { id, result: { shutting: true } };
      }

      case 'skill.list': {
        const skills = ctx.listSkills();
        return { id, result: { skills } };
      }

      case 'skill.validateDir': {
        const { dir } = (params ?? {}) as { dir?: string };
        if (!dir?.trim()) return buildErrorResponse(id, -32602, 'dir is required');
        const trimmed = dir.trim();
        if (!existsSync(trimmed)) {
          return buildErrorResponse(id, 404, `Directory not found: ${trimmed}`);
        }
        try {
          const found = scanSkillsDir(trimmed);
          return {
            id,
            result: {
              valid: found.length > 0,
              count: found.length,
              skills: found.map((s) => s.name),
            },
          };
        } catch (err) {
          return buildErrorResponse(id, -32603, `Scan failed: ${String(err)}`);
        }
      }

      case 'content.list': {
        const items = await ctx.contentStore.list();
        return { id, result: { items } };
      }

      case 'memory.search': {
        const {
          query,
          agentId: memAgentId,
          partition,
          limit: memLimit,
        } = (params ?? {}) as {
          query?: string;
          agentId?: string;
          partition?: string;
          limit?: number;
        };
        if (!query) return buildErrorResponse(id, -32602, 'query is required');
        if (!ctx.memoryStore) return buildErrorResponse(id, 503, 'Memory store not available');
        const results = await searchMemory(
          ctx.memoryStore,
          query,
          ctx.embedConfig ?? { model: 'Xenova/all-MiniLM-L6-v2', provider: 'local' as const },
          { partition, limit: memLimit ?? 10 },
        );
        const filtered = memAgentId
          ? results.filter((r) => r.entry.agentId === memAgentId)
          : results;
        return {
          id,
          result: {
            results: filtered.map((r) => ({ ...r.entry, score: r.score, method: r.method })),
          },
        };
      }

      case 'memory.delete': {
        const { entryId } = (params ?? {}) as { entryId?: string };
        if (!entryId) return buildErrorResponse(id, -32602, 'entryId is required');
        if (!ctx.memoryStore) return buildErrorResponse(id, 503, 'Memory store not available');
        ctx.memoryStore.delete(entryId as import('../core/types.js').MemoryEntryId);
        return { id, result: { deleted: true, entryId } };
      }

      case 'stats.get': {
        const { agentId: statsAgent, days } = (params ?? {}) as {
          agentId?: string;
          days?: number;
        };
        const { loadStats } = await import('../agent/stats.js');
        const limitDays = days ?? 30;
        const rows = await loadStats(
          ctx.dataDir,
          statsAgent as import('../core/types.js').AgentId | undefined,
          limitDays,
        );
        const sessions = await ctx.metaStore.listAll();
        const errors = summarizeSessionErrors(sessions, Math.min(limitDays, 14));
        return { id, result: { rows, errors } };
      }

      case 'mesh.status': {
        const agents = ctx.meshRegistry?.list() ?? [];
        return { id, result: { agents } };
      }

      case 'federation.peers': {
        const cfg = ctx.getConfig();
        if (!cfg.federation?.enabled || !ctx.federationNode) {
          return { id, result: { enabled: false, peers: [] } };
        }
        const peers = ctx.federationNode.listPeers();
        return { id, result: { enabled: true, peers } };
      }

      case 'docs.list': {
        return { id, result: { docs: ['README.md', 'README_CN.md'] } };
      }

      case 'docs.get': {
        const { name: docName } = (params ?? {}) as { name?: string };
        // Only serve whitelisted doc files from project root
        const allowedDocs = ['README.md', 'README_CN.md'];
        if (!docName || !allowedDocs.includes(docName))
          return buildErrorResponse(id, 403, 'Access denied');
        try {
          const content = await readFile(join(_pkgRoot, docName), 'utf-8');
          return { id, result: { name: docName, content } };
        } catch {
          return buildErrorResponse(id, 404, `${docName} not found`);
        }
      }

      case 'content.share': {
        const { itemId, channelIds, threadKey, agentId } = (params ?? {}) as {
          itemId?: string;
          channelIds?: string[];
          threadKey?: string;
          agentId?: string;
        };
        if (!itemId) return buildErrorResponse(id, -32602, 'itemId is required');
        if (!channelIds?.length) return buildErrorResponse(id, -32602, 'channelIds is required');
        const item = await ctx.contentStore.get(itemId);
        if (!item) return buildErrorResponse(id, 404, `Content item not found: ${itemId}`);
        const results: Record<string, boolean> = {};
        for (const channelId of channelIds) {
          const ch = ctx.channels.get(channelId);
          if (!ch?.sendAttachment) {
            results[channelId] = false;
            continue;
          }
          try {
            await ch.sendAttachment(
              {
                agentId: (agentId ?? item.agentId) as import('../core/types.js').AgentId,
                threadKey: (threadKey ?? '') as import('../core/types.js').ThreadKey,
              },
              { filePath: item.filePath, mimeType: item.mimeType, name: item.name },
            );
            results[channelId] = true;
          } catch (shareErr) {
            logger.warn('content.share failed for channel', {
              channelId,
              itemId,
              error: String(shareErr),
            });
            results[channelId] = false;
          }
        }
        return { id, result: { results } };
      }

      case 'workflow.list':
      case 'workflow.save':
      case 'workflow.delete':
      case 'workflow.run':
      case 'workflow.runStatus':
      case 'workflow.cancel':
      case 'workflow.history':
        return dispatchWorkflowRpc(method, id, params, ctx);

      default:
        return buildErrorResponse(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    logger.error('RPC dispatch error', { method, error: String(err) });
    return buildErrorResponse(id, -32603, `Internal error: ${String(err)}`);
  }
}
