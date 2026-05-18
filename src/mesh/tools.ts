import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import {
  getAgentTurnRunViaKernel,
  resumeAgentTurnViaKernel,
  startAgentTurnViaKernel,
  waitForAgentTurnViaKernel,
} from '../agent/kernel-turn-executor.js';
import type { AgentRunner } from '../agent/runner.js';
import { createLogger } from '../core/logger.js';
import { type AgentId, type TaskId, asTaskId } from '../core/types.js';
import type { MeshBus } from './bus.js';

const logger = createLogger('mesh:tools');

export interface TaskRecord {
  taskId: TaskId;
  agentId: AgentId;
  instruction: string;
  status: 'pending' | 'running' | 'suspended' | 'done' | 'error' | 'cancelled';
  runId?: string;
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

    try {
      const started = await startAgentTurnViaKernel({
        runners: new Map([[agentId, runner]]),
        dataDir: this.dataDir,
        input: {
          agentId,
          userMessage: instruction,
          threadKey: `mesh-task-${taskId}`,
        },
      });
      record.status = 'running';
      record.runId = started.runId;
      record.updatedAt = Date.now();
      this.saveTasks();
      this.watchTask(taskId, runner).catch((err) => {
        logger.error('Task failed unexpectedly', { taskId, error: String(err) });
      });
    } catch (err) {
      record.status = 'error';
      record.error = String(err);
      record.updatedAt = Date.now();
      this.saveTasks();
    }

    return taskId;
  }

  async resume(taskId: TaskId): Promise<TaskRecord | null> {
    const record = this.tasks.get(taskId);
    if (!record) {
      return null;
    }
    if (record.status !== 'suspended' || !record.runId) {
      return record;
    }
    const runner = this.runners.get(record.agentId);
    if (!runner) {
      record.status = 'error';
      record.error = `Agent '${record.agentId}' is no longer available.`;
      record.updatedAt = Date.now();
      this.saveTasks();
      return record;
    }

    await resumeAgentTurnViaKernel({
      runners: new Map([[record.agentId, runner]]),
      dataDir: this.dataDir,
      runId: record.runId,
    });
    record.status = 'running';
    record.error = undefined;
    record.updatedAt = Date.now();
    this.saveTasks();
    this.watchTask(taskId, runner).catch((err) => {
      logger.error('Task failed unexpectedly after resume', { taskId, error: String(err) });
    });
    return record;
  }

  private async watchTask(taskId: TaskId, runner: AgentRunner): Promise<void> {
    const record = this.tasks.get(taskId);
    if (!record?.runId) return;

    try {
      const result = await waitForAgentTurnViaKernel({
        runners: new Map([[record.agentId, runner]]),
        dataDir: this.dataDir,
        runId: record.runId,
      });
      record.status = 'done';
      record.output = result.text;
    } catch (err) {
      const current = await getAgentTurnRunViaKernel({
        runners: new Map([[record.agentId, runner]]),
        dataDir: this.dataDir,
        runId: record.runId,
      });
      if (current?.processStatus === 'suspended' || current?.phase === 'suspended') {
        record.status = 'suspended';
        record.error = current.error?.message ?? String(err);
      } else {
        record.status = 'error';
        record.error = String(err);
      }
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
      if (
        record.status === 'pending' ||
        record.status === 'running' ||
        record.status === 'suspended'
      ) {
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
