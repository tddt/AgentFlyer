# 快速开始

理解 AgentFlyer 最快的方式，是先启动一个模型、一个 agent 和一个 runtime surface，然后再逐步扩展。

## 需要准备什么

- 推荐 Bun 1.2+
- 支持 Node.js 22+
- 推荐 pnpm 9+
- 至少一组模型提供商凭证

## 安装

### 全局安装

```bash
npm install -g agentflyer
```

### 从源码运行

```bash
git clone https://github.com/tddt/AgentFlyer.git
cd AgentFlyer
pnpm install
pnpm build
```

## 找到配置文件

```bash
agentflyer config path
```

然后写入一个最小配置：

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
      "apiKey": "sk-...",
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

## 启动运行时

```bash
agentflyer config validate
agentflyer config doctor
agentflyer start
```

然后通过这些表面开始操作：

- Console UI：`http://localhost:19789`
- 浏览器打开：`agentflyer web`
- 本地对话：`agentflyer chat`
- 定向发消息：`agentflyer message send`

## 常用第一批命令

```bash
agentflyer status
agentflyer agent list
agentflyer sessions list
agentflyer skills list
agentflyer stats
```