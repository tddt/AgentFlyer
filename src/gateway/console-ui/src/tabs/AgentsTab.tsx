import { useCallback, useState } from 'react';
import { Badge } from '../components/Badge.js';
import { Button } from '../components/Button.js';
import { rpc, useQuery } from '../hooks/useRpc.js';
import { useToast } from '../hooks/useToast.js';
import type { AgentConfig, AgentInfo, AgentListResult, SessionListResult } from '../types.js';

interface EditForm {
  name: string;
  model: string;
  persona: string;
  workspace: string;
}

function EditModal({
  agentId,
  current,
  onClose,
  onSaved,
}: {
  agentId: string;
  current: AgentConfig;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<EditForm>({
    name: current.name ?? '',
    model: current.model ?? '',
    persona: current.persona ?? '',
    workspace: current.workspace ?? '',
  });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const fullConfig = await rpc<Record<string, unknown>>('config.get');
      const agents = fullConfig.agents as Record<string, AgentConfig> | AgentConfig[] | undefined;
      let updated: Record<string, AgentConfig> = {};
      if (Array.isArray(agents)) {
        for (const a of agents) updated[a.id] = a;
      } else if (agents) {
        updated = { ...agents };
      }
      updated[agentId] = {
        ...updated[agentId],
        id: agentId,
        name: form.name || undefined,
        model: form.model || undefined,
        persona: form.persona || undefined,
        workspace: form.workspace || undefined,
      };
      await rpc('config.save', { ...fullConfig, agents: updated });
      toast(`Agent ${agentId} saved`, 'success');
      onSaved();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const field = (label: string, key: keyof EditForm, placeholder?: string) => (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-slate-400">{label}</label>
      <input
        className="rounded-lg bg-slate-900/70 ring-1 ring-slate-700 px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-indigo-500"
        value={form[key]}
        placeholder={placeholder}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
      />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-900 ring-1 ring-slate-700 rounded-2xl shadow-2xl w-full max-w-md p-6 flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-100">Edit Agent</h2>
          <span className="font-mono text-xs text-slate-500">{agentId}</span>
        </div>
        <div className="flex flex-col gap-4">
          {field('Name', 'name', 'Display name')}
          {field('Model', 'model', 'e.g. claude-3-5-sonnet-20241022')}
          {field('Workspace', 'workspace', 'Group label (optional)')}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-400">Persona</label>
            <textarea
              rows={4}
              className="rounded-lg bg-slate-900/70 ring-1 ring-slate-700 px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-indigo-500 resize-none"
              value={form.persona}
              placeholder="System prompt / persona…"
              onChange={(e) => setForm((f) => ({ ...f, persona: e.target.value }))}
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={() => void handleSave()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function AgentsTab() {
  const { toast } = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const {
    data: agentsResult,
    loading,
    error,
    refetch,
  } = useQuery<AgentListResult>(() => rpc<AgentListResult>('agent.list'), []);

  const { data: config, refetch: refetchConfig } = useQuery<{
    agents?: AgentConfig[] | Record<string, AgentConfig>;
  }>(() => rpc<{ agents?: AgentConfig[] | Record<string, AgentConfig> }>('config.get'), []);

  const { data: sessionsData } = useQuery<SessionListResult>(
    () => rpc<SessionListResult>('session.list'),
    [],
  );

  // Build agent config map
  const agentConfigs: Record<string, AgentConfig> = {};
  if (Array.isArray(config?.agents)) {
    for (const a of config.agents) agentConfigs[a.id] = a;
  } else if (config?.agents && typeof config.agents === 'object') {
    for (const [id, cfg] of Object.entries(config.agents)) agentConfigs[id] = { id, ...cfg };
  }

  // Session counts per agent
  const sessionCounts: Record<string, number> = {};
  for (const s of sessionsData?.sessions ?? []) {
    sessionCounts[s.agentId] = (sessionCounts[s.agentId] ?? 0) + 1;
  }

  const handleReload = useCallback(
    async (agentId: string) => {
      try {
        await rpc('agent.reload', { agentId });
        toast(`Agent ${agentId} reloaded`, 'success');
        refetch();
        refetchConfig();
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Reload failed', 'error');
      }
    },
    [toast, refetch, refetchConfig],
  );

  const handleClear = useCallback(
    async (agentId: string) => {
      try {
        await rpc('session.clear', { agentId });
        toast(`Sessions cleared for ${agentId}`, 'success');
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Clear failed', 'error');
      }
    },
    [toast],
  );

  if (loading && !agentsResult) return <div className="text-slate-400 text-sm p-8">Loading…</div>;
  if (error) return <div className="text-red-400 text-sm p-8">Error: {error}</div>;

  const list: AgentInfo[] = Array.isArray(agentsResult?.agents) ? agentsResult.agents : [];

  // Group by workspace
  const groups: Record<string, AgentInfo[]> = {};
  for (const a of list) {
    const grp = agentConfigs[a.agentId]?.workspace ?? 'Default';
    (groups[grp] ??= []).push(a);
  }
  const groupEntries = Object.entries(groups).sort(([a], [b]) =>
    a === 'Default' ? 1 : b === 'Default' ? -1 : a.localeCompare(b),
  );

  const editingCfg = editing ? agentConfigs[editing] : null;

  return (
    <div className="flex flex-col gap-6">
      {editing && editingCfg && (
        <EditModal
          agentId={editing}
          current={editingCfg}
          onClose={() => setEditing(null)}
          onSaved={() => {
            refetch();
            refetchConfig();
          }}
        />
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Agents</h1>
          <p className="text-xs text-slate-500 mt-0.5">{list.length} running</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            refetch();
            refetchConfig();
          }}
        >
          Refresh
        </Button>
      </div>

      {groupEntries.map(([workspace, agents]) => (
        <div key={workspace} className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
              {workspace}
            </span>
            <div className="flex-1 h-px bg-slate-700/50" />
            <span className="text-xs text-slate-600">{agents.length}</span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {agents.map((a) => {
              const cfg = agentConfigs[a.agentId];
              const isSelected = selected === a.agentId;
              const sessCount = sessionCounts[a.agentId] ?? 0;
              return (
                <div key={a.agentId} className="flex flex-col">
                  <div
                    className={`rounded-xl bg-slate-800/60 ring-1 transition-all p-4 flex flex-col gap-3 cursor-pointer ${
                      isSelected
                        ? 'ring-indigo-500/60 bg-slate-800'
                        : 'ring-slate-700/50 hover:ring-indigo-500/30'
                    }`}
                    onClick={() => setSelected(isSelected ? null : a.agentId)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-sm font-semibold text-slate-100 truncate">
                          {a.name ?? a.agentId}
                        </span>
                        <span className="text-xs font-mono text-slate-500 truncate">
                          {a.agentId}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Badge variant="green">running</Badge>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {cfg?.model && <Badge variant="blue">{cfg.model}</Badge>}
                      {cfg?.persona && <Badge variant="purple">persona</Badge>}
                      {sessCount > 0 && <Badge variant="gray">{sessCount} sessions</Badge>}
                    </div>

                    <div className="flex gap-2 mt-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(a.agentId);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleReload(a.agentId);
                        }}
                      >
                        Reload
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleClear(a.agentId);
                        }}
                      >
                        Clear Sessions
                      </Button>
                    </div>
                  </div>

                  {/* Expanded config detail */}
                  {isSelected && cfg && (
                    <div className="rounded-b-xl bg-slate-900/70 ring-1 ring-t-0 ring-slate-700/50 px-4 py-3 -mt-1">
                      <pre className="text-xs font-mono text-slate-400 overflow-x-auto whitespace-pre-wrap">
                        {JSON.stringify(cfg, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {list.length === 0 && <p className="text-slate-500 text-sm py-4">No agents running.</p>}
    </div>
  );
}
