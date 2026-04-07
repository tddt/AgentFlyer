import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { executeAgentTurnViaKernel } from '../agent/kernel-turn-executor.js';
import type { AgentRunner } from '../agent/runner.js';
import { createLogger } from '../core/logger.js';
import { type AgentId, type TaskId, asTaskId } from '../core/types.js';
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

class MeshTaskRecordStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, 'mesh-dispatcher-tasks.json');
  }

  load(): TaskRecord[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as TaskRecord[];
      logger.info('Loaded mesh dispatcher tasks', { count: parsed.length });
      return parsed;
    } catch (error) {
      logger.warn('Failed to load mesh-dispatcher-tasks.json, starting fresh', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  save(records: Iterable<TaskRecord>): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(Array.from(records), null, 2), 'utf-8');
    } catch (error) {
      logger.error('Failed to save mesh-dispatcher-tasks.json', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export interface MeshTaskDispatcherOptions {
  dataDir?: string;
}

/**
 * MeshTaskDispatcher: routes spawn/send requests to local AgentRunners
 * via the MeshBus. In Phase 1 this is entirely in-process.
 */
export class MeshTaskDispatcher {
  private tasks = new Map<TaskId, TaskRecord>();
  private runners = new Map<AgentId, AgentRunner>();
  private readonly dataDir?: string;
  private readonly taskStore: MeshTaskRecordStore | null;

  constructor(
    private readonly bus: MeshBus,
    options: MeshTaskDispatcherOptions = {},
  ) {
    this.dataDir = options.dataDir;
    this.taskStore = options.dataDir ? new MeshTaskRecordStore(options.dataDir) : null;
    if (this.taskStore) {
      for (const record of this.taskStore.load()) {
        this.tasks.set(record.taskId, record);
      }
      this.normalizeInterruptedTasks();
    }
  }

  registerRunner(agentId: AgentId, runner: AgentRunner): void {
    this.runners.set(agentId, runner);
    logger.debug('Runner registered with dispatcher', { agentId });
  }

  async spawn(agentId: AgentId, instruction: string): Promise<TaskId> {
    const runner = this.runners.get(agentId);
    if (!runner) {
      throw new Error(`No runner registered for agent: ${agentId}`);
    }

    const taskId = asTaskId(ulid());
    const record: TaskRecord = {
      taskId,
      agentId,
      instruction,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.tasks.set(taskId, record);
    this.saveTasks();

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
    this.saveTasks();

    try {
      const result = await executeAgentTurnViaKernel({
        runners: new Map([[record.agentId, runner]]),
        dataDir: this.dataDir,
        input: {
          agentId: record.agentId,
          userMessage: instruction,
          threadKey: `mesh-task-${taskId}`,
        },
      });
      record.status = 'done';
      record.output = result.text;
    } catch (err) {
      record.status = 'error';
      record.error = String(err);
    } finally {
      record.updatedAt = Date.now();
      this.saveTasks();
    }
  }

  getTask(taskId: TaskId): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(): TaskRecord[] {
    return Array.from(this.tasks.values());
  }

  private normalizeInterruptedTasks(now = Date.now()): void {
    let mutated = false;
    for (const record of this.tasks.values()) {
      if (record.status === 'pending' || record.status === 'running') {
        record.status = 'error';
        record.error = 'Task interrupted by gateway restart before completion.';
        record.updatedAt = now;
        mutated = true;
      }
    }
    if (mutated) {
      this.saveTasks();
    }
  }

  private saveTasks(): void {
    this.taskStore?.save(this.tasks.values());
  }
}
