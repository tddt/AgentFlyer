import { createHash } from 'node:crypto';

export interface ToolLoopSignal {
  level: 'ok' | 'warn' | 'block';
  repeatCount: number;
  message?: string;
}

export interface ToolLoopDetectorOptions {
  warningThreshold?: number;
  blockThreshold?: number;
}

export interface SerializedToolLoopDetectorState {
  lastEntry: ToolLoopEntry | null;
  consecutiveRepeats: number;
}

interface ToolLoopEntry {
  signature: string;
  toolName: string;
}

const DEFAULT_WARNING_THRESHOLD = 8;
const DEFAULT_BLOCK_THRESHOLD = 15;

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableSerialize(v)}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function hashToolOutcome(
  toolName: string,
  input: unknown,
  result: string,
  isError: boolean,
): string {
  return createHash('sha256')
    .update(toolName)
    .update('\n')
    .update(stableSerialize(input))
    .update('\n')
    .update(result.trim())
    .update('\n')
    .update(isError ? '1' : '0')
    .digest('hex')
    .slice(0, 16);
}

export class ToolLoopDetector {
  private lastEntry: ToolLoopEntry | null = null;
  private consecutiveRepeats = 0;
  private readonly warningThreshold: number;
  private readonly blockThreshold: number;

  constructor(opts: ToolLoopDetectorOptions = {}) {
    this.warningThreshold = opts.warningThreshold ?? DEFAULT_WARNING_THRESHOLD;
    this.blockThreshold = opts.blockThreshold ?? DEFAULT_BLOCK_THRESHOLD;
  }

  serializeState(): SerializedToolLoopDetectorState {
    return {
      lastEntry: this.lastEntry,
      consecutiveRepeats: this.consecutiveRepeats,
    };
  }

  restoreState(state: SerializedToolLoopDetectorState): void {
    this.lastEntry = state.lastEntry;
    this.consecutiveRepeats = state.consecutiveRepeats;
  }

  record(toolName: string, input: unknown, result: string, isError: boolean): ToolLoopSignal {
    const entry: ToolLoopEntry = {
      toolName,
      signature: hashToolOutcome(toolName, input, result, isError),
    };

    if (
      this.lastEntry &&
      this.lastEntry.signature === entry.signature &&
      this.lastEntry.toolName === entry.toolName
    ) {
      this.consecutiveRepeats += 1;
    } else {
      this.lastEntry = entry;
      this.consecutiveRepeats = 1;
    }

    if (this.consecutiveRepeats >= this.blockThreshold) {
      return {
        level: 'block',
        repeatCount: this.consecutiveRepeats,
        message: `检测到工具 ${toolName} 连续 ${this.consecutiveRepeats} 次返回相同结果，已停止本轮以避免无进展循环。`,
      };
    }

    if (this.consecutiveRepeats === this.warningThreshold) {
      return {
        level: 'warn',
        repeatCount: this.consecutiveRepeats,
        message: `工具 ${toolName} 已连续 ${this.consecutiveRepeats} 次返回相同结果，可能陷入无进展循环。`,
      };
    }

    return { level: 'ok', repeatCount: this.consecutiveRepeats };
  }
}
