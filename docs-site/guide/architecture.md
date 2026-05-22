# Architecture

AgentFlyer is structured as a layered runtime, not a monolithic chat shell.

## Layer map

```text
Channels -> Gateway -> Agent Runtime -> Skills / Memory / Tools / Scheduler
                      |
                      +-> Mesh collaboration
                      +-> Workflow and deliverables
                      +-> Sandbox and MCP
                      +-> Federation-ready peer layer
```

## What each layer owns

| Layer | Owns |
|---|---|
| Channels | Web, CLI, Telegram, Discord, Feishu, QQ delivery surfaces |
| Gateway | HTTP, RPC, Console UI, workflow backend, deliverables, operator-facing control plane |
| Agent runtime | Model calls, tool loops, queueing, resumable turns, compaction, execution lifecycle |
| Skills and memory | Reusable instructions, search, storage, retrieval, hybrid memory semantics |
| MCP and sandbox | External tool connection and bounded execution environments |
| Federation | Peer identity, discovery, transport, and cross-host seams |

## Request flow

1. A message enters through Web, CLI, or a channel adapter.
2. The gateway authenticates, routes, and establishes a session or thread key.
3. The agent runtime resolves the target agent and starts or resumes execution.
4. Skills, memory, MCP tools, and sandboxed execution are pulled in as needed.
5. Output becomes both a reply and a durable runtime artifact such as session state or deliverables.

## Why the architecture matters

This split is what lets AgentFlyer behave like a system instead of a prompt demo:

- agents can collaborate without collapsing into one massive prompt
- workflows can outlive one chat turn
- operator controls can exist independently from any one channel surface
- tool execution can be bounded and observable
- federation can grow from real seams instead of being bolted on later

## Current maturity

| Surface | Status |
|---|---|
| Core runtime | Implemented and usable |
| Console UI and CLI | Implemented and actively central to operations |
| Workflows, scheduler, deliverables | Implemented and part of the operator path |
| MCP and sandbox | Implemented and still being refined |
| Federation | Architectural and early module presence, practical multi-host expansion continues |

## Recommended mental model

Treat AgentFlyer as an AgentOS runtime with three simultaneous concerns:

- execution: agents, models, tools, workflows
- state: sessions, memory, deliverables, artifacts
- operations: UI, CLI, approvals, status, routing, scheduler

If a design change does not fit one of those concerns cleanly, it usually belongs at a different layer.