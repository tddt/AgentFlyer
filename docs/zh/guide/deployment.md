# 部署

AgentFlyer 最合适的采用方式是递进式部署，而不是一开始就把它当成重型分布式平台。

## 本地或单主机部署

这是最快也最合理的起点：

```bash
agentflyer start
agentflyer status
```

推荐做法：

- 默认只暴露 loopback
- 凭证放环境变量或外部 secret store
- 配置结构可进版本库，敏感信息单独管理

## 源码部署

```bash
pnpm install
pnpm build
pnpm start
```

开发期则更适合：

```bash
pnpm dev:start
pnpm console:build
```

## 容器化与更正式的运行方式

当本地进程管理不再足够时，再进入容器化、反向代理、持久卷和更明确的 secrets 注入。

## 生产检查项

- 使用强 bearer token 和显式 `users` 角色
- 在反向代理或 ingress 层终止 TLS
- 不要把模型密钥硬编码进提交配置
- 监控进程健康、agent backlog、workflow 失败和 MCP 连通性
- 把 sandbox 与审批策略当成部署级控制，而不是开发时附加项