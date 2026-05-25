# Skills 与 Tools

AgentFlyer 把轻量级行为知识和可执行工具访问明确拆开。

## Skills

Skills 是 prompt 侧的运行时资产，适合：

- 可复用指令
- 领域操作规范
- 稳定任务 framing
- 小而明确的行为组合

AgentFlyer 的 skill system 建立在 `SKILL.md` 内容和按需 prompt 注入之上。

## Tools

工具访问应该是显式的。在 AgentFlyer 中，主要工具路径包括：

- 内置运行时能力
- MCP servers
- plugin 提供的 runtime extensions
- 必要时的 sandboxed execution

## 为什么要拆开

这个拆分能让运行时更容易推理：

- skills 负责塑造行为
- tools 负责执行动作

当这两个关注点被分清时，approval、audit 和 operator control 都会清晰很多。

## 怎么选扩展路径

| 需求 | 用什么 |
|---|---|
| 可复用 prompt 上下文 | Skills |
| 外部 API 或 tool server | MCP |
| 可安装的运行时扩展包 | Marketplace plugin |

## 运营建议

- 让 skills 保持可读且边界明确。
- 给 tools 清晰稳定的命名和窄职责。
- 对有现实副作用的工具访问使用 approval policy。
- 优先用 MCP 或 sandbox execution，而不是不可见的 shell 访问。

## 相关页面

- [Memory](./memory)
- [扩展入口](../api/plugin-sdk)
- [插件概览](../plugins/overview)