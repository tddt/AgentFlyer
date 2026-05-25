# Memory

AgentFlyer 中的 memory 是为了让 runtime 具备累积性，而不是每次都从零开始。

## 三类持久上下文

| 类型 | 用途 |
|---|---|
| Sessions | 对话级连续性 |
| Memory | 可检索的事实、上下文和知识 |
| Deliverables | 面向 operator 的输出和可发布产物 |

## 为什么这件事重要

没有显式状态时，agent system 最终会退化成一次性聊天。AgentFlyer 把 memory 和 outputs 视作 runtime primitive，让有价值的工作不会在当前回合结束后就消失。

## 运行时已经支持什么

- 基于 SQLite、BM25 search 和 vector embeddings 的 hybrid memory
- session persistence 与恢复
- 从 operator surfaces 发起 memory search
- 把 workflow 或 chat 输出附着到 deliverables 上
- 面向 federation 的早期 memory synchronization seam

## 操作者怎么用它

- 在启动新任务前先检索已有上下文
- 恢复或检查已有 session，而不是每次重来
- 当结果需要被追踪和发布时，把它提升为 deliverable

## 常用 CLI / RPC 路径

- `agentflyer memory list`
- `agentflyer memory search`
- `memory.search`
- `memory.delete`
- `memory.federated`

## 相关页面

- [Agents](./agents)
- [Workflows](./workflows)
- [Federation](./federation)