# 插件市场

AgentFlyer 的插件市场路径围绕 npm 包和 CLI 管理命令展开。

```bash
agentflyer plugin search <keyword>
agentflyer plugin install <name>
agentflyer plugin list
agentflyer plugin remove <name>
```

安装完成后，把插件入口加入配置里的 `plugins` 数组，然后执行 `agentflyer reload`。