import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { AgentConfig } from '../../core/config/schema.js';
import { createLogger } from '../../core/logger.js';
import { executeAgentTurnViaKernel } from '../kernel-turn-executor.js';
import type { AgentRunner } from '../runner.js';
import type { RegisteredTool } from './registry.js';

const logger = createLogger('tools:mesh');

// RATIONALE: default per-turn timeout caps how long a caller blocks waiting for
// a remote agent turn. 5 min is generous for agentic tasks; callers may pass
// timeout_s to mesh_send/mesh_spawn to override.
const DEFAULT_TASK_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

async function runMeshTurn(options: {
  agentId: string;
  runner: AgentRunner;
  message: string;
  threadKey: string;
  dataDir: string;
  timeoutMs: number;
  label: string;
}): Promise<string> {
  const turnPromise = executeAgentTurnViaKernel({
    runners: new Map([[options.agentId, options.runner]]),
    dataDir: options.dataDir,
    input: {
      agentId: options.agentId,
      userMessage: options.message,
      threadKey: options.threadKey,
    },
  }).then((result) => result.text || '(no output)');

  return await withTimeout(turnPromise, options.timeoutMs, options.label);
}

/**
 * Race `promise` against a deadline.  Rejects with a timeout error if
 * `ms` elapses first.  The original promise continues running in the
 * background — callers should treat timeout as "give up waiting", not
 * "work cancelled".
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}: timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

// ── Async task store (in-process) ──────────────────────────────────────────

interface TaskEntry {
  taskId: string;
  agentId: string;
  message: string;
  threadKey: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
  result?: string;
  error?: string;
  startedAt: number;
  doneAt?: number;
  /** Milliseconds after which a still-running task is auto-expired. */
  timeoutMs: number;
}

class MeshTaskStore {
  private readonly filePath: string;
  private tasks = new Map<string, TaskEntry>();
  // RATIONALE: write-behind debounce — serial write chain prevents concurrent
  // writeFile calls; drain() lets tests await all pending writes.
  private pendingWrite = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, 'mesh-tasks.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const arr = JSON.parse(raw) as TaskEntry[];
      for (const entry of arr) {
        this.tasks.set(entry.taskId, entry);
      }
      logger.info('Loaded mesh tasks', { count: this.tasks.size });
    } catch (err) {
      logger.warn('Failed to load mesh-tasks.json, starting fresh', { error: String(err) });
    }
  }

  private save(): void {
    // Debounce: coalesce rapid successive mutations into one write per tick.
    if (this.pendingWrite) return;
    this.pendingWrite = true;
    // Chain onto writeChain so writes are serial and drain() is reliable.
    this.writeChain = this.writeChain.then(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      this.pendingWrite = false;
      const data = JSON.stringify(Array.from(this.tasks.values()), null, 2);
      await writeFile(this.filePath, data, 'utf-8').catch((err: unknown) => {
        logger.error('Failed to save mesh-tasks.json', { error: String(err) });
      });
    });
  }

  /** Flush in-memory state to disk immediately. Used for startup migration. */
  flush(): Promise<void> {
    this.pendingWrite = false; // cancel any queued debounced write
    const data = JSON.stringify(Array.from(this.tasks.values()), null, 2);
    const p = writeFile(this.filePath, data, 'utf-8').catch((err: unknown) => {
      logger.error('Failed to flush mesh-tasks.json', { error: String(err) });
    });
    this.writeChain = p; // reset chain so drain() waits for this write
    return p;
  }

  /** Wait for all pending deferred saves. Use in tests and graceful shutdown. */
  drain(): Promise<void> {
    return this.writeChain;
  }

  get(taskId: string): TaskEntry | undefined {
    return this.tasks.get(taskId);
  }

  set(entry: TaskEntry): void {
    this.tasks.set(entry.taskId, entry);
    this.save();
  }

  update(taskId: string, patch: Partial<TaskEntry>): void {
    const existing = this.tasks.get(taskId);
    if (!existing) return;
    Object.assign(existing, patch);
    this.save();
  }

  all(): TaskEntry[] {
    return Array.from(this.tasks.values());
  }

  normalizeInterrupted(now = Date.now()): Promise<void> {
    let mutated = false;
    for (const entry of this.tasks.values()) {
      if (entry.status === 'pending' || entry.status === 'running') {
        entry.status = 'error';
        entry.error = 'Task interrupted by gateway restart before completion.';
        entry.doneAt = now;
        mutated = true;
      }
    }
    if (mutated) {
      // RATIONALE: startup recovery must persist synchronously so the next
      // process load immediately sees the corrected state.
      return this.flush();
    }
    return Promise.resolve();
  }
}

