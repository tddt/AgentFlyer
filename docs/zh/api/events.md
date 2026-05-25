# 事件与流式接口

AgentFlyer 为 chat 和集成场景提供了多种流式表面。

## 主要端点

| 端点 | 用途 |
|---|---|
| `POST /chat` | SSE 流式返回 agent 回复 |
| `GET /ws/chat` | WebSocket chat 升级路径 |
| `GET /v1/models` | OpenAI-compatible model list |
| `POST /v1/chat/completions` | OpenAI-compatible chat completions |

## `/chat` 中会看到的事件类型

- `queued`
- `started`
- `text_delta`
- `thinking_delta`
- `tool_use_start`
- `tool_use_delta`
- `tool_result`
- `progress`
- `error`
- `done`

## 什么时候用这些接口

- 用 RPC 做结构化自动化
- 用 SSE 让浏览器或操作者看到完整的执行过程
- 用 WebSocket 维持持续连接的 chat 客户端