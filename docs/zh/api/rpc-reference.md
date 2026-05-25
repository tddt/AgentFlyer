# RPC 参考

AgentFlyer 在 `POST /rpc` 暴露 JSON-RPC 接口，用于 Console UI、operator tooling 和自动化脚本。

## 请求格式

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "agent.run",
  "params": {
    "agentId": "main",
    "input": "Review today's inbound requests"
  }
}
```

请求头需要 Bearer token：

```text
Authorization: Bearer <token>
```

## 方法族

| 类别 | 示例 |
|---|---|
| Agent 执行 | `agent.list`、`agent.chat`、`agent.run`、`agent.cancel`、`agent.resume`、`agent.reload` |
| Sessions | `session.list`、`session.messages`、`session.clear` |
| Configuration | `config.get`、`config.save` |
| MCP 运行态 | `mcp.status`、`mcp.history`、`mcp.refresh` |
| Scheduler | `scheduler.list`、`scheduler.create`、`scheduler.update`、`scheduler.runNow`、`scheduler.resume`、`scheduler.history` |
| Workflow | `workflow.list`、`workflow.save`、`workflow.run`、`workflow.runStatus`、`workflow.history` |
| Deliverable | `deliverable.list`、`deliverable.get`、`deliverable.publish`、`deliverable.update` |
| Memory | `memory.search`、`memory.delete`、`memory.federated` |
| Stats | `stats.get` |

## 什么时候用 RPC

- 需要结构化请求和结构化响应时
- 需要操作 workflow、scheduler、deliverables 等系统能力时
- 不需要逐字流式聊天输出时

如果需要流式对话，请看 [事件与流式接口](./events)。