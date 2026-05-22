# 架构

AgentFlyer 是分层 runtime，不是单体聊天壳子。

## 分层图

```text
Channels -> Gateway -> Agent Runtime -> Skills / Memory / Tools / Scheduler
                      |
                      +-> Mesh collaboration
                      +-> Workflow and deliverables
                      +-> Sandbox and MCP
                      +-> Federation-ready peer layer
```

## 每层负责什么

| 层 | 负责的内容 |
|---|---|
| Channels | Web、CLI、Telegram、Discord、飞书、QQ |
| Gateway | HTTP、RPC、Console UI、workflow backend、deliverables、控制平面 |
| Agent runtime | 模型调用、tool loop、queue、resumable turn、上下文压缩 |
| Skills 和 memory | 指令复用、检索、存储、混合记忆 |
| MCP 和 sandbox | 外部工具连接与受控执行环境 |
| Federation | peer identity、discovery、transport 和跨主机 seam |

## 为什么这很重要

正是因为它被拆成这些层，AgentFlyer 才不会退化成“一个更大的 prompt”：

- agents 可以协作而不是挤进一个超长上下文
- workflows 可以脱离单轮对话存在
- operator controls 可以独立于 channel surface
- tool execution 可以有边界和可见性
- federation 可以从真实 seam 演进，而不是后补