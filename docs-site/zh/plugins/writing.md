# 发布插件包

如果你要把 AgentFlyer 扩展发布成 npm 包，最小元数据通常至少包括：

```json
{
  "name": "agentflyer-plugin-example",
  "version": "1.0.0",
  "main": "dist/index.js",
  "keywords": ["agentflyer-plugin"],
  "agentflyer": {
    "plugin": "dist/index.js"
  }
}
```

发布后就能通过 `agentflyer plugin install` 被操作者安装，再加入运行时配置启用。