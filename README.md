# AgentFlyer

> **Decentralized, cross-platform, multi-host federated AI Agent framework**

🇨🇳 [中文版本](README_CN.md)

AgentFlyer is an AI Agent runtime with multi-host federation, inspired by Openclaw. It introduces an in-process Agent Mesh, a token-efficient skill system, deep persistent memory, and decentralized multi-host federation as its core differentiator. The framework also integrates a task system and workflow system, aiming to give users rich and diverse control over AI agents. Let AI take flight!

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Configuration Reference](#configuration-reference)
- [Messaging Channels](#messaging-channels)
- [Agent Mesh](#agent-mesh)
- [Federation](#federation)
- [Memory System](#memory-system)
- [Skills System](#skills-system)
- [Console UI](#console-ui)
- [CLI Commands](#cli-commands)
- [Directory Structure](#directory-structure)
- [Development Guide](#development-guide)

---

## Features

### Core Features (F1–F12)

| # | Feature | Description |
|---|---------|-------------|
| F1 | **Config System** | JSON5 format, multi-profile support, named model group registry (`group/model` reference style) |
| F2 | **Multi-LLM Support** | Anthropic Claude, OpenAI GPT, Gemini, Ollama local models, OpenAI-compatible APIs (DeepSeek, etc.) via unified interface |
| F3 | **Token Metering** | Exact counting + fast estimation, unified measurement across providers |
| F4 | **Messaging Channels** | Telegram, Discord, Feishu (Lark), QQ, Web (with WebSocket real-time streaming) |
| F5 | **Agent Execution Engine** | Tool-call loop, context compaction, subagent scheduling |
| F6 | **Session Persistence** | JSONL format, per channel+key files, incremental append |
| F7 | **Skills System** | SKILL.md-driven, injected on demand, minimal system prompt footprint |
| F8 | **Memory System** | SQLite + BM25 full-text search + vector semantic search, partitioned by agent |
| F9 | **Cron Scheduler** | Scheduled tasks with cron expressions and channel routing |
| F10 | **Workspace** | Per-agent sandboxed file operations with path safety checks |
| F11 | **Console UI** | Built-in web dashboard for realtime monitoring, config management, session viewing, workflow management |
| F12 | **CLI** | `agentflyer gateway/agent/message/sessions/chat/config/skills/memory/federation` command set |

### Enhanced Features (E1–E8)

| # | Feature | Description |
|---|---------|-------------|
| E1 | **Agent Mesh** | Agents within the same instance can discover and delegate tasks to each other, breaking the hierarchy constraint |
| E2 | **Collaborative Skills** | Cross-agent capability labels, on-demand composition |
| E3 | **Federated Memory** | Memory sync across instances, importance decay, vector search |
| E4 | **Decentralized Federation** | Ed25519 identity, AES-GCM encrypted communication, multiple discovery modes |
| E5 | **PoTC Proof of Work** | Token consumption proof + FlyCredit compute exchange |
| E6 | **Remote Task Routing** | Automatically routes to federated nodes when local agent capabilities are insufficient |
| E7 | **Dual Ledger** | Local ledger + peer reconciliation to prevent fraud |
| E8 | **User Authorization Control** | Federation network participation requires explicit user opt-in |

---

## Architecture

```
+-------------------------------------------------------------+
|                    AgentFlyer Instance                       |
|                                                             |
|  +----------+  +----------+  +----------+  +-----------+  |
|  | Telegram |  |  Feishu  |  | Discord  |  |  Console  |  |
|  | Channel  |  | Channel  |  | Channel  |  |    UI     |  |
|  +----+-----+  +----+-----+  +----+-----+  +-----+-----+  |
|       +---------------+---------------+-----------+        |
|                           |                                 |
|  +------------------------v-------------------------------+ |
|  |              Message Router / Session Key              | |
|  +------------------------+-------------------------------+ |
|                           |                                 |
|  +------------------------v-------------------------------+ |
|  |                 Mesh Bus (in-memory)                   | |
|  |                                                        | |
|  |   +----------+  +----------+  +--------------------+  | |
|  |   |  main    |<->| worker  |  |     specialist     |  | |
|  |   | (coord.) |  |(worker) |  |   (domain expert)  |  | |
|  |   +----+-----+  +----------+  +--------------------+  | |
|  +--------+-----------------------------------------------+ |
|           |                                                  |
|  +--------v------------------------------------------------+ |
|  |         Core Services                                   | |
|  |  Memory(SQLite+Vec) | Skills | Scheduler | Config       | |
|  +---------------------------------------------------------+ |
|                                                             |
|  +---------------------------------------------------------+ |
|  |   Federation Layer (optional)                          | |
|  |  Ed25519 Identity | WS Transport | mDNS/Tailscale/Static| |
|  +----------------------------+----------------------------+ |
+----------------------------+--------------------------------+
                             | Cross-host federation
           +-----------------+-----------------+
           v                                   v
   [Other AgentFlyer Instance]       [Other AgentFlyer Instance]
```

### Startup Sequence

```
config.load() -> memory.init() -> channels.start() -> HTTP+WS.listen()
  -> agents.restore() -> scheduler.start() -> federation.connect()
```

---

## Quick Start

### Prerequisites

- **Bun >= 1.2** (recommended) or **Node.js >= 22**
- **pnpm >= 9**

### Install

```bash
git clone https://github.com/your-org/agentflyer.git
cd agentflyer
pnpm install
```

### Build

```bash
# Compile TypeScript + build Console UI
pnpm build
```

### Run

```bash
# Development mode (Bun, no build required)
pnpm dev start

# Production mode (after pnpm build)
agentflyer start

# Interactive CLI chat
agentflyer chat
```

### Initial Configuration

On first run, a minimal config is auto-generated at `~/.agentflyer/agentflyer.json`.
Open `http://localhost:19789` to enter the Console UI for visual configuration.

---

## Configuration Reference

The config file lives at `~/.agentflyer/agentflyer.json` in JSON5 format.

```jsonc
{
  "version": 2,

  // Gateway service config
  "gateway": {
    "bind": "loopback",      // loopback | local | tailscale
    "port": 19789,
    "auth": { "mode": "token", "token": "your-token" }
  },

  // Named model groups (agents reference models as "groupName/modelName", e.g. "deepseek/chat")
  "models": {
    "deepseek": {
      "provider": "openai-compat",
      "apiBaseUrl": "https://api.deepseek.com/v1",
      "apiKey": "sk-...",
      "models": {
        "chat": { "id": "deepseek-chat", "maxTokens": 8192 }
      }
    },
    "claude": {
      "provider": "anthropic",
      "apiKey": "sk-ant-...",
      "models": {
        "haiku": { "id": "claude-haiku-3-5", "maxTokens": 8192 },
        "opus":  { "id": "claude-opus-4-5",  "maxTokens": 8192 }
      }
    },
    "local": {
      "provider": "ollama",
      "apiBaseUrl": "http://localhost:11434",
      "models": {
        "qwen": { "id": "qwen2.5:7b", "maxTokens": 4096 }
      }
    }
  },

  // Global defaults
  "defaults": {
    "model": "deepseek/chat",   // format: groupName/modelName
    "maxTokens": 8192,
    "workspace": "~/.agentflyer/workspace"
  },

  // Agent list
  "agents": [
    {
      "id": "main",
      "name": "Main Assistant",
      "model": "deepseek/chat",   // overrides global default
      "skills": ["base", "file-ops", "web-search"],
      "workspace": "/path/to/workspace",
      "mesh": {
        "role": "coordinator",
        "capabilities": ["orchestration", "user-interface"],
        "accepts": ["task", "query", "notification"],
        "visibility": "public"
      },
      "tools": {
        "deny": [],
        "approval": ["bash", "read_file"]   // tools requiring user approval
      },
      "persona": {
        "language": "en-US",
        "outputDir": "output"
      }
    }
  ],

  // Channel config (see "Messaging Channels" section)
  "channels": {
    "defaults": {
      "output": "logs",           // default output channel
      "schedulerOutput": "logs"   // scheduler task output channel
    },
    "cli":      { "enabled": true },
    "web":      { "enabled": true },
    "telegram": { "enabled": false, "botToken": "" },
    "discord":  { "enabled": false, "botToken": "" },
    "feishu":   { "enabled": false, "appId": "", "appSecret": "" },
    "qq":       { "enabled": false, "appId": "", "clientSecret": "" }
  },

  // Federation config (optional, see "Federation" section)
  "federation": {
    "enabled": false,
    "peers": [],
    "discovery": { "mdns": true, "tailscale": false, "static": true }
  }
}
```

### Supported LLM Providers

| Provider | Example Models | Notes |
|----------|---------------|-------|
| `anthropic` | claude-haiku-3-5, claude-opus-4-5 | Requires `apiKey` |
| `openai` | gpt-4o, gpt-4o-mini | Requires `apiKey` |
| `google` | gemini-1.5-pro | Requires `apiKey` |
| `ollama` | qwen2.5:7b, llama3.2 | Local runtime, set `apiBaseUrl` |
| `openai-compat` | deepseek-chat, other compatible models | Set `apiBaseUrl` + `apiKey` |

---

## Messaging Channels

### Telegram

```jsonc
"telegram": {
  "enabled": true,
  "botToken": "YOUR_BOT_TOKEN",
  "defaultAgentId": "main",
  "allowedChatIds": [],      // empty = no restriction
  "pollIntervalMs": 2000
}
```

### Discord

```jsonc
"discord": {
  "enabled": true,
  "botToken": "YOUR_BOT_TOKEN",
  "defaultAgentId": "main",
  "allowedChannelIds": [],
  "commandPrefix": "!agent"
}
```

### Feishu (Lark)

After creating an app on the Feishu Open Platform, set the event subscription URL to:
`https://your-gateway/channels/feishu/event`

```jsonc
"feishu": {
  "enabled": true,
  "appId": "cli_xxxxxxxx",
  "appSecret": "your-app-secret",
  "verificationToken": "",     // Feishu event verification token (optional)
  "encryptKey": "",            // Feishu message encryption key (optional)
  "defaultAgentId": "main",
  "allowedChatIds": [],        // empty = no restriction
  "agentMappings": {           // Feishu group name/user nickname -> agent ID mapping
    "Main Control": "main",
    "Worker One": "worker-1"
  }
}
```

### QQ

```jsonc
"qq": {
  "enabled": true,
  "appId": "YOUR_APP_ID",
  "clientSecret": "YOUR_CLIENT_SECRET",
  "defaultAgentId": "main",
  "allowedGroupIds": []
}
```

### Web (built-in)

Visit `http://localhost:19789` to open the Console UI and use the built-in **Chat** tab for real-time conversation with WebSocket streaming.

---

## Agent Mesh

AgentFlyer supports multiple agents within the same instance discovering and collaborating with each other, breaking the constraint of tree-structured subagents.

### Roles

| Role | Behavior |
|------|----------|
| `coordinator` | Task assignment and result aggregation; can discover/schedule other agents |
| `worker` | Accepts tasks, executes, and reports results |
| `specialist` | Has domain-specific capabilities; discoverable by capability label |
| `observer` | Read-only; listens to the message stream |

### Available Tools

The following Mesh tools are automatically injected at agent runtime:

```typescript
// Discover agents with a specific capability
mesh_discover({ capability: 'finance-analysis' })

// Delegate a task to a specific agent
mesh_delegate({
  to: 'analyst',
  task: 'Analyze today trend for stock XYZ',
  timeout: 30000,
  expectsStructuredResult: true
})

// Broadcast a message to all agents
mesh_broadcast({ topic: 'market-alert', payload: { ... } })
```

---

## Federation

Multiple AgentFlyer instances across different hosts can form a federated network, delegating tasks to each other and sharing compute.

### Enable Federation

```jsonc
"federation": {
  "enabled": true,
  "peers": [],
  "discovery": {
    "mdns": true,       // LAN auto-discovery
    "tailscale": false, // Tailscale network discovery
    "static": true      // Manual peer config (in peers array)
  },
  "economy": {
    "mode": "invite-only",
    "earn": { "maxDaily": 100, "maxPerTask": 20 },
    "spend": { "maxDaily": 200, "minBalance": 10 }
  }
}
```

### PoTC (Proof of Token Consumption)

When a local node executes a task for a remote node, it generates a WorkReceipt containing:

- The model used and token consumption (inputTokens / outputTokens)
- SHA-256 hash of the task result
- Ed25519 signature of the executing node

After verifying the receipt, the receiver updates the local **FlyCredit (FC)** ledger. FC is used only for internal compute exchange within the network and cannot be transferred externally.

---

## Memory System

AgentFlyer uses SQLite to store memory entries, supporting BM25 full-text search and vector semantic search.

```
~/.agentflyer/
  memory/
    memories.db       # main memory database
    vec_index.bin     # vector index (sqlite-vec)
```

### Partitions

Memory is isolated by partition, defaulting to agent ID:

```typescript
// Memory tools available to agents
memory_store({ content: 'User prefers dark mode', importance: 0.8 })
memory_search({ query: 'user interface preferences', limit: 5 })
memory_recall({ id: 'mem_01J...' })
memory_forget({ id: 'mem_01J...' })
```

### Memory Configuration

```jsonc
"memory": {
  "enabled": true,
  "embed": {
    "provider": "local",
    "model": "Xenova/all-MiniLM-L6-v2"   // local vector embedding, no API needed
  },
  "decay": {
    "enabled": true,
    "halfLifeDays": 30   // memory importance half-life
  },
  "maxEntries": 10000
}
```

---

## Skills System

Skills are capability units for AgentFlyer, described by `SKILL.md` files and injected into the system prompt on demand.

### Skills Directory Configuration

```jsonc
"skills": {
  "dirs": [
    "/path/to/custom-skills",   // user-defined skills directory
    "~/.agentflyer/skills"
  ],
  "compact": true,              // compress skill descriptions to save tokens
  "summaryLength": 60           // max skill summary length
}
```

### SKILL.md Format

```markdown
---
name: web-search
description: Search the web for the latest information
tools: [search_web, fetch_page]
tokens: 120
trigger: auto
keywords: [search, query, latest]
---

## Role
You can use the following tools to perform web searches...
```

---

## Console UI

Built-in web dashboard at `http://localhost:19789` (Bearer Token authentication required).

### Tabs

| Tab | Function |
|-----|----------|
| **Overview** | System status: runtime info, channel status, active session count |
| **Agents** | Agent list and details, realtime message stream |
| **Chat** | Real-time chat with any agent, WebSocket streaming |
| **Logs** | Live log stream with level filtering |
| **Config** | Visual config editor (Gateway, Models, Agents, Channels, Memory, etc.) |
| **Scheduler** | Cron task management: create, edit, view execution history |
| **Sessions** | Session history list and message replay |
| **Workflow** | Workflow definition and execution management |
| **Memory** | Memory entry search, view, and management |
| **Federation** | Federated peer status, peer connection management |
| **Guide** | Project usage guide (this document) |
| **About** | Runtime version and license info |

---

## CLI Commands

```bash
# -- Gateway management -----------------------------------------------
agentflyer start [--port 19789] [--bind loopback]
agentflyer gateway stop
agentflyer gateway status

# -- Agent management -------------------------------------------------
agentflyer agent list
agentflyer agent reload [--id <agentId>]

# -- Send messages ----------------------------------------------------
agentflyer message send --agent <id> --message "Hello"

# -- Session management -----------------------------------------------
agentflyer sessions list [--agent <id>]
agentflyer sessions show <sessionKey>
agentflyer sessions clear <sessionKey>

# -- Interactive chat -------------------------------------------------
agentflyer chat [--agent main]

# -- Config management ------------------------------------------------
agentflyer config show
agentflyer config set <key> <value>
agentflyer config edit         # open system editor

# -- Skills management ------------------------------------------------
agentflyer skills list

# -- Memory management ------------------------------------------------
agentflyer memory search <query>
agentflyer memory list [--agent <id>] [--limit 20]
agentflyer memory delete <id>

# -- Federation management --------------------------------------------
agentflyer federation status
agentflyer federation peers
agentflyer federation trust <nodeId>

# -- Shortcuts --------------------------------------------------------
agentflyer reload     # alias for agent reload
agentflyer web        # open Console UI in browser
```

---

## Directory Structure

```
agentflyer/
+-- src/
|   +-- core/          # base runtime (no framework dependencies)
|   |   +-- config/    # config management (zod schema + JSON5 parsing)
|   |   +-- runtime/   # Bun/Node compatibility layer
|   |   +-- session/   # session persistence (JSONL)
|   |   +-- types/     # core type definitions
|   +-- agent/         # Agent execution engine
|   |   +-- runner/    # LLM call wrappers (unified interface)
|   |   +-- prompt/    # System Prompt assembly
|   |   +-- compactor/ # context compaction (token budget management)
|   |   +-- tools/     # tool registration + call execution
|   +-- skills/        # skills system
|   +-- memory/        # memory storage (SQLite + BM25 + Vec)
|   +-- mesh/          # Agent Mesh (in-process message bus)
|   +-- federation/    # cross-host federation
|   |   +-- transport/ # WebSocket transport layer
|   |   +-- discovery/ # mDNS / Tailscale / Static
|   |   +-- ledger/    # FC ledger + PoTC proof
|   +-- channels/      # messaging channel adapters
|   |   +-- telegram/
|   |   +-- discord/
|   |   +-- feishu/
|   |   +-- web/
|   +-- gateway/       # HTTP + WS entry point
|   |   +-- server.ts  # server startup
|   |   +-- rpc.ts     # RPC interface (used by Console UI)
|   |   +-- console-ui/# React dashboard frontend
|   +-- scheduler/     # Cron scheduler
|   +-- cli/           # CLI entry point
+-- tests/
|   +-- unit/
|   +-- integration/
|   +-- e2e/
+-- docs/              # internal design docs (not user docs)
+-- package.json
+-- pnpm-workspace.yaml
+-- tsconfig.json
```

### Runtime Data Directory

```
~/.agentflyer/
+-- agentflyer.json        # main config file
+-- credentials/           # encrypted API keys (AES-256-GCM)
+-- sessions/              # session logs (JSONL)
+-- memory/                # memory database
+-- workspace/             # agent default workspace
+-- skills/                # user-defined skills
```

---

## Development Guide

### Setup

```bash
pnpm install
```

### Development Commands

```bash
# Type checking
pnpm typecheck

# Code quality check
pnpm check

# Auto-fix formatting
pnpm check:fix

# Run tests
pnpm test

# Coverage report
pnpm test:coverage

# Build output
pnpm build
```

### Module Dependency Direction

```
core/ <- skills/ <- agent/ <- mesh/ <- federation/
core/ <- memory/
core/ <- channels/
(all of the above) <- gateway/ <- cli/
```

Lower-level modules **must not** depend on higher-level modules.

### Technology Stack

| Layer | Choice |
|-------|--------|
| Runtime | Bun >= 1.2 (Node.js >= 22 compatible) |
| Language | TypeScript 5.x (strict ESM) |
| Config validation | zod@3 + json5@2 |
| LLM | @anthropic-ai/sdk + openai@4 |
| Memory storage | SQLite (better-sqlite3) + sqlite-vec + BM25 |
| CLI | citty + @clack/prompts |
| Federation crypto | @noble/ed25519 + @noble/ciphers |
| Testing | Vitest + msw@2 (Mock LLM) |

### Commit Convention

```
feat(core): add new feature
fix(agent): fix issue
refactor(memory): refactor module
test(channels): add tests
docs(readme): update documentation
chore(deps): dependency updates
```

Before committing, all of the following must pass:

```bash
pnpm typecheck && pnpm check && pnpm test
```

---

## License

MIT License — see [LICENSE](LICENSE)
