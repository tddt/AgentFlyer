import { useEffect, useMemo, useState } from 'react';
import type { AgentActivityInfo, AgentInfo, AgentListResult } from '../types.js';
import { rpc, useQuery } from './useRpc.js';

type AgentActivityById = Record<string, AgentActivityInfo>;

const activityListeners = new Set<(snapshot: AgentActivityById) => void>();

let activitySnapshot: AgentActivityById = {};
let activityEventSource: EventSource | null = null;

function emitActivitySnapshot(): void {
  const nextSnapshot = { ...activitySnapshot };
  for (const listener of activityListeners) {
    listener(nextSnapshot);
  }
}

function ensureActivityEventSource(): void {
  if (activityEventSource || typeof window === 'undefined') {
    return;
  }

  const token = window.__AF_TOKEN__;
  const eventSource = new EventSource(
    `${window.location.origin}/api/agent-activity?token=${token}`,
  );

  eventSource.onmessage = (event: MessageEvent<string>) => {
    try {
      const data = JSON.parse(event.data) as {
        agentId?: string;
        activity?: AgentActivityInfo | null;
      };
      if (!data.agentId || !data.activity) {
        return;
      }
      activitySnapshot = {
        ...activitySnapshot,
        [data.agentId]: data.activity,
      };
      emitActivitySnapshot();
    } catch {
      // Ignore malformed activity events.
    }
  };

  activityEventSource = eventSource;
}

function subscribeActivity(listener: (snapshot: AgentActivityById) => void): () => void {
  activityListeners.add(listener);
  listener({ ...activitySnapshot });
  ensureActivityEventSource();

  return () => {
    activityListeners.delete(listener);
    if (activityListeners.size === 0) {
      activityEventSource?.close();
      activityEventSource = null;
    }
  };
}

export function useAgentActivityStream(): AgentActivityById {
  const [snapshot, setSnapshot] = useState<AgentActivityById>(() => ({ ...activitySnapshot }));

  useEffect(() => subscribeActivity(setSnapshot), []);

  return snapshot;
}

export function useAgentsWithActivity(): {
  agents: AgentInfo[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const streamedActivityByAgentId = useAgentActivityStream();
  const { data: agentsResult, loading, error, refetch } = useQuery<AgentListResult>(
    () => rpc<AgentListResult>('agent.list'),
  );

  const agents = useMemo(
    () =>
      (Array.isArray(agentsResult?.agents) ? agentsResult.agents : []).map((agent) => ({
        ...agent,
        activity: streamedActivityByAgentId[agent.agentId] ?? agent.activity,
      })),
    [agentsResult?.agents, streamedActivityByAgentId],
  );

  return {
    agents,
    loading,
    error,
    refetch,
  };
}