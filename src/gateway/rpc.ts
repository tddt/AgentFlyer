import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cron } from 'croner';
import { ulid } from 'ulid';
import type { AgentRunner } from '../agent/runner.js';
import {
  type ScheduledTaskRecord,
  stripTaskExecutionSummary,
} from '../agent/tools/builtin/scheduler-task-meta.js';
import type { Channel } from '../channels/types.js';
import type { Config } from '../core/config/schema.js';
import { createLogger } from '../core/logger.js';
import { summarizeSessionErrors } from '../core/session/error-stats.js';
import type { SessionMetaStore } from '../core/session/meta.js';
import {
  buildClearedSessionUpdates,
  findFailedSessionsForAgent,
} from '../core/session/recovery.js';
import type { SessionStore, StoredMessage } from '../core/session/store.js';
import { type MessageContent, asSessionKey } from '../core/types.js';
import {
  buildMcpServerOperatorAttention,
  formatMcpAttentionSummary,
  readMcpServerHistory,
  summarizeMcpServerHistory,
} from '../mcp/index.js';
import type { McpServerRuntimeStatus } from '../mcp/index.js';
import type { EmbedConfig } from '../memory/embed.js';
import { searchMemory } from '../memory/search.js';
import type { MemoryStore } from '../memory/store.js';
import type { MeshRegistry } from '../mesh/registry.js';
import type { CronScheduler } from '../scheduler/cron.js';
import {
  appendScheduledTaskHistoryRecord,
  buildScheduledTaskExecutionSummaryById,
  readScheduledTaskHistory,
} from '../scheduler/task-history.js';
import { scanSkillsDir } from '../skills/registry.js';
import { getAgentKernelService } from './agent-kernel.js';
import type { AgentActiveRunSummary, AgentQueuedRunSummary } from './agent-kernel.js';
import type { AgentQueueRegistry, AgentQueueSnapshot } from './agent-queue.js';
import type { ContentStore } from './content-store.js';
import {
  publishDeliverableTargets,
  publishDeliverableToTarget,
} from './deliverable-publication.js';
import {
  type DeliverablePublicationTarget,
  type DeliverableRecord,
  buildDeliverableStats,
  buildSchedulerDeliverable,
  findRecentArtifacts,
  makeSchedulerRunKey,
} from './deliverables.js';
import type { DeliverableStore } from './deliverables.js';
import type { InboxBroadcaster } from './inbox-broadcaster.js';
import {
  type WorkflowRpcMethod,
  diagnoseWorkflowGraph,
  diagnoseWorkflowValidation,
  dispatchWorkflowRpc,
  readWorkflowsFile,
  runWorkflowForScheduler,
} from './workflow-backend.js';

const logger = createLogger('gateway:rpc');
// Package root: src/gateway/rpc.ts → ../../  (or dist/gateway/rpc.js → ../../)
const _pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
type OutputChannel = 'logs' | 'cli' | 'web';

interface AgentActivityStatus {
  state: 'idle' | 'running' | 'suspended';
  busy: boolean;
  pendingCount: number;
  activeRun?: AgentActiveRunSummary;
  queuedRuns: AgentQueuedRunSummary[];
}

function buildAgentActivityStatus(
  queue: AgentQueueSnapshot,
  activeRun: AgentActiveRunSummary | null,
  queuedRuns: AgentQueuedRunSummary[],
): AgentActivityStatus {
  const state =
    activeRun?.processStatus === 'suspended' || activeRun?.phase === 'suspended'
      ? 'suspended'
      : activeRun || queue.hasActiveTask
        ? 'running'
        : 'idle';
  return {
    state,
    busy: queue.busy || !!activeRun || queuedRuns.length > 0,
    pendingCount: Math.max(queue.pendingCount, queuedRuns.length),
    activeRun: activeRun ?? undefined,
    queuedRuns,
  };
}

async function getAgentActivityStatus(
  ctx: RpcContext,
  agentId: string,
): Promise<AgentActivityStatus> {
  const agentKernel = await getAgentKernelService(ctx);
  return buildAgentActivityStatus(
    ctx.agentQueues?.status(agentId) ?? {
      hasActiveTask: false,
      pendingCount: 0,
      busy: false,
    },
    agentKernel.getLatestLiveRunForAgent(agentId),
    agentKernel.getQueuedRunsForAgent(agentId),
  );
}

function repairDeliverableArtifactRefs(
  deliverable: DeliverableRecord,
  itemsByPath: Map<string, Awaited<ReturnType<ContentStore['list']>>[number]>,
): DeliverableRecord {
  let changed = false;
  const artifacts = deliverable.artifacts.map((artifact) => {
    if (!artifact.filePath) {
      return artifact;
    }
    const item = itemsByPath.get(artifact.filePath);
    if (!item) {
      return artifact;
    }
    if (
      artifact.contentItemId === item.id &&
      artifact.mimeType === item.mimeType &&
      artifact.size === item.size
    ) {
      return artifact;
    }
    changed = true;
    return {
      ...artifact,
      contentItemId: item.id,
      mimeType: item.mimeType,
      size: item.size,
    };
  });
  return changed ? { ...deliverable, artifacts } : deliverable;
}

