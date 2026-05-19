import { useEffect, useState } from 'react';
import type { RunningTaskInfo } from '../types.js';
import { rpc } from './useRpc.js';

type SchedulerRunningSnapshot = RunningTaskInfo[];

const runningListeners = new Set<(snapshot: SchedulerRunningSnapshot) => void>();

let runningSnapshot: SchedulerRunningSnapshot = [];
let runningEventSource: EventSource | null = null;
let runningRefreshPromise: Promise<void> | null = null;

function emitRunningSnapshot(): void {
  const nextSnapshot = [...runningSnapshot];
  for (const listener of runningListeners) {
    listener(nextSnapshot);
  }
}

function setRunningSnapshot(snapshot: SchedulerRunningSnapshot): void {
  runningSnapshot = [...snapshot];
  emitRunningSnapshot();
}

async function fetchRunningSnapshot(): Promise<void> {
  try {
    const result = await rpc<{ running: RunningTaskInfo[] }>('scheduler.running');
    setRunningSnapshot(result.running ?? []);
  } catch {
    // Keep the previous snapshot when refresh fails.
  }
}

export async function refreshSchedulerRunningTasks(): Promise<void> {
  if (!runningRefreshPromise) {
    runningRefreshPromise = fetchRunningSnapshot().finally(() => {
      runningRefreshPromise = null;
    });
  }
  await runningRefreshPromise;
}

function ensureRunningEventSource(): void {
  if (runningEventSource || typeof window === 'undefined') {
    return;
  }

  const token = window.__AF_TOKEN__;
  const eventSource = new EventSource(
    `${window.location.origin}/api/scheduler-activity?token=${token}`,
  );

  eventSource.onmessage = (event: MessageEvent<string>) => {
    try {
      const data = JSON.parse(event.data) as {
        running?: RunningTaskInfo[] | null;
      };
      setRunningSnapshot(data.running ?? []);
    } catch {
      // Ignore malformed scheduler activity events.
    }
  };

  runningEventSource = eventSource;
}

function subscribeRunning(listener: (snapshot: SchedulerRunningSnapshot) => void): () => void {
  runningListeners.add(listener);
  listener([...runningSnapshot]);
  ensureRunningEventSource();
  if (runningSnapshot.length === 0) {
    void refreshSchedulerRunningTasks();
  }

  return () => {
    runningListeners.delete(listener);
    if (runningListeners.size === 0) {
      runningEventSource?.close();
      runningEventSource = null;
    }
  };
}

export function useSchedulerRunningTasks(): {
  runningTasks: RunningTaskInfo[];
  refreshRunningTasks: () => Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<SchedulerRunningSnapshot>(() => [...runningSnapshot]);

  useEffect(() => subscribeRunning(setSnapshot), []);

  return {
    runningTasks: snapshot,
    refreshRunningTasks: refreshSchedulerRunningTasks,
  };
}