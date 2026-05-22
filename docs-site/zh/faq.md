# 常见问题

## AgentFlyer 已经能用了，还是还停留在架构阶段？

它已经能作为本地或单主机 AgentOS 使用。核心 runtime、Console UI、CLI、workflow、scheduler、memory、deliverables、channels、MCP 和 sandbox 都已经在仓库里落地。Federation 仍然是持续扩展的层。

## 它是不是想替代所有 Agent 框架？

不是。它更像是把 agent execution、workflow、memory、tool access、operator control 和 multi-channel delivery 放进同一套 runtime 里，而不是试图覆盖所有类型的 AI 应用。

## 为什么不直接用聊天 UI 再挂几个工具？

因为一旦工作开始需要审批、调度、恢复、发布和可追踪状态，简单聊天壳子就会变成结构性短板。

## Federation 完成了吗？

没有。它已经进入架构和模块边界，但实用化的多主机协作仍在继续推进。

## 什么时候该用 workflow，而不是继续聊天？

当流程开始重复、多阶段、可调度、需要审查，或者输出应该变成 deliverable 时，就该进入 workflow。

## 怎么理解它的扩展方式？

- skills 负责行为和 prompt 组合
- MCP 负责外部工具
- plugins 负责可安装的 npm 扩展包