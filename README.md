# AgentFlyer

[![npm version](https://img.shields.io/npm/v/agentflyer?color=0f766e)](https://www.npmjs.com/package/agentflyer)
[![Bun >= 1.2](https://img.shields.io/badge/Bun-%3E%3D%201.2-f59e0b)](https://bun.sh)
[![Node >= 22](https://img.shields.io/badge/Node-%3E%3D%2022-2563eb)](https://nodejs.org)
[![MIT License](https://img.shields.io/badge/License-MIT-111827)](LICENSE)

Distributed AgentOS for multi-agent orchestration, workflows, memory, deliverables, and multi-channel AI runtimes.

[中文说明](README_CN.md)

AgentFlyer is built for people who want to operate agents as a system, not just chat with a model in a box.

It combines agent collaboration, workflow execution, memory retrieval, operator control, sandboxed execution, MCP tools, and multi-channel delivery into one runtime that can grow from a single machine to a federation-ready architecture.

## Launch An AgentOS, Not Just A Bot

AgentFlyer is designed around five product-level ideas:

- Mesh-native collaboration: agents can discover, delegate, and coordinate with other agents inside the same runtime.
- Operator-first control plane: Console UI, approvals, sessions, scheduler, workflow designer, and deliverables are part of the product, not afterthoughts.
- Memory and artifacts as first-class primitives: results are not just tokens on a screen; they become sessions, memories, deliverables, and files.
- Safe execution boundaries: sandbox profiles and tool approval policies give you a safer runtime than handing raw host access to every agent.
- Federation-ready direction: peer identity, transport seams, and decentralized trust are already part of the architecture.

## Why It Has Pull

- More ambitious than a single chatbot runtime.
- More operational than a prompt wrapper.
- More integrated than stitching together workflow, memory, UI, and tool layers by hand.
- More practical than a research demo with no operator surface.

If you want a repo that feels like the early shape of an actual Agent Operating System, this is the bet.

## Core Capabilities

### Runtime

- Unified model registry for Anthropic, OpenAI, Google-compatible, Ollama, and OpenAI-compatible providers.
- Agent execution engine with tool-call loops, queueing, failover, and context compaction.
- JSONL session persistence with resumable runtime state.
- Skill system based on SKILL.md with on-demand prompt injection.
- Hybrid memory with SQLite, BM25 search, and vector embeddings.
- Token usage tracking and runtime stats.

### Control Plane

- Built-in Console UI for overview, agents, chat, inbox, sessions, config, memory, scheduler, workflows, deliverables, federation, and docs-like guidance inside the app.
- Full CLI for gateway lifecycle, messaging, config, skills, memory, stats, and sessions.
- Intent-aware routing and per-agent tool approval policy.
- Deliverable tracking so workflow outputs and chat-turn artifacts become first-class results.

### Orchestration

- Workflow engine with agent steps, conditions, transforms, branching, and execution history.
- Super-node workflows for higher-order coordination patterns such as multi-source collection, debate, decision, risk review, and adjudication.
- Scheduler with cron-based task execution and workflow-triggered runs.

### Tooling And Execution

- MCP registry with server config, prefixed tools, runtime status, refresh path, and approval integration.
- Sandbox runtime with Docker-backed execution profiles, mount policy, diagnostics, and artifact mirroring.

### Channels

- Web channel with WebSocket, SSE chat streaming, and OpenAI-compatible chat endpoint surface.
- Telegram, Discord, Feishu, and QQ adapters.

## Architecture

### Full Runtime View

```text
+-------------------------------------------------------------+
|                    AgentFlyer Instance                      |
|                                                             |
|  +----------+  +----------+  +----------+  +-----------+   |
|  | Telegram |  |  Feishu  |  | Discord  |  |  Console  |   |
|  | Channel  |  | Channel  |  | Channel  |  |    UI     |   |
|  +----+-----+  +----+-----+  +----+-----+  +-----+-----+   |
|       +---------------+---------------+-----------+         |
|                           |                                 |
|  +------------------------v-------------------------------+ |
|  |              Message Router / Session Key              | |
|  +------------------------+-------------------------------+ |
|                           |                                 |
|  +------------------------v-------------------------------+ |
|  |                 Mesh Bus (in-memory)                   | |
|  |                                                        | |
|  |   +----------+  +----------+  +--------------------+   | |
|  |   |  main    |<->| worker  |  |     specialist     |   | |
|  |   | (coord.) |  | (worker) |  |   (domain expert)  |   | |
|  |   +----+-----+  +----------+  +--------------------+   | |
|  +--------+-----------------------------------------------+ |
|           |                                                  |
|  +--------v------------------------------------------------+ |
|  |         Core Services                                   | |
|  |  Memory(SQLite+Vec) | Skills | Scheduler | Config       | |
|  +---------------------+--------+-----------+--------------+ |
|                                                             |
|  +---------------------------------------------------------+ |
|  |   Sandbox + MCP + Deliverables + Workflow Runtime       | |
|  +---------------------------------------------------------+ |
|                                                             |
|  +---------------------------------------------------------+ |
|  |   Federation Layer (expanding)                          | |
|  |  Identity | Peer Registry | Transport | Discovery       | |
|  +----------------------------+----------------------------+ |
+-------------------------------+-----------------------------+
                                | Cross-host collaboration
                +---------------+----------------+
                v                                v
        [Other AgentFlyer Instance]     [Other AgentFlyer Instance]
```

### Layer Map

```text
Channels -> Gateway -> Agent Runtime -> Skills / Memory / Tools / Scheduler
                      |                
                      +-> Mesh collaboration
                      +-> Workflow and deliverables
                      +-> Sandbox and MCP
                      +-> Federation-ready peer layer
```

The project is structured as a layered system, not a monolithic chat app:

- core: config, types, session, logger, crypto, runtime compatibility
- skills and memory: reusable lower-level services
- agent: prompt building, runner, compaction, tools, LLM calls
- mesh: in-process collaboration bus and registry
- gateway: HTTP, RPC, Console UI, workflow backend, deliverables, operator surface
- sandbox and mcp: controlled execution and external tool ecosystem
- federation: peer identity and transport seams for cross-host collaboration

## Quick Start

### Install From npm

```bash
npm install -g agentflyer
agentflyer start
```

Then open:

- Console UI: http://localhost:19789
- CLI chat: `agentflyer chat`

On first run, AgentFlyer creates runtime data under `~/.agentflyer/`.

### Minimal Config Example

```jsonc
{
  "gateway": {
    "port": 19789,
    "auth": { "mode": "token", "token": "change-me" }
  },
  "models": {
    "main": {
      "provider": "openai-compat",
      "apiBaseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "models": {
        "chat": { "id": "gpt-4.1", "maxTokens": 8192 }
      }
    }
  },
  "defaults": {
    "model": "main/chat"
  },
  "agents": [
    {
      "id": "main",
      "name": "Main Agent",
      "skills": ["base"],
      "mesh": {
        "role": "coordinator",
        "capabilities": ["general"],
        "visibility": "public"
      }
    }
  ],
  "channels": {
    "web": { "enabled": true },
    "cli": { "enabled": true }
  }
}
```

### Run From Source

Requirements:

- Bun >= 1.2 recommended
- Node.js >= 22 supported
- pnpm >= 9

```bash
git clone https://github.com/tddt/AgentFlyer.git
cd AgentFlyer
pnpm install
pnpm build
pnpm start
```

Development commands:

```bash
pnpm dev:start
pnpm dev:chat
pnpm typecheck
pnpm check
pnpm test
```

## Use Cases

- Run a personal or team AgentOS with multiple specialist agents.
- Route conversations from Web, Telegram, Discord, Feishu, or QQ into the same runtime.
- Build operator-facing workflows that collect information, debate options, review risk, and publish deliverables.
- Connect external tools through MCP without turning your runtime into a pile of one-off integrations.
- Execute restricted commands through sandbox profiles instead of giving every agent raw host access.
- Prepare for cross-host collaboration where different machines contribute agents, memory, or compute.

## Project Status

AgentFlyer is already useful today as a local or single-host AgentOS.

Current state:

- Core runtime, Console UI, workflow engine, scheduler, memory, channels, CLI, and deliverables are implemented and usable.
- Sandbox and MCP are implemented and under active iteration.
- Federation is already present in the architecture and config surface, while practical multi-host capabilities are still expanding.
- The decentralized economy model is a direction, not a finished production feature.

## Contributing

The codebase uses strict TypeScript, ESM, Bun-first runtime compatibility, and layered module boundaries.

Start here:

- [AGENTS.md](AGENTS.md)
- [package.json](package.json)

Core checks:

```bash
pnpm typecheck
pnpm check
pnpm test
```

## Roadmap Direction

- strengthen federation from architectural foundation to practical multi-host workflows
- deepen MCP transport and server lifecycle management
- improve sandbox policy and safer execution defaults
- keep pushing workflow super nodes and deliverable-based operator flows
- continue reducing token overhead while improving agent coordination quality

## License

MIT
