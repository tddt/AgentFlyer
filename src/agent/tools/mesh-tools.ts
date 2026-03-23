import { ulid } from 'ulid';
import type { AgentConfig } from '../../core/config/schema.js';
import { createLogger } from '../../core/logger.js';
import { parseSessionKey } from '../../core/types.js';
import type { AgentRunner } from '../runner.js';
import type { RegisteredTool } from './registry.js';

const logger = createLogger('tools:mesh');

// ── Async task store (in-process) ──────────────────────────────────────────

interface TaskEntry {
  status: 'pending' | 'running' | 'done' | 'error';
  result?: string;
  error?: string;
  startedAt: number;
  doneAt?: number;
}

const taskStore = new Map<string, TaskEntry>();

// ── Tool factory ────────────────────────────────────────────────────────────

/**
 * Create real mesh tools wired to the in-process runner map.
 * @param runners  Map of agentId → AgentRunner (passed by reference; populated before first call)
 * @param agentConfigs  Full agent config list for name/role display in mesh_list
 */
export function createMeshTools(
  runners: Map<string, AgentRunner>,
  agentConfigs: AgentConfig[] = [],
): RegisteredTool[] {
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
        const name = cfg?.name ? ` | name: "${cfg.name}"` : '';
        const role = cfg?.mesh?.role ?? 'worker';
        return `- id: ${id}${name} | role: ${role}`;
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
        'Use mesh_list first to discover available agent IDs.',
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
        },
        required: ['agent_id', 'message'],
      },
    },
    async handler(input) {
      const { agent_id, message, thread } = input as {
        agent_id: string;
        message: string;
        thread?: string;
      };

      const runner = runners.get(agent_id);
      if (!runner) {
        const available = Array.from(runners.keys()).join(', ');
        return {
          isError: true,
          content: `Agent '${agent_id}' not found. Available: ${available || 'none'}`,
        };
      }

      // Use an isolated thread so delegated tasks don't pollute the worker's main history.
      const taskThread = thread ?? `mesh-task-${ulid()}`;
      const prevThread = runner.currentSessionKey;
      runner.setThread(taskThread);

      logger.info('mesh_send: delegating task', { agent_id, taskThread });

      try {
        let output = '';
        const gen = runner.turn(message);
        let next = await gen.next();
        while (!next.done) {
          const chunk = next.value;
          if (chunk.type === 'text_delta') output += chunk.text;
          next = await gen.next();
        }
        const result = next.value;
        output = result.text || output;
        logger.info('mesh_send: task complete', {
          agent_id,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });
        return { isError: false, content: output || '(agent returned no output)' };
      } catch (err) {
        logger.error('mesh_send: task failed', { agent_id, error: String(err) });
        return { isError: true, content: `Agent '${agent_id}' error: ${String(err)}` };
      } finally {
        // Restore the worker's original thread context
        const parsed = parseSessionKey(prevThread);
        if (parsed) runner.setThread(parsed.threadKey);
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
        },
        required: ['agent_id', 'message'],
      },
    },
    async handler(input) {
      const { agent_id, message } = input as { agent_id: string; message: string };
      const runner = runners.get(agent_id);
      if (!runner) {
        const available = Array.from(runners.keys()).join(', ');
        return {
          isError: true,
          content: `Agent '${agent_id}' not found. Available: ${available || 'none'}`,
        };
      }

      const taskId = ulid();
      const taskThread = `mesh-spawn-${taskId}`;
      taskStore.set(taskId, { status: 'pending', startedAt: Date.now() });

      // Run asynchronously — do NOT await
      (async () => {
        const entry = taskStore.get(taskId)!;
        entry.status = 'running';
        const prevThread = runner.currentSessionKey;
        runner.setThread(taskThread);
        try {
          let output = '';
          const gen = runner.turn(message);
          let next = await gen.next();
          while (!next.done) {
            const chunk = next.value;
            if (chunk.type === 'text_delta') output += chunk.text;
            next = await gen.next();
          }
          const result = next.value;
          entry.status = 'done';
          entry.result = result.text || output || '(no output)';
          entry.doneAt = Date.now();
          logger.info('mesh_spawn: task done', { taskId, agent_id });
        } catch (err) {
          entry.status = 'error';
          entry.error = String(err);
          entry.doneAt = Date.now();
          logger.error('mesh_spawn: task error', { taskId, agent_id, error: String(err) });
        } finally {
          const parsed = parseSessionKey(prevThread);
          if (parsed) runner.setThread(parsed.threadKey);
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
      const elapsed = Math.round(((entry.doneAt ?? Date.now()) - entry.startedAt) / 1000);
      if (entry.status === 'done') {
        return { isError: false, content: `Status: done (${elapsed}s)\n\n${entry.result}` };
      }
      if (entry.status === 'error') {
        return { isError: true, content: `Status: error (${elapsed}s)\n${entry.error}` };
      }
      return { isError: false, content: `Status: ${entry.status} (${elapsed}s elapsed)` };
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
        const prevThread = runner.currentSessionKey;
        runner.setThread(`${broadcastThread}-${agentId}`);
        try {
          let output = '';
          const gen = runner.turn(message);
          let next = await gen.next();
          while (!next.done) {
            const chunk = next.value;
            if (chunk.type === 'text_delta') output += chunk.text;
            next = await gen.next();
          }
          const result = next.value;
          return { agentId, ok: true, output: result.text || output || '(no output)' };
        } catch (err) {
          return { agentId, ok: false, output: `Error: ${String(err)}` };
        } finally {
          const parsed = parseSessionKey(prevThread);
          if (parsed) runner.setThread(parsed.threadKey);
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

          const prompt = [
            `You are participating in a group discussion. Topic:\n${topic}`,
            round > 0 || agent_ids.indexOf(agentId) > 0 ? `\nDiscussion so far:\n${context}` : '',
            instructions ? `\nInstruction: ${instructions}` : '',
            '\nPlease share your perspective or respond to the above.',
          ]
            .filter(Boolean)
            .join('');

          const prevThread = runner.currentSessionKey;
          runner.setThread(`${discussThread}-${agentId}-r${round}`);
          try {
            let output = '';
            const gen = runner.turn(prompt);
            let next = await gen.next();
            while (!next.done) {
              const chunk = next.value;
              if (chunk.type === 'text_delta') output += chunk.text;
              next = await gen.next();
            }
            const result = next.value;
            const reply = result.text || output || '(no response)';
            const cfg = configMap.get(agentId);
            const displayName = cfg?.name ?? agentId;
            const entry = `**${displayName}** (Round ${round + 1}):\n${reply}`;
            transcript.push(entry);
            context = `${context}\n\n${entry}`;
          } catch (err) {
            const errEntry = `**${agentId}**: Error — ${String(err)}`;
            transcript.push(errEntry);
            context = `${context}\n\n${errEntry}`;
          } finally {
            const parsed = parseSessionKey(prevThread);
            if (parsed) runner.setThread(parsed.threadKey);
          }
        }
      }

      return { isError: false, content: transcript.join('\n\n---\n\n') };
    },
  };

  return [meshList, meshSend, meshSpawn, meshStatus, meshBroadcast, meshDiscuss];
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
  ];
}
