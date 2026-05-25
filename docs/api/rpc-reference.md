# RPC Reference

AgentFlyer exposes a JSON-RPC surface at `POST /rpc` for operator tooling, Console UI actions, and automation.

## Request format

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "agent.run",
  "params": {
    "agentId": "main",
    "input": "Summarize today's queue"
  }
}
```

Include a bearer token in the header:

```text
Authorization: Bearer <token>
```

## Permission model

When `users` are configured, AgentFlyer checks method access against the caller role. The practical split is:

| Role | Typical scope |
|---|---|
| `admin` | Full control, including configuration changes |
| `operator` | Day-to-day runtime operations, agent runs, memory, workflows, scheduler, deliverables |
| `viewer` | Read-only visibility into status, sessions, and operational state |

## Major method families

The RPC layer is broad, so the most useful way to navigate it is by method family.

| Family | Examples |
|---|---|
| Agent execution | `agent.list`, `agent.chat`, `agent.run`, `agent.cancel`, `agent.resume`, `agent.reload`, `agent.status` |
| Sessions | `session.list`, `session.messages`, `session.clear` |
| Configuration | `config.get`, `config.save` |
| MCP runtime | `mcp.status`, `mcp.history`, `mcp.refresh` |
| Scheduler | `scheduler.list`, `scheduler.create`, `scheduler.update`, `scheduler.preview`, `scheduler.runNow`, `scheduler.resume`, `scheduler.cancel`, `scheduler.running`, `scheduler.history` |
| Workflows | `workflow.list`, `workflow.save`, `workflow.delete`, `workflow.run`, `workflow.runStatus`, `workflow.cancel`, `workflow.resume`, `workflow.history` |
| Deliverables | `deliverable.list`, `deliverable.get`, `deliverable.publish`, `deliverable.update`, `deliverable.attachArtifact`, `deliverable.batchPublish`, `deliverable.delete`, `deliverable.merge`, `deliverable.setCategory` |
| Memory | `memory.search`, `memory.delete`, `memory.federated` |
| Stats | `stats.get` |

## Common examples

### List active agents

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "agent.list",
  "params": {}
}
```

### Run an agent turn

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "agent.run",
  "params": {
    "agentId": "main",
    "input": "Review today's inbound requests"
  }
}
```

### Read scheduler state

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "scheduler.list",
  "params": {}
}
```

### Search memory

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "memory.search",
  "params": {
    "agentId": "main",
    "query": "quarterly pricing decisions"
  }
}
```

## How to choose between RPC and streaming surfaces

- Use RPC when the caller needs structured control or structured results.
- Use `POST /chat` when the caller needs SSE streaming and human-facing turn output.
- Use `/ws/chat` when a connected client should stay attached to a live chat stream.

See [Events](./events) for the streaming layer.
