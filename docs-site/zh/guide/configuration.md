# 配置

AgentFlyer 的配置文件定义了运行时边界：gateway、models、agents、channels、MCP servers、plugins 和访问控制。

## 核心结构

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
      "apiKey": "${OPENAI_API_KEY}",
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

## 最常见的部分

- `gateway`：端口和认证
- `models`：模型提供商和命名模型组
- `defaults`：默认模型引用
- `agents`：agent 身份、skills、mesh role
- `channels`：启用哪些接入面
- `mcp`：外部 MCP server
- `users`：viewer / operator / admin 角色
- `plugins`：已安装的扩展入口

## 推荐配置流程

```bash
agentflyer config path
agentflyer config show
agentflyer config validate
agentflyer config doctor
agentflyer reload
```

先从一个 model group、一个默认 agent、一个或两个 channels 开始，再逐步扩展。