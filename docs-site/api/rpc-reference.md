# RPC Reference

All RPC calls use JSON-RPC 2.0 format. Send a `POST /rpc` with:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "agent.run",
  "params": { ... }
}
```

Include your API key in the `Authorization` header:

```
Authorization: Bearer <apiKey>
```

## Roles

| Role | Can call |
|------|----------|
| `admin` | All methods |
| `operator` | agent.*, session.*, memory.*, skills.*, config.get, reload |
| `viewer` | session.list, session.history, agent.status, metrics.get |

## Methods

### agent.run

Start an agent conversation turn.

**Params**: `{ agentId: string; input: string; sessionId?: string }`  
**Result**: `{ output: string; sessionId: string; usage?: TokenUsage }`  
**Min role**: `operator`

### agent.list

**Params**: none  
**Result**: `{ agents: AgentInfo[] }`  
**Min role**: `viewer`

### agent.status

**Params**: `{ agentId: string }`  
**Result**: `{ status: "idle" | "running" | "error"; lastRun?: number }`  
**Min role**: `viewer`

### session.list

**Params**: `{ agentId?: string }`  
**Result**: `{ sessions: SessionSummary[] }`  
**Min role**: `viewer`

### session.history

**Params**: `{ sessionId: string }`  
**Result**: `{ messages: Message[] }`  
**Min role**: `viewer`

### session.clear

**Params**: `{ sessionId: string }`  
**Result**: `{ ok: true }`  
**Min role**: `operator`

### config.get

**Params**: none  
**Result**: current config object (sensitive fields redacted)  
**Min role**: `admin`

### config.save

**Params**: partial config object  
**Result**: `{ ok: true }`  
**Min role**: `admin`

### config.reload

**Params**: none  
**Result**: `{ reloaded: string[] }` — list of restarted agent ids  
**Min role**: `admin`

### memory.get

**Params**: `{ agentId: string; key?: string }`  
**Result**: `{ entries: MemoryEntry[] }`  
**Min role**: `operator`

### memory.set

**Params**: `{ agentId: string; key: string; value: unknown }`  
**Result**: `{ ok: true }`  
**Min role**: `operator`

### memory.delete

**Params**: `{ agentId: string; key: string }`  
**Result**: `{ ok: true }`  
**Min role**: `operator`

### skills.list

**Params**: `{ agentId?: string }`  
**Result**: `{ skills: SkillInfo[] }`  
**Min role**: `operator`
