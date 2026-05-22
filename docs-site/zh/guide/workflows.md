# Workflows

Workflow 是 AgentFlyer 把一次性 agent 回合转成可重复 operator process 的主要方式。

## Workflow runtime 提供什么

- 有顺序的执行步骤
- branching 和条件路径
- 步骤之间的 transform
- super-node 协作模式
- execution history 和 resumable status
- 面向 deliverables 的输出处理

## 什么时候该用 workflow

探索性任务先用 chat。

当任务开始具备下面这些特征时，就应该进入 workflow：

- 可重复
- 多阶段
- 需要被 operator 审查
- 可以被调度
- 值得存成执行产物

## 常见 workflow 形状

| 模式 | 例子 |
|---|---|
| Collect -> analyze -> publish | 收集资料、综合分析、生成最终 deliverable |
| Debate -> review -> decide | 多 specialist 输出、裁定、生成决策记录 |
| Intake -> route -> execute | 把入站请求变成 agent 定向执行 |
| Scheduled automation | 定时任务触发 workflow 并产出 deliverables |

## Super-node 的作用

当一个步骤本质上代表的是更高阶的协作，而不是一次单点 agent 调用时，super node 就变得很有价值。它特别适合集合、比较、评审和裁决型流程。

## 为什么它对 operator 有价值

Workflow 的意义在于把系统从 reactive chat 推向 operational process：

- 历史可检查
- 失败可诊断
- 输出可升级为 deliverables
- schedule 可以安全挂接

## 相关页面

- [Agents](./agents)
- [Memory](./memory)
- [部署](./deployment)