async function repairDeliverablesForResponse(
  ctx: RpcContext,
  deliverables: DeliverableRecord[],
): Promise<DeliverableRecord[]> {
  if (deliverables.length === 0) {
    return deliverables;
  }
  const contentItems = await ctx.contentStore.list();
  const itemsByPath = new Map(contentItems.map((item) => [item.filePath, item]));
  return deliverables.map((deliverable) => repairDeliverableArtifactRefs(deliverable, itemsByPath));
}

function normalizePublicationChannels(
  value: unknown,
  availableChannels: Map<string, Channel>,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );
  for (const channelId of normalized) {
    if (!availableChannels.has(channelId)) {
      throw new Error(`Unknown channel: ${channelId}`);
    }
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePublicationTargets(
  value: unknown,
  availableChannels: Map<string, Channel>,
): Array<{ channelId: string; threadKey: string; agentId?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized: Array<{ channelId: string; threadKey: string; agentId?: string }> = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const raw = item as { channelId?: unknown; threadKey?: unknown; agentId?: unknown };
    const channelId = typeof raw.channelId === 'string' ? raw.channelId.trim() : '';
    const threadKey = typeof raw.threadKey === 'string' ? raw.threadKey.trim() : '';
    const agentId = typeof raw.agentId === 'string' ? raw.agentId.trim() : undefined;
    if (!channelId || !threadKey) continue;
    if (!availableChannels.has(channelId)) {
      throw new Error(`Unknown channel: ${channelId}`);
    }
    const dedupeKey = `${channelId}:${threadKey}:${agentId ?? ''}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push({ channelId, threadKey, agentId: agentId || undefined });
  }
  return normalized.length > 0 ? normalized : undefined;
}

function outputChannelLabel(channel: OutputChannel): string {
  return channel === 'logs' ? 'Gateway Logs' : channel === 'cli' ? 'CLI Console' : 'Web Console';
}

function buildAvailableChannelTargets(
  ctx: RpcContext,
  hasFileArtifacts: boolean,
): DeliverablePublicationTarget[] {
  return Array.from(ctx.channels.values()).map((channel) => ({
    id: `channel:${channel.id}`,
    kind: 'channel',
    targetId: channel.id,
    label: channel.name,
    mode: hasFileArtifacts && channel.sendAttachment ? 'artifact' : 'summary',
    status: 'available',
    detail:
      hasFileArtifacts && !channel.sendAttachment
        ? 'Text delivery is available, but attachment upload is not implemented for this channel.'
        : hasFileArtifacts
          ? 'This channel can receive file or media artifacts.'
          : 'This channel can receive a summary version of the deliverable.',
  }));
}

function buildSchedulerPublicationTargets(
  ctx: RpcContext,
  task: ScheduledTaskRecord,
  fileArtifacts: import('./deliverables.js').ArtifactRef[],
): DeliverablePublicationTarget[] {
  const planned: DeliverablePublicationTarget[] = [];
  const outputChannel = task.outputChannel ?? 'logs';

  planned.push({
    id: `system:${outputChannel}`,
    kind: 'system',
    targetId: outputChannel,
    label: outputChannelLabel(outputChannel),
    mode: 'summary',
    status: 'planned',
    detail: 'Scheduler execution summary is planned to flow through this system output.',
  });

  if (task.reportTo) {
    planned.push({
      id: `agent:${task.reportTo}`,
      kind: 'agent',
      targetId: task.reportTo,
      label: `Agent ${task.reportTo}`,
      mode: 'summary',
      status: 'planned',
      detail: 'A follow-up summary is planned to be sent to this reporting agent.',
    });
  }

  const publicationTargets = task.publicationTargets;
  const publicationChannelIds = task.publicationChannels;
  const channelTargets: DeliverablePublicationTarget[] =
    publicationTargets && publicationTargets.length > 0
      ? publicationTargets
          .map((target) => ({ target, channel: ctx.channels.get(target.channelId) }))
          .filter(
            (
              item,
            ): item is {
              target: NonNullable<typeof publicationTargets>[number];
              channel: Channel;
            } => !!item.channel,
          )
          .map(({ target, channel }) => ({
            id: `channel:${channel.id}:${target.threadKey}`,
            kind: 'channel' as const,
            targetId: channel.id,
            label: `${channel.name} · ${target.threadKey}`,
            mode:
              fileArtifacts.length > 0 && channel.sendAttachment
                ? ('artifact' as const)
                : ('summary' as const),
            status: 'planned' as const,
            threadKey: target.threadKey,
            agentId: target.agentId,
            detail: target.agentId
              ? `Planned for thread ${target.threadKey} using agent ${target.agentId}.`
              : `Planned for thread ${target.threadKey}.`,
          }))
      : publicationChannelIds && publicationChannelIds.length > 0
        ? publicationChannelIds
            .map((channelId) => ctx.channels.get(channelId))
            .filter((channel): channel is NonNullable<typeof channel> => !!channel)
            .map((channel) => ({
              id: `channel:${channel.id}`,
              kind: 'channel' as const,
              targetId: channel.id,
              label: channel.name,
              mode:
                fileArtifacts.length > 0 && channel.sendAttachment
                  ? ('artifact' as const)
                  : ('summary' as const),
              status: 'planned' as const,
              detail:
                fileArtifacts.length > 0 && !channel.sendAttachment
                  ? 'Summary delivery is planned, but attachment upload is not implemented for this channel.'
                  : fileArtifacts.length > 0
                    ? 'This channel is planned to receive file or media artifacts.'
                    : 'This channel is planned to receive a summary version of the deliverable.',
            }))
        : buildAvailableChannelTargets(ctx, fileArtifacts.length > 0);

  return [...planned, ...channelTargets];
}

/** Supported RPC methods. */
export type RpcMethod =
  | 'agent.list'
  | 'agent.run'
  | 'agent.chat'
  | 'agent.cancel'
  | 'agent.runStatus'
  | 'agent.resume'
  | 'agent.reload'
  | 'agent.status'
  | 'tool.list'
  | 'channel.list'
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
  | 'deliverable.list'
  | 'deliverable.get'
  | 'deliverable.publish'
  | 'deliverable.update'
  | 'deliverable.attachArtifact'
  | 'deliverable.batchPublish'
  | 'memory.search'
  | 'memory.delete'
  | 'stats.get'
  | 'mesh.status'
  | 'mcp.status'
  | 'mcp.history'
  | 'mcp.refresh'
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
  agentQueues?: AgentQueueRegistry;
  gatewayVersion: string;
  startedAt: number;
  dataDir: string;
  getConfig: () => Config;
  saveAndReload: (raw: unknown) => Promise<{ reloaded: string[] }>;
  scheduler: CronScheduler;
  shutdown: () => Promise<void>;
  /** Reload agent(s) from the config file on disk. Pass agentId to refresh a single agent. */
  reload: (agentId?: string) => Promise<{ reloaded: string[] }>;
  /** Refresh MCP runtime without re-reading config from disk. */
  refreshMcp?: (serverId?: string) => Promise<{ reloaded: string[]; refreshed: string[] }>;
  /** Return skill metadata from the current registry. */
  listSkills: () => import('../skills/registry.js').SkillMeta[];
  /** Session message store — used by session.list and session.messages RPC methods. */
  sessionStore: SessionStore;
  metaStore: SessionMetaStore;
  /** Content catalog for agent-generated files. */
  contentStore: ContentStore;
  /** Deliverable store for workflow/scheduler outputs. */
  deliverableStore: DeliverableStore;
  /** Inbox stream broadcaster for unified chat events. */
  inboxBroadcaster?: InboxBroadcaster;
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
  /** MCP registry status snapshot — used for mcp.status. */
  getMcpStatus?: () => McpServerRuntimeStatus[];
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

interface SchedulerTargetAdvisory {
  kind: 'sandbox-advisory' | 'workflow-advisory' | 'mcp-advisory';
  message: string;
  details?: string[];
  recommendedAgentId?: string;
  recommendedSandboxProfile?: string;
}

function mergeSchedulerTargetAdvisories(
  advisories: Array<SchedulerTargetAdvisory | undefined>,
): SchedulerTargetAdvisory | undefined {
  const resolved = advisories.filter(
    (advisory): advisory is SchedulerTargetAdvisory => advisory !== undefined,
  );
  if (resolved.length === 0) {
    return undefined;
  }

  const [primary, ...rest] = resolved;
  if (!primary) {
    return undefined;
  }

  const details = Array.from(
    new Set([primary.message, ...rest.map((advisory) => advisory.message)]),
  );
  return details.length > 1 ? { ...primary, details } : primary;
}

function recommendSandboxSchedulerAgent(
  agents: Array<{ id: string; tools?: { sandboxProfile?: string } }>,
): { id: string; sandboxProfile: string } | null {
  const preferred =
    agents.find((agent) => agent.tools?.sandboxProfile === 'readonly-output') ??
    agents.find((agent) => !!agent.tools?.sandboxProfile);
  if (!preferred?.tools?.sandboxProfile) {
    return null;
  }
  return {
    id: preferred.id,
    sandboxProfile: preferred.tools.sandboxProfile,
  };
}

function buildSchedulerTargetAdvisory(
  task: Pick<ScheduledTaskRecord, 'agentId' | 'workflowId'>,
  agents: Array<{ id: string; tools?: { sandboxProfile?: string } }>,
): SchedulerTargetAdvisory | undefined {
  if (task.workflowId || !task.agentId) {
    return undefined;
  }

  const targetAgent = agents.find((agent) => agent.id === task.agentId);
  if (!targetAgent || targetAgent.tools?.sandboxProfile) {
    return undefined;
  }

  const recommended = recommendSandboxSchedulerAgent(agents);
  if (recommended && recommended.id !== targetAgent.id) {
    return {
      kind: 'sandbox-advisory',
      message: `scheduled task targets '${targetAgent.id}' without sandboxProfile. Prefer '${recommended.id}' (sandbox:${recommended.sandboxProfile}) for unattended execution.`,
      recommendedAgentId: recommended.id,
      recommendedSandboxProfile: recommended.sandboxProfile,
    };
  }

  return {
    kind: 'sandbox-advisory',
    message:
      'scheduled task targets an agent without sandboxProfile. Consider binding readonly-output or another sandbox profile before unattended execution.',
  };
}

async function buildSchedulerWorkflowAdvisory(
  task: Pick<ScheduledTaskRecord, 'workflowId'>,
  ctx: RpcContext,
  workflowsById: Map<string, import('./workflow-backend.js').WorkflowDef>,
): Promise<SchedulerTargetAdvisory | undefined> {
  if (!task.workflowId) {
    return undefined;
  }

  const workflow = workflowsById.get(task.workflowId);
  if (!workflow) {
    return {
      kind: 'workflow-advisory',
      message: `scheduled task targets workflow '${task.workflowId}', but that workflow is not present in current workflow store.`,
    };
  }

  const validationDiagnostics = diagnoseWorkflowValidation(workflow, {
    agents: ctx.getConfig().agents ?? [],
  });
  const graphDiagnostics = diagnoseWorkflowGraph(workflow);
  const advisory = validationDiagnostics.find(
    (diagnostic) => diagnostic.kind === 'step-advisory' || diagnostic.kind === 'workflow-advisory',
  );
  if (advisory) {
    return {
      kind: 'workflow-advisory',
      message: advisory.message,
    };
  }

  const graphDiagnostic = graphDiagnostics[0];
  if (graphDiagnostic) {
    return {
      kind: 'workflow-advisory',
      message:
        graphDiagnostic.kind === 'cycle'
          ? `scheduled task targets workflow '${workflow.id}' with a cycle at step '${graphDiagnostic.stepId}'.`
          : `scheduled task targets workflow '${workflow.id}' with unreachable steps: ${graphDiagnostic.stepIds.join(', ')}.`,
    };
  }

  return undefined;
}

async function buildSchedulerMcpAdvisory(
  ctx: RpcContext,
): Promise<SchedulerTargetAdvisory | undefined> {
  const statuses = ctx.getMcpStatus ? ctx.getMcpStatus() : [];
  if (statuses.length === 0) {
    return undefined;
  }

  const history = await readMcpServerHistory(ctx.dataDir);
  const attention = buildMcpServerOperatorAttention(statuses, summarizeMcpServerHistory(history));
  const message = formatMcpAttentionSummary(attention);
  if (!message) {
    return undefined;
  }

  return {
    kind: 'mcp-advisory',
    message,
  };
}

async function readTasksFile(dataDir: string): Promise<ScheduledTaskRecord[]> {
  const tasksFile = join(dataDir, 'scheduled-tasks.json');
  if (!existsSync(tasksFile)) return [];
  try {
    const raw = await readFile(tasksFile, 'utf-8');
    return JSON.parse(raw) as ScheduledTaskRecord[];
  } catch {
    return [];
  }
}

async function writeTasksFile(dataDir: string, tasks: ScheduledTaskRecord[]): Promise<void> {
  const tasksFile = join(dataDir, 'scheduled-tasks.json');
  await writeFile(
    tasksFile,
    JSON.stringify(tasks.map(stripTaskExecutionSummary), null, 2),
    'utf-8',
  );
}

async function runAgentTask(
  ctx: RpcContext,
  task: ScheduledTaskRecord,
  thread: string,
): Promise<string> {
  const agentId = task.agentId;
  if (!agentId) throw new Error(`Task ${task.id} has no agentId`);
  const agentKernel = await getAgentKernelService(ctx);
  const result = await agentKernel.executeTurn({
    agentId,
    userMessage: task.message,
    threadKey: thread,
  });
  return result.text || '(no output)';
}

async function createSchedulerDeliverableRecord(
  ctx: RpcContext,
  task: ScheduledTaskRecord,
  startedAt: number,
  finishedAt: number,
  ok: boolean,
  result: string,
  workflowRunId?: string,
): Promise<import('./deliverables.js').DeliverableRecord> {
  const agentIds = task.agentId ? [task.agentId] : [];
  const contentItems = agentIds.length > 0 ? await ctx.contentStore.list() : [];
  const fileArtifacts = findRecentArtifacts(contentItems, agentIds, startedAt, finishedAt);
  const publications = buildSchedulerPublicationTargets(ctx, task, fileArtifacts);
  const deliverable = await ctx.deliverableStore.upsert(
    buildSchedulerDeliverable({
      task,
      startedAt,
      finishedAt,
      ok,
      result,
      workflowRunId,
      fileArtifacts,
      publications,
    }),
  );
  await publishDeliverableTargets(ctx, deliverable);
  const latest = (await ctx.deliverableStore.get(deliverable.id)) ?? deliverable;
  ctx.inboxBroadcaster?.publish({
    kind: 'deliverable',
    agentId: task.agentId,
    title: `${task.name} deliverable ready`,
    text: latest.summary || latest.previewText || latest.title,
    deliverableId: latest.id,
    publicationSummary: latest.publications
      ?.map((item) => `${item.label}:${item.status}`)
      .join(' · '),
  });
  return latest;
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
        let workflowRunId: string | undefined;
        try {
          if (current.workflowId) {
            const workflowResult = await runWorkflowForScheduler(
              ctx,
              current.workflowId,
              current.message,
            );
            result = workflowResult.output;
            workflowRunId = workflowResult.workflowRunId;
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
        const deliverable = await createSchedulerDeliverableRecord(
          ctx,
          current,
          startedAt,
          finishedAt,
          runOk,
          result,
          workflowRunId,
        ).catch((e) => {
          logger.warn('Failed to create scheduler deliverable', {
            taskId: current.id,
            error: String(e),
          });
          return null;
        });
        await appendScheduledTaskHistoryRecord(ctx.dataDir, {
          taskId: current.id,
          taskName: current.name,
          runKey: makeSchedulerRunKey(current.id, startedAt),
          startedAt,
          finishedAt,
          ok: runOk,
          result: result.slice(0, 2000),
          agentId: current.agentId,
          workflowId: current.workflowId,
          workflowRunId,
          deliverableId: deliverable?.id,
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
        const agentKernel = await getAgentKernelService(ctx);
        return {
          id,
          result: {
            agents: Array.from(ctx.runners.keys()).map((agentId) => {
              const cfg = cfgAgents.find((a) => a.id === agentId);
              const activity = buildAgentActivityStatus(
                ctx.agentQueues?.status(agentId) ?? {
                  hasActiveTask: false,
                  pendingCount: 0,
                  busy: false,
                },
                agentKernel.getLatestLiveRunForAgent(agentId),
                agentKernel.getQueuedRunsForAgent(agentId),
              );
              return {
                agentId,
                name: cfg?.name ?? agentId,
                mentionAliases: cfg?.mentionAliases ?? [],
                sandboxProfile: cfg?.tools?.sandboxProfile,
                activity,
                model:
                  cfg?.model ?? (ctx.getConfig().defaults as Record<string, unknown>)?.model ?? '',
                role: (cfg as unknown as Record<string, unknown>)?.role ?? 'worker',
              };
            }),
          },
        };
      }

      case 'tool.list': {
        const tools = new Map<
          string,
          {
            name: string;
            description: string;
            category: string;
            agentIds: string[];
          }
        >();

        for (const [agentId, runner] of ctx.runners) {
          for (const tool of runner.listTools()) {
            const existing = tools.get(tool.name);
            if (existing) {
              if (!existing.agentIds.includes(agentId)) {
                existing.agentIds.push(agentId);
              }
              continue;
            }
            tools.set(tool.name, {
              name: tool.name,
              description: tool.description,
              category: tool.category,
              agentIds: [agentId],
            });
          }
        }

        return {
          id,
          result: {
            tools: Array.from(tools.values()).sort((left, right) => {
              const categoryCompare = left.category.localeCompare(right.category);
              if (categoryCompare !== 0) return categoryCompare;
              return left.name.localeCompare(right.name);
            }),
          },
        };
      }

      case 'mcp.status': {
        const servers = ctx.getMcpStatus ? ctx.getMcpStatus() : [];
        const history = await readMcpServerHistory(ctx.dataDir);
        const summaries = summarizeMcpServerHistory(history);
        const attention = buildMcpServerOperatorAttention(servers, summaries);
        return {
          id,
          result: {
            servers,
            summaries,
            attention,
          },
        };
      }

      case 'mcp.history': {
        const historyParams = (params ?? {}) as { serverId?: string; limit?: number };
        const serverId =
          typeof historyParams.serverId === 'string' && historyParams.serverId.trim().length > 0
            ? historyParams.serverId.trim()
            : undefined;
        const requestedLimit = Number(historyParams.limit);
        const limit = Number.isFinite(requestedLimit)
          ? Math.max(1, Math.min(200, requestedLimit))
          : 50;
        const allRecords = await readMcpServerHistory(ctx.dataDir);
        const records = (
          serverId ? allRecords.filter((record) => record.serverId === serverId) : allRecords
        ).slice(0, limit);
        return {
          id,
          result: {
            records,
          },
        };
      }

      case 'mcp.refresh': {
        const serverId = (params as { serverId?: string } | undefined)?.serverId;
        const result = ctx.refreshMcp ? await ctx.refreshMcp(serverId) : await ctx.reload();
        return {
          id,
          result: {
            ...result,
            servers: ctx.getMcpStatus ? ctx.getMcpStatus() : [],
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
        if (!ctx.runners.has(agentId)) {
          return buildErrorResponse(id, 404, `Agent not found: ${agentId}`);
        }
        try {
          const agentKernel = await getAgentKernelService(ctx);
          const execute = async () =>
            await agentKernel.executeTurn({
              agentId,
              userMessage: message,
              threadKey: thread,
            });
          const result = ctx.agentQueues
            ? await ctx.agentQueues.for(agentId).enqueue(execute)
            : await execute();
          return { id, result: { reply: result.text.trim() } };
        } catch (err) {
          return buildErrorResponse(id, -32603, `Agent error: ${String(err)}`);
        }
      }

      case 'agent.run': {
        const { agentId, message, thread } = (params ?? {}) as {
          agentId?: string;
          message?: string;
          thread?: string;
        };
        if (!agentId || !message) {
          return buildErrorResponse(id, -32602, 'agentId and message are required');
        }
        if (!ctx.runners.has(agentId)) {
          return buildErrorResponse(id, 404, `Agent not found: ${agentId}`);
        }
        const agentKernel = await getAgentKernelService(ctx);
        if (ctx.agentQueues) {
          const reserved = await agentKernel.reserveQueuedTurn({
            agentId,
            userMessage: message,
            threadKey: thread,
          });
          void ctx.agentQueues
            .for(agentId)
            .enqueue(
              async () => {
                const queued = agentKernel.getRun(reserved.runId);
                if (!queued || queued.processStatus !== 'waiting' || queued.phase !== 'pending') {
                  return;
                }
                await agentKernel.startTurn({
                  runId: reserved.runId,
                  agentId,
                  userMessage: message,
                  threadKey: thread,
                });
              },
              { taskKey: reserved.runId },
            )
            .catch((error) => {
              logger.error('Queued agent.run failed to start', {
                agentId,
                runId: reserved.runId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          return { id, result: { ...reserved, queued: true } };
        }
        const started = await agentKernel.startTurn({
          agentId,
          userMessage: message,
          threadKey: thread,
        });
        return { id, result: started };
      }

      case 'agent.cancel': {
        const { runId } = (params ?? {}) as { runId?: string };
        if (!runId) {
          return buildErrorResponse(id, -32602, 'runId is required');
        }
        const agentKernel = await getAgentKernelService(ctx);
        const current = agentKernel.getRun(runId);
        if (!current) {
          return buildErrorResponse(id, 404, `Run not found: ${runId}`);
        }
        if (current.processStatus === 'waiting' && current.phase === 'pending') {
          ctx.agentQueues?.cancelPending(current.agentId, runId);
          const cancelled = await agentKernel.cancelQueuedTurn(runId);
          return { id, result: { cancelled: Boolean(cancelled), runId } };
        }
        return {
          id,
          result: {
            cancelled: false,
            runId,
            reason: 'Only queued runs can be cancelled currently.',
          },
        };
      }

      case 'agent.runStatus': {
        const { runId } = (params ?? {}) as { runId?: string };
        if (!runId) {
          return buildErrorResponse(id, -32602, 'runId is required');
        }
        const agentKernel = await getAgentKernelService(ctx);
        return { id, result: agentKernel.getRun(runId) };
      }

      case 'agent.resume': {
        const { runId } = (params ?? {}) as { runId?: string };
        if (!runId) {
          return buildErrorResponse(id, -32602, 'runId is required');
        }
        const agentKernel = await getAgentKernelService(ctx);
        const current = agentKernel.getRun(runId);
        if (!current) {
          return buildErrorResponse(id, 404, `Run not found: ${runId}`);
        }
        if (current.processStatus !== 'suspended') {
          return {
            id,
            result: {
              resumed: false,
              reason: `Run status is already '${current.phase}'`,
              run: current,
            },
          };
        }
        const resumed = await agentKernel.resumeTurn(runId);
        return {
          id,
          result: {
            resumed: true,
            runId,
            run: resumed,
          },
        };
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
        return {
          id,
          result: {
            agentId,
            activity: await getAgentActivityStatus(ctx, agentId),
          },
        };
      }

      case 'channel.list': {
        return {
          id,
          result: {
            channels: Array.from(ctx.channels.values()).map((channel) => ({
              id: channel.id,
              name: channel.name,
              supportsAttachment: typeof channel.sendAttachment === 'function',
            })),
          },
        };
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
          .filter((message) => includeToolResults || !message.isToolResult);
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
              remainingFailedSessionsForAgent: Math.max(
                0,
                agentFailedSessions.length - failedSessions.length,
              ),
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
        const summaryByTaskId = buildScheduledTaskExecutionSummaryById(
          await readScheduledTaskHistory(ctx.dataDir),
        );
        const configuredAgents = ctx.getConfig().agents ?? [];
        const mcpAdvisory = await buildSchedulerMcpAdvisory(ctx);
        const workflowsById = new Map(
          (await readWorkflowsFile(ctx.dataDir)).map((workflow) => [workflow.id, workflow]),
        );
        const enriched = await Promise.all(
          tasks.map(async (t) => ({
            ...stripTaskExecutionSummary(t),
            ...summaryByTaskId.get(t.id),
            nextRunAt: ctx.scheduler.get(t.id)?.nextRunAt,
            advisory: mergeSchedulerTargetAdvisories([
              buildSchedulerTargetAdvisory(t, configuredAgents),
              await buildSchedulerWorkflowAdvisory(t, ctx, workflowsById),
              mcpAdvisory,
            ]),
          })),
        );
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
          publicationTargets?: Array<{ channelId: string; threadKey: string; agentId?: string }>;
          publicationChannels?: string[];
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

        let publicationTargets:
          | Array<{
              channelId: string;
              threadKey: string;
              agentId?: string;
            }>
          | undefined;
        let publicationChannels: string[] | undefined;
        try {
          publicationTargets = normalizePublicationTargets(p.publicationTargets, ctx.channels);
          publicationChannels = publicationTargets
            ? Array.from(new Set(publicationTargets.map((target) => target.channelId)))
            : normalizePublicationChannels(p.publicationChannels, ctx.channels);
        } catch (err) {
          return buildErrorResponse(id, -32602, String(err));
        }

        const task: ScheduledTaskRecord = {
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
          publicationTargets,
          publicationChannels,
          createdAt: Date.now(),
          runCount: 0,
          enabled: p.enabled !== false,
        };

        const tasks = await readTasksFile(ctx.dataDir);
        tasks.push(task);
        await writeTasksFile(ctx.dataDir, tasks);
        if (task.enabled !== false) scheduleRuntimeTask(ctx, task.id);

        const mcpAdvisory = await buildSchedulerMcpAdvisory(ctx);

        return {
          id,
          result: {
            task: {
              ...task,
              advisory: mergeSchedulerTargetAdvisories([
                buildSchedulerTargetAdvisory(task, ctx.getConfig().agents ?? []),
                mcpAdvisory,
              ]),
            },
          },
        };
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
          publicationTargets?: Array<{ channelId: string; threadKey: string; agentId?: string }>;
          publicationChannels?: string[];
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
        let nextPublicationTargets = current.publicationTargets;
        let nextPublicationChannels = current.publicationChannels;
        if ('publicationTargets' in p || 'publicationChannels' in p) {
          try {
            nextPublicationTargets = normalizePublicationTargets(
              p.publicationTargets,
              ctx.channels,
            );
            nextPublicationChannels = nextPublicationTargets
              ? Array.from(new Set(nextPublicationTargets.map((target) => target.channelId)))
              : normalizePublicationChannels(p.publicationChannels, ctx.channels);
          } catch (err) {
            return buildErrorResponse(id, -32602, String(err));
          }
        }

        const updated: ScheduledTaskRecord = {
          ...current,
          name: p.name ?? current.name,
          agentId: nextAgentId,
          workflowId: nextWorkflowId,
          message: p.message ?? current.message,
          cronExpr: nextCronExpr,
          reportTo: nextReportTo,
          outputChannel: p.outputChannel ?? current.outputChannel ?? 'logs',
          publicationTargets: nextPublicationTargets,
          publicationChannels: nextPublicationChannels,
          enabled: p.enabled ?? current.enabled ?? true,
        };

        tasks[idx] = updated;
        await writeTasksFile(ctx.dataDir, tasks);
        ctx.scheduler.cancel(updated.id);
        if (updated.enabled !== false) scheduleRuntimeTask(ctx, updated.id);

        const mcpAdvisory = await buildSchedulerMcpAdvisory(ctx);

        return {
          id,
          result: {
            task: {
              ...updated,
              advisory: mergeSchedulerTargetAdvisories([
                buildSchedulerTargetAdvisory(updated, ctx.getConfig().agents ?? []),
                mcpAdvisory,
              ]),
            },
          },
        };
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
        let workflowRunId: string | undefined;
        try {
          if (current.workflowId) {
            const workflowResult = await runWorkflowForScheduler(
              ctx,
              current.workflowId,
              current.message,
            );
            result = workflowResult.output;
            workflowRunId = workflowResult.workflowRunId;
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
        const deliverable = await createSchedulerDeliverableRecord(
          ctx,
          current,
          startedAt,
          finishedAt,
          runOk,
          result,
          workflowRunId,
        ).catch((e) => {
          logger.warn('Failed to create scheduler deliverable', {
            taskId: current.id,
            error: String(e),
          });
          return null;
        });
        await appendScheduledTaskHistoryRecord(ctx.dataDir, {
          taskId: current.id,
          taskName: current.name,
          runKey: makeSchedulerRunKey(current.id, startedAt),
          startedAt,
          finishedAt,
          ok: runOk,
          result: result.slice(0, 2000),
          agentId: current.agentId,
          workflowId: current.workflowId,
          workflowRunId,
          deliverableId: deliverable?.id,
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
              }
            : t,
        );
        await writeTasksFile(ctx.dataDir, patched);

        return {
          id,
          result: {
            ok: runOk,
            taskId,
            channel,
            result: result.slice(0, 500),
            deliverableId: deliverable?.id,
          },
        };
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
        const allHistory = await readScheduledTaskHistory(ctx.dataDir);
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

      case 'deliverable.list': {
        const items = await ctx.deliverableStore.list(
          ((params ?? {}) as import('./deliverables.js').DeliverableListFilters) ?? {},
        );
        const repairedItems = await repairDeliverablesForResponse(ctx, items);
        return {
          id,
          result: {
            items: repairedItems,
            stats: buildDeliverableStats(repairedItems),
          },
        };
      }

      case 'deliverable.get': {
        const { deliverableId } = (params ?? {}) as { deliverableId?: string };
        if (!deliverableId) return buildErrorResponse(id, -32602, 'deliverableId is required');
        const deliverable = await ctx.deliverableStore.get(deliverableId);
        if (!deliverable) {
          return buildErrorResponse(id, 404, `Deliverable not found: ${deliverableId}`);
        }
        const [repairedDeliverable] = await repairDeliverablesForResponse(ctx, [deliverable]);
        return { id, result: repairedDeliverable ?? deliverable };
      }

      case 'deliverable.publish': {
        const { deliverableId, publicationId } = (params ?? {}) as {
          deliverableId?: string;
          publicationId?: string;
        };
        if (!deliverableId) return buildErrorResponse(id, -32602, 'deliverableId is required');
        if (!publicationId) return buildErrorResponse(id, -32602, 'publicationId is required');

        const deliverable = await ctx.deliverableStore.get(deliverableId);
        if (!deliverable) {
          return buildErrorResponse(id, 404, `Deliverable not found: ${deliverableId}`);
        }
        const [repairedDeliverable] = await repairDeliverablesForResponse(ctx, [deliverable]);
        const targetDeliverable = repairedDeliverable ?? deliverable;

        if (!targetDeliverable.publications?.some((item) => item.id === publicationId)) {
          return buildErrorResponse(id, 404, `Publication target not found: ${publicationId}`);
        }
        try {
          const result = await publishDeliverableToTarget(ctx, targetDeliverable, publicationId);
          if (!result.ok) {
            return buildErrorResponse(id, -32603, `Publish failed: ${result.detail}`);
          }
          return {
            id,
            result: {
              ok: result.ok,
              deliverableId,
              publicationId,
              detail: result.detail,
            },
          };
        } catch (publishErr) {
          return buildErrorResponse(id, -32603, `Publish failed: ${String(publishErr)}`);
        }
      }

      case 'deliverable.update': {
        const { deliverableId, title, summary } = (params ?? {}) as {
          deliverableId?: string;
          title?: string;
          summary?: string;
        };
        if (!deliverableId) return buildErrorResponse(id, -32602, 'deliverableId is required');
        const updates: Partial<
          Pick<import('./deliverables.js').DeliverableRecord, 'title' | 'summary'>
        > = {};
        if (title !== undefined) updates.title = title;
        if (summary !== undefined) updates.summary = summary;
        if (Object.keys(updates).length === 0) {
          return buildErrorResponse(id, -32602, 'title or summary is required');
        }
        const updated = await ctx.deliverableStore.update(deliverableId, updates);
        if (!updated) return buildErrorResponse(id, 404, `Deliverable not found: ${deliverableId}`);
        return { id, result: updated };
      }

      case 'deliverable.attachArtifact': {
        const {
          deliverableId,
          filePath: attachFilePath,
          name: attachName,
        } = (params ?? {}) as {
          deliverableId?: string;
          filePath?: string;
          name?: string;
        };
        if (!deliverableId) return buildErrorResponse(id, -32602, 'deliverableId is required');
        if (!attachFilePath) return buildErrorResponse(id, -32602, 'filePath is required');

        const { existsSync: existsSyncNode } = await import('node:fs');
        if (!existsSyncNode(attachFilePath)) {
          return buildErrorResponse(id, 400, `File not found: ${attachFilePath}`);
        }

        const { basename, extname } = await import('node:path');
        const { statSync } = await import('node:fs');
        const { ulid: newUlid } = await import('ulid');
        const ext = extname(attachFilePath).toLowerCase().slice(1);
        const mimeMap: Record<string, string> = {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          gif: 'image/gif',
          webp: 'image/webp',
          svg: 'image/svg+xml',
          pdf: 'application/pdf',
          mp4: 'video/mp4',
          webm: 'video/webm',
          mp3: 'audio/mpeg',
          ogg: 'audio/ogg',
          json: 'application/json',
          csv: 'text/csv',
          md: 'text/markdown',
          txt: 'text/plain',
        };
        const mimeType = mimeMap[ext] ?? 'application/octet-stream';
        const stat = statSync(attachFilePath);
        const artifact: import('./deliverables.js').ArtifactRef = {
          id: newUlid(),
          name: attachName ?? basename(attachFilePath),
          role: 'file',
          format: mimeType.startsWith('image/')
            ? 'image'
            : mimeType.startsWith('video/')
              ? 'video'
              : mimeType.startsWith('audio/')
                ? 'audio'
                : mimeType === 'application/json'
                  ? 'json'
                  : mimeType === 'text/csv'
                    ? 'csv'
                    : mimeType === 'text/markdown'
                      ? 'markdown'
                      : mimeType === 'text/plain'
                        ? 'text'
                        : 'file',
          mimeType,
          filePath: attachFilePath,
          size: stat.size,
          createdAt: Date.now(),
        };
        const updated = await ctx.deliverableStore.attachArtifact(deliverableId, artifact);
        if (!updated) return buildErrorResponse(id, 404, `Deliverable not found: ${deliverableId}`);
        return { id, result: updated };
      }

      case 'deliverable.batchPublish': {
        const { deliverableId } = (params ?? {}) as { deliverableId?: string };
        if (!deliverableId) return buildErrorResponse(id, -32602, 'deliverableId is required');
        const deliverable = await ctx.deliverableStore.get(deliverableId);
        if (!deliverable)
          return buildErrorResponse(id, 404, `Deliverable not found: ${deliverableId}`);
        const pending = (deliverable.publications ?? []).filter(
          (pub) => pub.status === 'available' || pub.status === 'planned',
        );
        const results: Array<{ publicationId: string; ok: boolean; detail?: string }> = [];
        for (const pub of pending) {
          try {
            const result = await publishDeliverableToTarget(ctx, deliverable, pub.id);
            results.push({ publicationId: pub.id, ok: result.ok, detail: result.detail });
          } catch (err) {
            results.push({ publicationId: pub.id, ok: false, detail: String(err) });
          }
        }
        return { id, result: { deliverableId, results, total: pending.length } };
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