const sharedTaskStores = new Map<string, MeshTaskStore>();
const restoredTaskStores = new Set<string>();
// RATIONALE: startup normalisation is async (flush to disk). Callers that need
// to read the persisted state immediately after createMeshTools() can await the
// promise stored here before they proceed.
const meshInitPromises = new Map<string, Promise<void>>();

/** Await the async startup flush for the given dataDir, if any. */
export function waitForMeshInit(dataDir: string): Promise<void> {
  return meshInitPromises.get(dataDir) ?? Promise.resolve();
}

/** Await all pending deferred writes for a given dataDir. Use in tests. */
export function waitForMeshDrain(dataDir: string): Promise<void> {
  return sharedTaskStores.get(dataDir)?.drain() ?? Promise.resolve();
}

// ── Tool factory ────────────────────────────────────────────────────────────

/**
 * Create real mesh tools wired to the in-process runner map.
 * @param runners  Map of agentId → AgentRunner (passed by reference; populated before first call)
 * @param agentConfigs  Full agent config list for name/role display in mesh_list
 */
export function createMeshTools(
  runners: Map<string, AgentRunner>,
  dataDir: string,
  agentConfigs: AgentConfig[] = [],
): RegisteredTool[] {
  let store = sharedTaskStores.get(dataDir);
  if (!store) {
    store = new MeshTaskStore(dataDir);
    sharedTaskStores.set(dataDir, store);
  }
  const taskStore = store;
  if (!restoredTaskStores.has(dataDir)) {
    restoredTaskStores.add(dataDir);
    const initPromise = taskStore.normalizeInterrupted();
    meshInitPromises.set(dataDir, initPromise);
  }

  // Build a quick lookup for names/roles
  const configMap = new Map(agentConfigs.map((c) => [c.id, c]));

  // ── mesh_list ───────────────────────────────────────────────────────────
  const meshList: RegisteredTool = {
    category: 'mesh',
    definition: {
      name: 'mesh_list',
      description:
        'List all available agents on the local mesh. Returns agent IDs, display names, and roles.',
      inputSchema: { type: 'object', properties: {} },
    },
    async handler(_input) {
      if (runners.size === 0) {
        return { isError: false, content: 'No agents registered on the mesh.' };
      }
      const lines = Array.from(runners.keys()).map((id) => {
        const cfg = configMap.get(id);
        const runner = runners.get(id);
        const name = cfg?.name ? ` | name: "${cfg.name}"` : '';
        const role = cfg?.mesh?.role ?? 'worker';
        const status = runner?.isRunning ? ' | status: busy' : ' | status: idle';
        return `- id: ${id}${name} | role: ${role}${status}`;
      });
      return {
        isError: false,
        content: `Available agents (use the 'id' field for mesh_send):\n${lines.join('\n')}`,
      };
    },
  };

  // ── mesh_send ───────────────────────────────────────────────────────────
  // Synchronous delegation: blocks until the target agent finishes its turn.
  const meshSend: RegisteredTool = {
    category: 'mesh',
    definition: {
      name: 'mesh_send',
      description:
        'Delegate a task to a specific agent and wait for its response. ' +
        'Use mesh_list first to discover available agent IDs. ' +
        'Returns an error immediately if the target agent is busy.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: 'Target agent ID (from mesh_list)',
          },
          message: {
            type: 'string',
            description: 'Instruction or task to send to the agent',
          },
          thread: {
            type: 'string',
            description: 'Optional thread key for session continuity (default: auto-generated)',
          },
          timeout_s: {
            type: 'number',
            description: `Seconds to wait before giving up (default: ${DEFAULT_TASK_TIMEOUT_MS / 1000})`,
          },
        },
        required: ['agent_id', 'message'],
      },
    },
    async handler(input) {
      const { agent_id, message, thread, timeout_s } = input as {
        agent_id: string;
        message: string;
        thread?: string;
        timeout_s?: number;
      };

      const runner = runners.get(agent_id);
      if (!runner) {
        const available = Array.from(runners.keys()).join(', ');
        return {
          isError: true,
          content: `Agent '${agent_id}' not found. Available: ${available || 'none'}`,
        };
      }

      // Immediately reject if the agent is already processing a turn.
      // This prevents the calling agent from blocking forever on a busy peer.
      if (runner.isRunning) {
        return {
          isError: true,
          content: `Agent '${agent_id}' is busy. Use mesh_list to check status, then retry or use mesh_spawn for non-blocking dispatch.`,
        };
      }

      const timeoutMs = typeof timeout_s === 'number' ? timeout_s * 1_000 : DEFAULT_TASK_TIMEOUT_MS;

      // Use an isolated thread so delegated tasks don't pollute the worker's main history.
      const taskThread = thread ?? `mesh-task-${ulid()}`;
      logger.info('mesh_send: delegating task', { agent_id, taskThread, timeoutMs });

      try {
        const output = await runMeshTurn({
          agentId: agent_id,
          runner,
          message,
          threadKey: taskThread,
          dataDir,
          timeoutMs,
          label: `mesh_send to ${agent_id}`,
        });
        logger.info('mesh_send: task complete', { agent_id });
        return { isError: false, content: output || '(agent returned no output)' };
      } catch (err) {
        logger.error('mesh_send: task failed', { agent_id, error: String(err) });
        return { isError: true, content: `Agent '${agent_id}' error: ${String(err)}` };
      }
    },
  };

  // ── mesh_spawn ──────────────────────────────────────────────────────────
  // Fire-and-forget: returns a task ID immediately, runs in background.
  const meshSpawn: RegisteredTool = {
    category: 'mesh',
    definition: {
      name: 'mesh_spawn',
      description:
        'Spawn a task on a specific agent asynchronously. Returns a task ID immediately. ' +
        'Use mesh_status to check progress or retrieve the result.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Target agent ID' },
          message: { type: 'string', description: 'Instruction or task to send' },
          timeout_s: {
            type: 'number',
            description: `Seconds before the task is auto-expired (default: ${DEFAULT_TASK_TIMEOUT_MS / 1000})`,
          },
        },
        required: ['agent_id', 'message'],
      },
    },
    async handler(input) {
      const { agent_id, message, timeout_s } = input as {
        agent_id: string;
        message: string;
        timeout_s?: number;
      };
      const runner = runners.get(agent_id);
      if (!runner) {
        const available = Array.from(runners.keys()).join(', ');
        return {
          isError: true,
          content: `Agent '${agent_id}' not found. Available: ${available || 'none'}`,
        };
      }

      // Reject immediately if agent is busy; caller can retry or poll with mesh_status.
      if (runner.isRunning) {
        return {
          isError: true,
          content: `Agent '${agent_id}' is busy. Retry after the current task finishes (check mesh_list for status).`,
        };
      }

      const timeoutMs = typeof timeout_s === 'number' ? timeout_s * 1_000 : DEFAULT_TASK_TIMEOUT_MS;
      const taskId = ulid();
      const taskThread = `mesh-spawn-${taskId}`;
      taskStore.set({
        taskId,
        agentId: agent_id,
        message,
        threadKey: taskThread,
        status: 'pending',
        startedAt: Date.now(),
        timeoutMs,
      });

      // Run asynchronously — do NOT await
      (async () => {
        const entry = taskStore.get(taskId);
        if (!entry) return;
        taskStore.update(taskId, { status: 'running' });
        try {
          const output = await runMeshTurn({
            agentId: agent_id,
            runner,
            message,
            threadKey: taskThread,
            dataDir,
            timeoutMs,
            label: `mesh_spawn ${taskId}`,
          });
          taskStore.update(taskId, {
            status: 'done',
            result: output || '(no output)',
            doneAt: Date.now(),
          });
          logger.info('mesh_spawn: task done', { taskId, agent_id });
        } catch (err) {
          taskStore.update(taskId, {
            status: 'error',
            error: String(err),
            doneAt: Date.now(),
          });
          logger.error('mesh_spawn: task error', { taskId, agent_id, error: String(err) });
        }
      })().catch(() => undefined);

      return {
        isError: false,
        content: `Task spawned. ID: ${taskId}\nUse mesh_status to check progress.`,
      };
    },
  };

  // ── mesh_status ─────────────────────────────────────────────────────────
  const meshStatus: RegisteredTool = {
    category: 'mesh',
    definition: {
      name: 'mesh_status',
      description: 'Query the status and result of a previously spawned mesh task.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID returned by mesh_spawn' },
        },
        required: ['task_id'],
      },
    },
    async handler(input) {
      const { task_id } = input as { task_id: string };
      const entry = taskStore.get(task_id);
      if (!entry) {
        return { isError: true, content: `Task '${task_id}' not found.` };
      }

      // Auto-expire tasks stuck in running state beyond their timeout.
      if (entry.status === 'running') {
        const elapsed = Date.now() - entry.startedAt;
        if (elapsed > entry.timeoutMs) {
          taskStore.update(task_id, {
            status: 'error',
            error: `Task timed out after ${Math.round(elapsed / 1000)}s (limit: ${Math.round(entry.timeoutMs / 1000)}s). The agent may still be processing in the background.`,
            doneAt: Date.now(),
          });
          logger.warn('mesh_status: auto-expired stuck task', { task_id, elapsed });
        }
      }

      const current = taskStore.get(task_id);
      if (!current) {
        return { isError: true, content: `Task '${task_id}' not found.` };
      }

      const elapsed = Math.round(((current.doneAt ?? Date.now()) - current.startedAt) / 1000);
      if (current.status === 'done') {
        return { isError: false, content: `Status: done (${elapsed}s)\n\n${current.result}` };
      }
      if (current.status === 'error') {
        return { isError: true, content: `Status: error (${elapsed}s)\n${current.error}` };
      }
      if (current.status === 'cancelled') {
        return { isError: false, content: `Status: cancelled (${elapsed}s elapsed)` };
      }
      return { isError: false, content: `Status: ${current.status} (${elapsed}s elapsed)` };
    },
  };

  // ── mesh_broadcast ──────────────────────────────────────────────────────
  // Fan-out: send same message to all agents (or filtered subset). Returns all responses.
  const meshBroadcast: RegisteredTool = {
    category: 'mesh',
    definition: {
      name: 'mesh_broadcast',
      description:
        'Send the same message to all agents (or a filtered subset) in parallel and collect their responses. ' +
        'Useful for polling opinions or gathering information from multiple agents at once.',
      inputSchema: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Message/task to broadcast to every targeted agent',
          },
          agent_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of agent IDs to target. Omit to broadcast to ALL agents.',
          },
          exclude_self: {
            type: 'boolean',
            description: 'Exclude the calling agent from the broadcast (default true)',
          },
          thread_prefix: {
            type: 'string',
            description: 'Optional prefix for thread keys (default: "mesh-bc")',
          },
        },
        required: ['message'],
      },
    },
    async handler(input) {
      const {
        message,
        agent_ids,
        exclude_self = true,
        thread_prefix = 'mesh-bc',
      } = input as {
        message: string;
        agent_ids?: string[];
        exclude_self?: boolean;
        thread_prefix?: string;
      };

      const targets = agent_ids
        ? agent_ids.filter((id) => runners.has(id))
        : Array.from(runners.keys());

      // RATIONALE: We cannot know the calling agent's ID here, so exclude_self is a best-effort
      // hint — callers that know their own ID should pass agent_ids without themselves.
      void exclude_self; // honour by letting callers control agent_ids list

      if (targets.length === 0) {
        return { isError: true, content: 'No target agents available.' };
      }

      const broadcastThread = `${thread_prefix}-${ulid()}`;
      logger.info('mesh_broadcast: starting', { targets, broadcastThread });

      const jobs = targets.map(async (agentId) => {
        const runner = runners.get(agentId);
        if (!runner) return { agentId, ok: false, output: 'Agent not found' };
        // Skip busy agents rather than blocking all others.
        if (runner.isRunning) {
          return { agentId, ok: false, output: 'Agent busy — skipped' };
        }
        try {
          const output = await runMeshTurn({
            agentId,
            runner,
            message,
            threadKey: `${broadcastThread}-${agentId}`,
            dataDir,
            timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
            label: `mesh_broadcast to ${agentId}`,
          });
          return { agentId, ok: true, output };
        } catch (err) {
          return { agentId, ok: false, output: `Error: ${String(err)}` };
        }
      });

      const results = await Promise.all(jobs);
      const formatted = results
        .map((r) => `### ${r.agentId} (${r.ok ? 'OK' : 'ERROR'})\n${r.output}`)
        .join('\n\n---\n\n');
      return {
        isError: false,
        content: `Broadcast to ${targets.length} agent(s):\n\n${formatted}`,
      };
    },
  };

  // ── mesh_discuss ─────────────────────────────────────────────────────────
  // Multi-turn round-robin discussion: agents take turns responding to each other.
  const meshDiscuss: RegisteredTool = {
    category: 'mesh',
    definition: {
      name: 'mesh_discuss',
      description:
        'Run a structured multi-turn discussion between multiple agents. Each agent sees the ' +
        "previous agent's response and adds its own perspective. Returns the full discussion transcript. " +
        'Use this for collaborative analysis, brainstorming, or consensus-building.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'The discussion topic or initial question.',
          },
          agent_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ordered list of agent IDs to participate in the discussion.',
          },
          rounds: {
            type: 'number',
            description: 'Number of full rounds (default 1, max 3).',
          },
          instructions: {
            type: 'string',
            description:
              'Optional instructions added to each turn, e.g. "Be concise, under 150 words."',
          },
        },
        required: ['topic', 'agent_ids'],
      },
    },
    async handler(input) {
      const {
        topic,
        agent_ids,
        rounds = 1,
        instructions = '',
      } = input as {
        topic: string;
        agent_ids: string[];
        rounds?: number;
        instructions?: string;
      };

      if (!Array.isArray(agent_ids) || agent_ids.length < 2) {
        return { isError: true, content: 'mesh_discuss requires at least 2 agent IDs.' };
      }

      const maxRounds = Math.min(Math.max(1, rounds), 3);
      const discussThread = `mesh-discuss-${ulid()}`;
      const transcript: string[] = [`## Discussion: ${topic}\n`];

      let context = topic;
      for (let round = 0; round < maxRounds; round++) {
        for (const agentId of agent_ids) {
          const runner = runners.get(agentId);
          if (!runner) {
            transcript.push(`**${agentId}**: (not available)`);
            continue;
          }
          // Skip busy agents rather than blocking the discussion indefinitely.
          if (runner.isRunning) {
            const entry = `**${agentId}** (Round ${round + 1}): (busy — skipped)`;
            transcript.push(entry);
            context = `${context}\n\n${entry}`;
            continue;
          }

          const prompt = [
            `You are participating in a group discussion. Topic:\n${topic}`,
            round > 0 || agent_ids.indexOf(agentId) > 0 ? `\nDiscussion so far:\n${context}` : '',
            instructions ? `\nInstruction: ${instructions}` : '',
            '\nPlease share your perspective or respond to the above.',
          ]
            .filter(Boolean)
            .join('');

          try {
            const reply = await runMeshTurn({
              agentId,
              runner,
              message: prompt,
              threadKey: `${discussThread}-${agentId}-r${round}`,
              dataDir,
              timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
              label: `mesh_discuss turn for ${agentId}`,
            });
            const cfg = configMap.get(agentId);
            const displayName = cfg?.name ?? agentId;
            const entry = `**${displayName}** (Round ${round + 1}):\n${reply}`;
            transcript.push(entry);
            context = `${context}\n\n${entry}`;
          } catch (err) {
            const errEntry = `**${agentId}**: Error — ${String(err)}`;
            transcript.push(errEntry);
            context = `${context}\n\n${errEntry}`;
          }
        }
      }

      return { isError: false, content: transcript.join('\n\n---\n\n') };
    },
  };

  // ── mesh_cancel ──────────────────────────────────────────────────────────
  // Cancel a spawned task and optionally force-reset a stuck runner.
  const meshCancel: RegisteredTool = {
    category: 'mesh',
    definition: {
      name: 'mesh_cancel',
      description:
        'Cancel a pending or stuck task created by mesh_spawn, and optionally force-reset ' +
        "the agent's runner if it's permanently stuck (e.g. LLM provider unreachable). " +
        'Use this to break out of a deadlocked state.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'Task ID to cancel (from mesh_spawn)',
          },
          force_reset_agent: {
            type: 'string',
            description:
              'Optional: agent ID whose runner should be force-reset (clears busy flag). ' +
              'Only use when you are sure the previous turn will never complete.',
          },
        },
        required: ['task_id'],
      },
    },
    async handler(input) {
      const { task_id, force_reset_agent } = input as {
        task_id: string;
        force_reset_agent?: string;
      };

      const parts: string[] = [];

      // Cancel the task record
      const entry = taskStore.get(task_id);
      if (!entry) {
        parts.push(`Task '${task_id}' not found.`);
      } else if (entry.status === 'done' || entry.status === 'error') {
        parts.push(`Task '${task_id}' already finished (status: ${entry.status}).`);
      } else {
        taskStore.update(task_id, {
          status: 'cancelled',
          doneAt: Date.now(),
        });
        logger.info('mesh_cancel: task cancelled', { task_id });
        parts.push(`Task '${task_id}' cancelled.`);
      }

      // Optionally force-reset a stuck runner
      if (force_reset_agent) {
        const runner = runners.get(force_reset_agent);
        if (!runner) {
          parts.push(`Agent '${force_reset_agent}' not found.`);
        } else if (!runner.isRunning) {
          parts.push(`Agent '${force_reset_agent}' is not busy — no reset needed.`);
        } else {
          runner.forceReset();
          parts.push(
            `Agent '${force_reset_agent}' runner force-reset. The orphaned turn may still complete in the background.`,
          );
        }
      }

      return { isError: false, content: parts.join('\n') };
    },
  };

  // ── mesh_plan ────────────────────────────────────────────────────────────
  // Parallel (or serial) multi-agent task orchestration with optional aggregation.
  const meshPlan: RegisteredTool = {
    category: 'mesh',
    definition: {
      name: 'mesh_plan',
      description:
        'Execute a structured plan of sub-tasks across multiple agents, then optionally ' +
        'aggregate the results. Tasks may run in parallel (default) or serially. ' +
        'Use this for divide-and-conquer workflows where you want to split a goal ' +
        'into independent sub-tasks and collect all outputs.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: {
            type: 'string',
            description: 'High-level goal description (informational, included in output header).',
          },
          tasks: {
            type: 'array',
            description: 'List of sub-tasks to execute.',
            items: {
              type: 'object',
              properties: {
                agent_id: { type: 'string', description: 'Target agent ID (from mesh_list).' },
                instruction: { type: 'string', description: 'Task instruction for the agent.' },
              },
              required: ['agent_id', 'instruction'],
            },
          },
          parallel: {
            type: 'boolean',
            description:
              'Run all tasks in parallel (default: true). Set false for serial execution.',
          },
          timeout_s: {
            type: 'number',
            description: `Per-task timeout in seconds (default: ${DEFAULT_TASK_TIMEOUT_MS / 1000}).`,
          },
          aggregation_prompt: {
            type: 'string',
            description:
              'If provided, ask the calling agent to synthesize all task results ' +
              'into a single answer using this prompt as context prefix.',
          },
        },
        required: ['goal', 'tasks'],
      },
    },
    async handler(input) {
      const {
        goal,
        tasks,
        parallel = true,
        timeout_s,
        aggregation_prompt,
      } = input as {
        goal: string;
        tasks: Array<{ agent_id: string; instruction: string }>;
        parallel?: boolean;
        timeout_s?: number;
        aggregation_prompt?: string;
      };

      if (!Array.isArray(tasks) || tasks.length === 0) {
        return { isError: true, content: 'mesh_plan requires at least one task.' };
      }

      const timeoutMs = typeof timeout_s === 'number' ? timeout_s * 1_000 : DEFAULT_TASK_TIMEOUT_MS;
      const planId = ulid();
      logger.info('mesh_plan: starting', { goal, taskCount: tasks.length, parallel, planId });

      type TaskOutcome = { agentId: string; instruction: string; ok: boolean; output: string };

      async function runOne(agentId: string, instruction: string): Promise<TaskOutcome> {
        const runner = runners.get(agentId);
        if (!runner) {
          return { agentId, instruction, ok: false, output: `Agent '${agentId}' not found.` };
        }
        if (runner.isRunning) {
          return {
            agentId,
            instruction,
            ok: false,
            output: `Agent '${agentId}' is busy — skipped.`,
          };
        }
        const taskThread = `mesh-plan-${planId}-${agentId}-${ulid()}`;
        try {
          const output = await runMeshTurn({
            agentId,
            runner,
            message: instruction,
            threadKey: taskThread,
            dataDir,
            timeoutMs,
            label: `mesh_plan task for ${agentId}`,
          });
          return { agentId, instruction, ok: true, output };
        } catch (err) {
          return { agentId, instruction, ok: false, output: `Error: ${String(err)}` };
        }
      }

      let outcomes: TaskOutcome[];
      if (parallel) {
        outcomes = await Promise.all(tasks.map((t) => runOne(t.agent_id, t.instruction)));
      } else {
        outcomes = [];
        for (const t of tasks) {
          outcomes.push(await runOne(t.agent_id, t.instruction));
        }
      }

      const successCount = outcomes.filter((o) => o.ok).length;
      logger.info('mesh_plan: all tasks settled', { planId, successCount, total: tasks.length });

      const resultSections = outcomes.map((o, i) => {
        const cfg = configMap.get(o.agentId);
        const name = cfg?.name ?? o.agentId;
        const status = o.ok ? 'OK' : 'ERROR';
        return `### Task ${i + 1} — ${name} (${status})\nInstruction: ${o.instruction}\n\n${o.output}`;
      });

      const header = `## Plan: ${goal}\n${successCount}/${tasks.length} tasks succeeded.\n\n`;
      const body = resultSections.join('\n\n---\n\n');
      const content = header + body;

      // Append aggregation prompt as a tail note so the LLM calling mesh_plan
      // can use it to synthesize the results in its next turn.
      if (aggregation_prompt) {
        return {
          isError: false,
          content: `${content}\n\n---\n\n## Aggregation Prompt\n${aggregation_prompt}`,
        };
      }
      return { isError: false, content };
    },
  };

  // ── mesh_ping ───────────────────────────────────────────────────────────
  const meshPing: RegisteredTool = {
    category: 'mesh',
    definition: {
      name: 'mesh_ping',
      description:
        'Ping a target agent to verify it is reachable and measure round-trip latency. ' +
        'Returns a PONG with the agent status (idle/busy) and latency in milliseconds. ' +
        'Does not start a new LLM turn.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: 'ID of the agent to ping.',
          },
        },
        required: ['agent_id'],
      },
    },
    async handler(input) {
      const { agent_id } = input as { agent_id: string };
      const t0 = Date.now();
      const runner = runners.get(agent_id);
      if (!runner) {
        const available = Array.from(runners.keys()).join(', ') || 'none';
        return {
          isError: true,
          content: `Agent '${agent_id}' not found. Available agents: ${available}`,
        };
      }
      const cfg = configMap.get(agent_id);
      const name = cfg?.name ? ` (${cfg.name})` : '';
      const status = runner.isRunning ? 'busy' : 'idle';
      const latencyMs = Date.now() - t0;
      return {
        isError: false,
        content: `PONG ${agent_id}${name} — status: ${status}, latency: ${latencyMs}ms`,
      };
    },
  };

  return [
    meshList,
    meshSend,
    meshSpawn,
    meshStatus,
    meshBroadcast,
    meshDiscuss,
    meshCancel,
    meshPlan,
    meshPing,
  ];
}

/**
 * Legacy stub factory — kept for backwards compat; prefer createMeshTools().
 * Returns stubs that report "mesh not enabled" until runners are wired up.
 */
export function createMeshToolStubs(): RegisteredTool[] {
  const stub = (name: string, description: string): RegisteredTool => ({
    category: 'mesh',
    definition: {
      name,
      description,
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    },
    async handler(_input) {
      return { isError: true, content: `${name}: mesh is not enabled in this session.` };
    },
  });

  return [
    stub('mesh_list', 'List available agents on the mesh.'),
    stub('mesh_spawn', 'Spawn a sub-agent on the mesh to handle a delegated task.'),
    stub('mesh_send', 'Send a task to a specific agent on the mesh by agent ID.'),
    stub('mesh_status', 'Query the status of a previously spawned mesh task.'),
    stub('mesh_broadcast', 'Broadcast a message to all agents in parallel and collect responses.'),
    stub('mesh_discuss', 'Run a structured multi-turn discussion between multiple agents.'),
    stub(
      'mesh_cancel',
      'Cancel a pending or stuck mesh task and optionally force-reset the agent runner.',
    ),
  ];
}
