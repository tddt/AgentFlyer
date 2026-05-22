# Memory

Memory in AgentFlyer is there to make the runtime cumulative instead of stateless.

## Three kinds of durable context

| Kind | What it is for |
|---|---|
| Sessions | Turn-by-turn conversational continuity |
| Memory | Searchable facts, context, and retrieved knowledge |
| Deliverables | Operator-facing outputs and publishable artifacts |

## Why this matters

Without explicit state, an agent system collapses back into disposable chat. AgentFlyer treats memory and outputs as runtime primitives so useful work can survive beyond the current turn.

## What the runtime supports

- hybrid memory based on SQLite, BM25 search, and vector embeddings
- session persistence and recovery
- memory search through operator surfaces
- deliverable attachment to workflow and chat outputs
- early federation-oriented memory synchronization seams

## How operators use it

- search for prior context before running a new task
- recover or inspect a session instead of restarting blindly
- promote a result into a deliverable when it should be tracked and published

## CLI and RPC paths

Useful commands and method families include:

- `agentflyer memory list`
- `agentflyer memory search`
- `memory.search`
- `memory.delete`
- `memory.federated`

## Related pages

- [Agents](./agents)
- [Workflows](./workflows)
- [Federation](./federation)