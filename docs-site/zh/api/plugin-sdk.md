# 扩展入口

AgentFlyer 的扩展方式不止一种。应该根据问题类型选择最小的 seam。

## 选择哪种扩展方式

| 目标 | 适合的方式 |
|---|---|
| 注入领域知识和行为 | Skills |
| 接入外部工具或服务 | MCP servers |
| 发布可安装的 npm 扩展 | Marketplace plugins |

## Skills

适合 prompt 侧的复用：领域知识、操作规程、行为约束。

## MCP

适合工具调用边界清晰、需要审批或需要外部服务桥接的场景。

## Plugins

适合要作为 npm 包安装、分发和运维的扩展。

```bash
agentflyer plugin search <keyword>
agentflyer plugin install <name>
agentflyer plugin list
agentflyer plugin remove <name>
```