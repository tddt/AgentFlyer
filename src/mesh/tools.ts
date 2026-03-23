import { ulid } from 'ulid';
import type { AgentRunner } from '../agent/runner.js';
import { createLogger } from '../core/logger.js';
import type { AgentId, TaskId } from '../core/types.js';
import type { MeshBus } from './bus.js';

const logger = createLogger('mesh:tools');

export interface TaskRecord {
  taskId: TaskId;
  agentId: AgentId;
  instruction: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
  output?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * MeshTaskDispatcher: routes spawn/send requests to local AgentRunners
 * via the MeshBus. In Phase 1 this is entirely in-process.
 */
export class MeshTaskDispatcher {
  private tasks = new Map<TaskId, TaskRecord>();
  private runners = new Map<AgentId, AgentRunner>();

  constructor(private readonly bus: MeshBus) {}

  registerRunner(agentId: AgentId, runner: AgentRunner): void {
    this.runners.set(agentId, runner);
    logger.debug('Runner registered with dispatcher', { agentId });
  }

  async spawn(agentId: AgentId, instruction: string): Promise<TaskId> {
    const runner = this.runners.get(agentId);
    if (!runner) {
      throw new Error(`No runner registered for agent: ${agentId}`);
    }

    const taskId = ulid() as TaskId;
    const record: TaskRecord = {
      taskId,
      agentId,
      instruction,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.set(taskId, record);

    // Run asynchronously
    this.runTask(taskId, runner, instruction).catch((err) => {
      logger.error('Task failed unexpectedly', { taskId, error: String(err) });
    });

    return taskId;
  }

  private async runTask(taskId: TaskId, runner: AgentRunner, instruction: string): Promise<void> {
    const record = this.tasks.get(taskId);
    if (!record) return;

    record.status = 'running';
    record.updatedAt = Date.now();

    try {
      const result = await runner.runTurn(instruction);
      record.status = 'done';
      record.output = result.text;
    } catch (err) {
      record.status = 'error';
      record.error = String(err);
    } finally {
      record.updatedAt = Date.now();
    }
  }

  getTask(taskId: TaskId): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(): TaskRecord[] {
    return Array.from(this.tasks.values());
  }
}
