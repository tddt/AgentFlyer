# Federation

Federation 是 AgentFlyer 的方向之一，但需要诚实描述：它的架构和模块边界已经存在，而实用化的多主机运行还在持续扩展。

## 仓库里已经有什么

代码树中已经有 federation-oriented modules，覆盖：

- node identity
- peer representation
- discovery
- transport seam
- memory synchronization foundations

## 为什么需要它

当一台 runtime 不够时，federation 才开始变得重要：

- 不同机器拥有不同工具或数据
- operator 希望隔离不同环境
- 计算或凭证应该更靠近各自宿主
- 多个 AgentFlyer instance 组成的 mesh 比单个超大主机更合理

## 当前应该怎么理解

把 federation 看成一个积极推进中的架构方向，而不是已经完成的 distributed control plane。

也就是说：

- 这些 seam 已经值得围绕它们设计
- 模块存在是真实的
- 生产化故事还在成长中

## 设计建议

- 先把本地 runtime 流程做干净。
- 让状态边界和执行边界保持显式。
- 不要把“所有 agent、tools 和 memory 永远都在一台机器上”写死到系统里。

## 相关页面

- [架构](./architecture)
- [Channels](./channels)
- [Memory](./memory)