# Channels

Channels 是 AgentFlyer 的入口和出口层，承接用户、bot 或外部系统与 runtime 的交互。

## 当前主要 channel surfaces

AgentFlyer 当前已经有这些主要接入面：

- Web
- CLI
- Telegram
- Discord
- Feishu
- QQ

## 为什么 channel 支持重要

意义不只是“多几个聊天 UI”。真正重要的是：同一套 runtime 能服务不同的 operator 和终端用户场景，而不用为每个入口复制一遍 agent 逻辑。

## Web surface

Web 是目前最完整的 operator-facing 路径，包含：

- Console UI
- RPC endpoint
- SSE streaming chat
- WebSocket chat support
- OpenAI-compatible integration surface

流式接口细节见 [事件与流式接口](../api/events)。

## Channel 设计原则

Channel 应该尽量保持轻薄。Routing、memory、workflow state、tool access 和 deliverables 属于 runtime，不应散落在某一个 channel implementation 里。

正因为如此，AgentFlyer 才能在多个入口同时存在时仍保持系统一致性。

## 运营建议

- 先从 Web 和 CLI 开始。
- 只有在确实存在 operator 或 delivery 需求时，再增加消息渠道。
- 让 channel-specific formatting 尽量小，把真正的流程逻辑留在 runtime 中。

## 相关页面

- [架构](./architecture)
- [Workflows](./workflows)
- [Federation](./federation)