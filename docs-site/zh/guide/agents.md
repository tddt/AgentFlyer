# Agents

Agent 是 AgentFlyer 运行时中的身份单元。它不是一个简单的 prompt 预设，而是能够长期参与执行、协作和交付的运行时参与者。

## Agent 代表什么

在 AgentFlyer 中，一个 agent 可以：

- 接收直接请求
- 拥有自己的 sessions 和 memory 上下文
- 参与 mesh 协作
- 被 workflow 和 scheduler 直接调用
- 把结果沉淀为 deliverables 并继续发布到 channels

## 合理的 agent 边界

只有当职责是稳定且有运营意义的，才值得拆成一个新的 agent。

例子：

- `main` 或 `coordinator` 负责路由和总协调
- `research` 负责信息采集和证据收集
- `review` 负责验证、评审和风险检查
- `publish` 负责格式化与交付

不要为了每一种 prompt 变体都创建一个新 agent，那只会让配置和运营复杂度膨胀。

## 常见拓扑

| 角色 | 用途 |
|---|---|
| Coordinator | 负责 intake、分解任务和最终汇总 |
| Worker | 负责一类边界清晰的执行任务 |
| Specialist | 负责代码、分析、格式化等重领域任务 |

## 配置时最值得关注的信号

- `id` 和 `name`
- 来自 `defaults` 或本地覆盖的 model reference
- `skills`
- mesh role、capabilities 和 visibility
- 可选的 workspace 或执行相关设置

## 运营建议

- 初期保持 always-on agents 数量尽量少。
- 重复性流程交给 workflows，而不是把所有逻辑都塞进一个 agent。
- 当输出需要从“回复文本”升级成“运营资产”时，用 deliverables 承接。

## 相关页面

- [配置](./configuration)
- [Workflows](./workflows)
- [Memory](./memory)