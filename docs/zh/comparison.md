# 对比说明

AgentFlyer 不是为了成为“最轻的一层聊天包装器”。它的意义出现在工作开始需要运行时结构之后。

## 类别对比

| 类别 | 擅长 | 常见短板 | AgentFlyer 的差异 |
|---|---|---|---|
| 单一聊天壳子 | 快速起步、一个助手、少量工具 | durable state、operator control、repeatable workflow | AgentFlyer 把 sessions、workflow、deliverables、approvals 和多 agent runtime 都纳入系统边界 |
| workflow-only 工具 | 明确步骤、固定图结构 | live agent collaboration、multi-channel surface、rich operator chat loop | AgentFlyer 保留 workflow，同时支持 agent 回合、sessions 和控制面 |
| 工具执行器 + LLM | API 调用、命令执行 | 操作型控制面、memory、delivery surface | AgentFlyer 把 tools 作为 runtime 的一层，而不是整个产品本体 |
| 每个渠道各做一个 bot | 接入方便 | 逻辑重复、状态割裂、运营分散 | AgentFlyer 把 runtime 中心化，让 channels 保持轻薄 |

## 什么时候选 AgentFlyer

- 你需要不止一个 agent 角色
- workflow 需要被检查、调度和恢复
- 输出应该升级为 deliverables
- 操作者需要审批、恢复和运行时可见性
- 多个 channel 应共享一套 runtime 核心
- 工具访问需要策略和边界

## 什么时候选更小的栈

- 一个助手就够
- 不需要控制面
- 没有 scheduler、workflow 或 deliverable 概念
- 交互是一次性的，不需要积累状态