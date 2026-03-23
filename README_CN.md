# AgentFlyer

> **去中心化、跨平台、多主机联邦的 AI Agent 框架**

🇺🇸 [English version](README.md)

AgentFlyer 是一个类Openclaw的支持多主机联邦协作的 AI Agent 运行时。它引入了实例内 Agent 网格（Mesh）、Token 高效技能系统、深度记忆，以及核心差异化的去中心化多主机联邦。
站在各种claw的肩膀上，本框架还集成了任务系统、工作流系统。
目标是让用户拥有更加多样化的AI智能体操控体验。
让AI起飞吧！

---

## 目录

- [特性概览](#特性概览)
- [系统架构](#系统架构)
- [快速开始](#快速开始)
- [配置参考](#配置参考)
- [消息渠道](#消息渠道)
- [Agent 网格（Mesh）](#agent-网格mesh)
- [联邦协作（Federation）](#联邦协作federation)
- [记忆系统](#记忆系统)
- [技能系统（Skills）](#技能系统skills)
- [Console UI](#console-ui)
- [CLI 命令](#cli-命令)
- [目录结构](#目录结构)
- [开发指南](#开发指南)

---

## 特性概览

### 核心特性（F1–F12）

| # | 特性 | 说明 |
|---|------|------|
| F1 | **配置系统** | JSON5 格式，支持多 profile，命名模型分组注册表（`分组/模型` 引用方式）|
| F2 | **多 LLM 支持** | Anthropic Claude、OpenAI GPT、Gemini、Ollama 本地模型、OpenAI 兼容接口（DeepSeek 等），统一接口 |
| F3 | **Token 计量** | 精确计数 + 快速估算，跨 provider 统一度量 |
| F4 | **消息渠道** | Telegram、Discord、飞书（Feishu）、QQ、Web（含 WebSocket 实时流式回复）|
| F5 | **Agent 执行引擎** | 工具调用循环、上下文压缩、Subagent 调度 |
| F6 | **会话持久化** | JSONL 格式，按 channel+key 分文件，增量写入 |
| F7 | **技能系统** | SKILL.md 驱动，按需注入，最小 System Prompt |
| F8 | **记忆系统** | SQLite + BM25 全文检索 + 向量语义检索，支持分区 |
| F9 | **Cron 调度** | 定时任务，支持 cron 表达式和频道路由 |
| F10 | **工作区** | Agent 独立文件操作沙箱，路径安全校验 |
| F11 | **Console UI** | 内置 Web 控制台，实时监控、配置管理、会话查看、工作流管理 |
| F12 | **CLI** | `agentflyer gateway/agent/message/sessions/chat/config/skills/memory/federation` 命令集 |

### 增强特性（E1–E8）

| # | 特性 | 说明 |
|---|------|------|
| E1 | **Agent 网格（Mesh）** | 实例内 Agent 可相互发现、委托任务，突破树形限制 |
| E2 | **协作技能** | 跨 Agent 能力标签，按需组合 |
| E3 | **联邦记忆** | 记忆跨实例同步，重要度衰减，向量检索 |
| E4 | **去中心化联邦** | Ed25519 身份、AES-GCM 加密通信、多种发现模式 |
| E5 | **PoTC 工作证明** | Token 消耗证明 + FlyCredit 算力互换 |
| E6 | **远程任务路由** | 本地 Agent 能力不足时自动路由到联邦节点 |
| E7 | **双边账本** | 本地账本 + 对端对账，防止作弊 |
| E8 | **用户授权控制** | 联邦网络参与必须用户明确 opt-in |

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                    AgentFlyer Instance                       │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │ Telegram │  │  Feishu  │  │ Discord  │  │  Console  │  │
│  │ Channel  │  │ Channel  │  │ Channel  │  │    UI     │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬─────┘  │
│       └──────────────┴──────────────┴──────────────┘        │
│                           │                                  │
│  ┌────────────────────────▼───────────────────────────────┐ │
│  │              Message Router / Session Key              │ │
│  └────────────────────────┬───────────────────────────────┘ │
│                           │                                  │
│  ┌────────────────────────▼───────────────────────────────┐ │
│  │                  Mesh Bus（内存消息总线）                │ │
│  │                                                         │ │
│  │   ┌──────────┐  ┌──────────┐  ┌──────────────────────┐ │ │
│  │   │  main    │◄─►│ worker  │  │     specialist       │ │ │
│  │   │ (coord.) │  │(worker) │  │   (domain expert)    │ │ │
│  │   └────┬─────┘  └──────────┘  └──────────────────────┘ │ │
│  └────────┼────────────────────────────────────────────────┘ │
│           │                                                   │
│  ┌────────▼────────────────────────────────────────────────┐ │
│  │         Core Services                                   │ │
│  │  Memory(SQLite+Vec) │ Skills │ Scheduler │ Config       │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │   Federation Layer (可选)                               │ │
│  │   Ed25519 身份 │ WS 传输 │ mDNS/Tailscale/Static 发现  │ │
│  └──────────────────────────┬──────────────────────────────┘ │
└─────────────────────────────┼───────────────────────────────┘
                              │ 跨主机联邦
            ┌─────────────────┼─────────────────┐
            ▼                                    ▼
    [其他 AgentFlyer 实例]             [其他 AgentFlyer 实例]
```

### 启动序列

```
config.load() → memory.init() → channels.start() → HTTP+WS.listen()
  → agents.restore() → scheduler.start() → federation.connect()
```

---

## 快速开始

### 通过 npm 安装（推荐）

```bash
# 全局安装
npm install -g agentflyer

# 或直接使用，无需安装
npx agentflyer --help
```

### 运行

```bash
# 启动网关
agentflyer start

# 交互式对话
agentflyer chat
```

首次运行会在 `~/.agentflyer/agentflyer.json` 生成默认配置。
打开 `http://localhost:19789` 进入 Console UI 进行可视化配置。

---

### 从源码构建

**源码构建前置要求：**

- **Bun ≥ 1.2**（推荐）或 **Node.js ≥ 22**
- **pnpm ≥ 9**

```bash
git clone https://github.com/tddt/AgentFlyer.git
cd AgentFlyer
pnpm install
pnpm build
```

```bash
# 开发模式（Bun，无需构建）
pnpm dev start

# 交互式对话
agentflyer chat
```

---

## 配置参考

配置文件位于 `~/.agentflyer/agentflyer.json`，使用 JSON5 格式。

```jsonc
{
  "version": 2,

  // Gateway 服务配置
  "gateway": {
    "bind": "loopback",      // loopback | local | tailscale
    "port": 19789,
    "auth": { "mode": "token", "token": "your-token" }
  },

  // 命名模型分组（agents 通过 "分组名/模型名" 引用，如 "deepseek/chat"）
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

  // 全局默认值
  "defaults": {
    "model": "deepseek/chat",   // 格式：分组名/模型名
    "maxTokens": 8192,
    "workspace": "~/.agentflyer/workspace"
  },

  // Agent 配置列表
  "agents": [
    {
      "id": "main",
      "name": "主助手",
      "model": "deepseek/chat",   // 覆盖全局默认
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
        "approval": ["bash", "read_file"]   // 需要用户审批的工具
      },
      "persona": {
        "language": "zh-CN",
        "outputDir": "output"
      }
    }
  ],

  // 渠道配置（详见「消息渠道」章节）
  "channels": {
    "defaults": {
      "output": "logs",           // 默认输出渠道
      "schedulerOutput": "logs"   // 调度任务输出渠道
    },
    "cli":      { "enabled": true },
    "web":      { "enabled": true },
    "telegram": { "enabled": false, "botToken": "" },
    "discord":  { "enabled": false, "botToken": "" },
    "feishu":   { "enabled": false, "appId": "", "appSecret": "" },
    "qq":       { "enabled": false, "appId": "", "clientSecret": "" }
  },

  // 联邦配置（可选，详见「联邦协作」章节）
  "federation": {
    "enabled": false,
    "peers": [],
    "discovery": { "mdns": true, "tailscale": false, "static": true }
  }
}
```

### 支持的 LLM Provider

| Provider | 典型模型 | 说明 |
|----------|---------|------|
| `anthropic` | claude-haiku-3-5, claude-opus-4-5 | 需设置 `apiKey` |
| `openai` | gpt-4o, gpt-4o-mini | 需设置 `apiKey` |
| `google` | gemini-1.5-pro | 需设置 `apiKey` |
| `ollama` | qwen2.5:7b, llama3.2 | 本地运行，设置 `apiBaseUrl` |
| `openai-compat` | deepseek-chat, 其他兼容模型 | 设置 `apiBaseUrl` + `apiKey` |

---

## 消息渠道

### Telegram

```jsonc
"telegram": {
  "enabled": true,
  "botToken": "YOUR_BOT_TOKEN",
  "defaultAgentId": "main",
  "allowedChatIds": [],      // 空数组 = 不限制
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

### 飞书（Feishu / Lark）

在飞书开放平台创建应用后，将事件订阅地址配置为：
`https://your-gateway/channels/feishu/event`

```jsonc
"feishu": {
  "enabled": true,
  "appId": "cli_xxxxxxxx",
  "appSecret": "your-app-secret",
  "verificationToken": "",     // 飞书事件验证 Token（可选）
  "encryptKey": "",            // 飞书消息加密 Key（可选）
  "defaultAgentId": "main",
  "allowedChatIds": [],        // 空数组 = 不限制
  "agentMappings": {           // 飞书群名/用户昵称 → agent ID 映射
    "主控": "main",
    "一号工人": "worker-1"
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

### Web（内置）

访问 `http://localhost:19789` 进入 Console UI，使用内置 **Chat** 标签页进行实时对话，支持 WebSocket 流式回复。

---

## Agent 网格（Mesh）

AgentFlyer 支持同一实例内多个 Agent 相互发现和协作，突破树形 Subagent 的限制。

### 角色

| 角色 | 行为 |
|------|------|
| `coordinator` | 任务分配和结果聚合，可发现/调度其他 agent |
| `worker` | 接受任务，执行并报告结果 |
| `specialist` | 有特定领域能力，可按能力标签发现 |
| `observer` | 只读，监听消息流 |

### 可用工具

Agent 运行时自动注入以下 Mesh 工具：

```typescript
// 发现具有某能力的 agent
mesh_discover({ capability: 'finance-analysis' })

// 委托任务给特定 agent
mesh_delegate({
  to: 'analyst',
  task: '分析贵州茅台今日走势',
  timeout: 30000,
  expectsStructuredResult: true
})

// 广播消息给所有 agent
mesh_broadcast({ topic: 'market-alert', payload: { ... } })
```

---

## 联邦协作（Federation）

多台主机上的 AgentFlyer 实例可以组成联邦网络，互相委托任务并共享算力。

### 启用联邦

```jsonc
"federation": {
  "enabled": true,
  "peers": [],
  "discovery": {
    "mdns": true,       // 局域网自动发现
    "tailscale": false, // Tailscale 网络发现
    "static": true      // 手动指定对端（在 peers 数组中配置）
  },
  "economy": {
    "mode": "invite-only",
    "earn": { "maxDaily": 100, "maxPerTask": 20 },
    "spend": { "maxDaily": 200, "minBalance": 10 }
  }
}
```

### PoTC（Token 消耗证明）

当本地节点为远程节点执行任务时，会生成一份工作收据（WorkReceipt），包含：

- 使用的模型和 Token 消耗量（inputTokens / outputTokens）
- 任务结果的 SHA-256 哈希
- 执行节点的 Ed25519 签名

接收方验证收据后，更新本地的 **FlyCredit（FC）** 账本。FC 只用于网络内算力互换，不可外部转让。

---

## 记忆系统

AgentFlyer 使用 SQLite 存储记忆条目，支持 BM25 全文检索和向量语义检索。

```
~/.agentflyer/
  memory/
    memories.db       # 主记忆数据库
    vec_index.bin     # 向量索引（sqlite-vec）
```

### 分区

记忆按分区（partition）隔离，默认按 agent ID 分区：

```typescript
// Agent 可调用的记忆工具
memory_store({ content: '用户偏好黑暗模式', importance: 0.8 })
memory_search({ query: '用户界面偏好', limit: 5 })
memory_recall({ id: 'mem_01J...' })
memory_forget({ id: 'mem_01J...' })
```

### 记忆配置

```jsonc
"memory": {
  "enabled": true,
  "embed": {
    "provider": "local",
    "model": "Xenova/all-MiniLM-L6-v2"   // 本地向量嵌入，无需 API
  },
  "decay": {
    "enabled": true,
    "halfLifeDays": 30   // 记忆重要度半衰期
  },
  "maxEntries": 10000
}
```

---

## 技能系统（Skills）

技能是 AgentFlyer 的能力单元，以 `SKILL.md` 文件描述，按需注入 System Prompt。

### 技能目录配置

```jsonc
"skills": {
  "dirs": [
    "/path/to/custom-skills",   // 用户自定义技能目录
    "~/.agentflyer/skills"
  ],
  "compact": true,              // 压缩技能描述以节省 Token
  "summaryLength": 60           // 技能摘要最大长度
}
```

### SKILL.md 格式

```markdown
---
name: web-search
description: 使用搜索引擎检索最新信息
tools: [search_web, fetch_page]
tokens: 120
trigger: auto
keywords: [搜索, 查询, 最新]
---

## 角色
你可以使用以下工具进行网络搜索...
```

---

## Console UI

内置 Web 控制台，访问 `http://localhost:19789`（需要 Bearer Token 认证）。

### 功能标签

| 标签 | 功能 |
|------|------|
| **Overview** | 系统状态概览：运行时信息、渠道状态、活跃会话数 |
| **Agents** | Agent 列表与详情、实时消息流 |
| **Chat** | 与任意 Agent 进行实时对话，支持 WebSocket 流式回复 |
| **Logs** | 实时日志流，支持按级别过滤 |
| **Config** | 可视化配置编辑器（Gateway、Models、Agents、Channels、Memory 等）|
| **Scheduler** | Cron 定时任务管理：创建、编辑、查看执行历史 |
| **Sessions** | 会话历史列表与消息回放 |
| **Workflow** | 工作流定义与执行管理 |
| **Memory** | 记忆条目搜索、查看与管理 |
| **Federation** | 联邦对端状态、peer 连接管理 |
| **Guide** | 项目使用指南（即本文档）|
| **About** | 运行时版本与许可证信息 |

---

## CLI 命令

```bash
# ── Gateway 管理 ───────────────────────────────────────────
agentflyer start [--port 19789] [--bind loopback]
agentflyer gateway stop
agentflyer gateway status

# ── Agent 管理 ─────────────────────────────────────────────
agentflyer agent list
agentflyer agent reload [--id <agentId>]

# ── 消息发送 ───────────────────────────────────────────────
agentflyer message send --agent <id> --message "你好"

# ── 会话管理 ───────────────────────────────────────────────
agentflyer sessions list [--agent <id>]
agentflyer sessions show <sessionKey>
agentflyer sessions clear <sessionKey>

# ── 交互式对话 ─────────────────────────────────────────────
agentflyer chat [--agent main]

# ── 配置管理 ───────────────────────────────────────────────
agentflyer config show
agentflyer config set <key> <value>
agentflyer config edit         # 打开系统编辑器

# ── 技能管理 ───────────────────────────────────────────────
agentflyer skills list

# ── 记忆管理 ───────────────────────────────────────────────
agentflyer memory search <query>
agentflyer memory list [--agent <id>] [--limit 20]
agentflyer memory delete <id>

# ── 联邦管理 ───────────────────────────────────────────────
agentflyer federation status
agentflyer federation peers
agentflyer federation trust <nodeId>

# ── 快捷命令 ───────────────────────────────────────────────
agentflyer reload     # 等同于 agent reload
agentflyer web        # 打开 Console UI 网页
```

---

## 目录结构

```
agentflyer/
├── src/
│   ├── core/          # 基础运行时（无框架依赖）
│   │   ├── config/    # 配置管理（zod schema + JSON5 解析）
│   │   ├── runtime/   # Bun/Node 兼容层
│   │   ├── session/   # 会话持久化（JSONL）
│   │   └── types/     # 核心类型定义
│   ├── agent/         # Agent 执行引擎
│   │   ├── runner/    # LLM 调用封装（统一接口）
│   │   ├── prompt/    # System Prompt 组装
│   │   ├── compactor/ # 上下文压缩（token budget 管理）
│   │   └── tools/     # 工具注册 + 调用执行
│   ├── skills/        # 技能系统
│   ├── memory/        # 记忆存储（SQLite + BM25 + Vec）
│   ├── mesh/          # Agent 网格（实例内消息总线）
│   ├── federation/    # 跨主机联邦
│   │   ├── transport/ # WebSocket 传输层
│   │   ├── discovery/ # mDNS / Tailscale / Static
│   │   └── ledger/    # FC 账本 + PoTC 证明
│   ├── channels/      # 消息渠道适配器
│   │   ├── telegram/
│   │   ├── discord/
│   │   ├── feishu/
│   │   └── web/
│   ├── gateway/       # HTTP + WS 入口
│   │   ├── server.ts  # 服务器启动
│   │   ├── rpc.ts     # RPC 接口（Console UI 使用）
│   │   └── console-ui/# React 控制台前端
│   ├── scheduler/     # Cron 调度器
│   └── cli/           # 命令行入口
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── docs/              # 内部设计文档（非用户文档）
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.json
```

### 运行时数据目录

```
~/.agentflyer/
├── agentflyer.json        # 主配置文件
├── credentials/           # 加密存储的 API Key（AES-256-GCM）
├── sessions/              # 会话日志（JSONL）
├── memory/                # 记忆数据库
├── workspace/             # Agent 默认工作区
└── skills/                # 用户自定义技能
```

---

## 开发指南

### 环境准备

```bash
pnpm install
```

### 开发命令

```bash
# 类型检查
pnpm typecheck

# 代码质量检查
pnpm check

# 自动修复格式
pnpm check:fix

# 运行测试
pnpm test

# 覆盖率报告
pnpm test:coverage

# 构建产物
pnpm build
```

### 模块依赖方向

```
core/ ← skills/ ← agent/ ← mesh/ ← federation/
core/ ← memory/
core/ ← channels/
(以上所有) ← gateway/ ← cli/
```

下层模块**不得**依赖上层。

### 技术选型

| 层次 | 选择 |
|------|------|
| 主运行时 | Bun ≥ 1.2（Node.js ≥ 22 兼容）|
| 语言 | TypeScript 5.x（strict ESM）|
| 配置验证 | zod@3 + json5@2 |
| LLM | @anthropic-ai/sdk + openai@4 |
| 记忆存储 | SQLite（better-sqlite3）+ sqlite-vec + BM25 |
| CLI | citty + @clack/prompts |
| 联邦加密 | @noble/ed25519 + @noble/ciphers |
| 测试 | Vitest + msw@2（Mock LLM）|

### 提交规范

```
feat(core): 新增功能
fix(agent): 修复问题
refactor(memory): 重构模块
test(channels): 添加测试
docs(readme): 更新文档
chore(deps): 依赖更新
```

提交前必须通过：

```bash
pnpm typecheck && pnpm check && pnpm test
```

---

## 许可证

MIT License — 详见 [LICENSE](LICENSE)
