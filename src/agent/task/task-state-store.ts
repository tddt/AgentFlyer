import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWriteFile, readFileText } from '../../core/runtime-compat.js';
import type { TaskRunState } from './task-run-state.js';

export interface TaskRunStateStore {
  save(state: TaskRunState): Promise<void>;
  load(taskId: string): Promise<TaskRunState | null>;
  list(): Promise<TaskRunState[]>;
  delete(taskId: string): Promise<void>;
}

export class JsonTaskRunStateStore implements TaskRunStateStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'task-run-states.json');
  }

  async save(state: TaskRunState): Promise<void> {
    const states = await this.readStates();
    const index = states.findIndex((candidate) => candidate.taskId === state.taskId);
    if (index >= 0) {
      states[index] = state;
    } else {
      states.push(state);
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    await atomicWriteFile(this.filePath, JSON.stringify(states, null, 2));
  }

  async load(taskId: string): Promise<TaskRunState | null> {
    const state = (await this.readStates()).find((candidate) => candidate.taskId === taskId);
    return state ?? null;
  }

  async list(): Promise<TaskRunState[]> {
    return await this.readStates();
  }

  async delete(taskId: string): Promise<void> {
    const states = await this.readStates();
    const nextStates = states.filter((state) => state.taskId !== taskId);
    if (nextStates.length !== states.length) {
      await atomicWriteFile(this.filePath, JSON.stringify(nextStates, null, 2));
    }
  }

  private async readStates(): Promise<TaskRunState[]> {
    try {
      const raw = await readFileText(this.filePath);
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as TaskRunState[]) : [];
    } catch {
      return [];
    }
  }
}
