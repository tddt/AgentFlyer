# 适用场景

AgentFlyer 真正开始有价值的时刻，不是在“能不能聊天”，而是在工作同时需要状态、协作和控制的时候。

## Team AgentOS

当一个小团队希望在同一套 runtime 里承载 coordinator、analyst 和 specialist agents，而不是靠手工转发上下文时，这就是 AgentFlyer 的典型场景。

## 研究、评审、发布流水线

当任务天然会分成“收集 -> 交叉验证 -> 输出发布”几个阶段时，workflow、deliverables 和 sessions 的组合会比长对话更稳定。

## 面向操作者的自动化

如果自动化流程需要人工审批、挂起恢复、scheduler 触发和可追踪历史，那么它更像运行时问题，而不只是一个脚本问题。

## 多通道控制中枢

当 Web、CLI 和消息渠道都要共享同一套 agent 逻辑和状态时，把 runtime 集中到一处比为每个渠道单独做 bot 更合理。

## 工具很多，但边界必须清晰

当 agent 需要调外部系统，又不能默认继承宿主机所有权限时，MCP、approval 和 sandbox profile 就会成为核心能力。

## 不适合的时候

如果你只需要一个简单助手、没有 workflow 状态、也不需要 operator UI，那通常应该选择更小的栈。