## Plan: OpenClaw 对比改进路线

目标是基于源码而不是旧文档，对 OpenClaw 的 Agent 与 Gateway 运行机制做证据化拆解，再与 AgentFlyer 当前实现逐项对照，最后产出一份以改进路线图为主的深度结论。重点聚焦五个优先级：稳定性/会话鲁棒性、Gateway 热路径性能、多 Agent 协作、联邦/多主机能力、生态扩展。

**Steps**
1. 固化证据基线：以 OpenClaw 源码中的真实入口和运行链为准，锁定 Agent 与 Gateway 的控制路径，包括懒加载入口、运行时分层、消息分发、会话持久化、子代理控制、协议边界。此步骤阻塞后续对比结论。
2. 拆解 OpenClaw Agent 机制：重点核对 agent-command、embedded runner、session store、compaction、subagent/acp 相关路径，整理其 turn 生命周期、恢复机制、会话写入约束、并发 lane、工具调用与错误恢复护栏。此步骤依赖 1。
3. 拆解 OpenClaw Gateway 机制：重点核对 server 门面、server.impl 重型启动、server-chat、protocol、dispatch-from-config、reply 路由和 runtime lazy loaders，提炼其热路径优化原则与协议分层。此步骤依赖 1，可与 2 并行。
4. 盘点 AgentFlyer 当前真实实现：核对 gateway/server、router、agent-kernel、agent-queue、agent/runner、kernel-turn-executor、mesh、federation、deliverables 等代码，明确哪些能力已实现、哪些仅有骨架、哪些已超出 OpenClaw。此步骤可与 2/3 并行。
5. 构建差距矩阵：围绕五个优先级，把 OpenClaw 的成熟机制映射到 AgentFlyer 当前状态，区分“可直接借鉴”“需要重构后吸收”“AgentFlyer 已有更优抽象”“不应照搬”四类。此步骤依赖 2/3/4。
6. 形成改进路线图：按阶段输出 AgentFlyer 的升级顺序。Phase A 聚焦稳定性与会话修复；Phase B 聚焦 Gateway 热路径与运行时事实；Phase C 聚焦结构化多 Agent 协作；Phase D 聚焦联邦桥接与远程能力调用；Phase E 聚焦生态扩展与观测治理。此步骤依赖 5。
7. 校验结论边界：对所有关键建议标记证据来源、适用前提、复杂性代价和不建议立即引入的点，避免因为过度学习 OpenClaw 而把 AgentFlyer 拖入不必要复杂度。此步骤依赖 6。

**Relevant files**
- d:\openclaw_apps\openclaw\src\gateway\server.ts — Gateway 启动门面，验证懒加载 server.impl 的入口模式
- d:\openclaw_apps\openclaw\src\gateway\server.impl.ts — Gateway 真正启动与运行时装配中心
- d:\openclaw_apps\openclaw\src\gateway\server-chat.ts — Agent 事件到聊天会话广播、生命周期快照和热路径缓存
- d:\openclaw_apps\openclaw\src\gateway\protocol\schema.ts — 网关协议边界的类型与演化约束
- d:\openclaw_apps\openclaw\src\auto-reply\dispatch.ts — inbound message 到 reply dispatch 的统一入口
- d:\openclaw_apps\openclaw\src\auto-reply\reply\dispatch-from-config.ts — 基于配置的 reply 路由、懒加载 runtime 与热路径策略
- d:\openclaw_apps\openclaw\src\agents\agent-command.ts — Agent 调度门面与大规模 lazy runtime 装配点
- d:\openclaw_apps\openclaw\src\agents\command\attempt-execution.ts — turn 执行、会话写入、CLI/runtime 选择、auth plan 等控制路径
- d:\openclaw_apps\openclaw\src\agents\pi-embedded-runner\run.ts — embedded runner 主生命周期与 runEmbeddedPiAgent 真正实现
- d:\openclaw_apps\openclaw\src\agents\acp-spawn.ts — sessions_spawn、subagent depth、child policy、lane 和 envelope 能力控制
- d:\dev_space\AI Agents\AgentFlyer\src\gateway\server.ts — AgentFlyer 网关启动和 WS/HTTP 暴露模型
- d:\dev_space\AI Agents\AgentFlyer\src\gateway\router.ts — HTTP/RPC/webhook/chat 统一入口与鉴权/路由分发
- d:\dev_space\AI Agents\AgentFlyer\src\gateway\agent-kernel.ts — 长运行 turn 的 checkpoint、恢复、stream 推送与 run 记录
- d:\dev_space\AI Agents\AgentFlyer\src\gateway\agent-queue.ts — 每 Agent FIFO 串行化队列
- d:\dev_space\AI Agents\AgentFlyer\src\agent\runner.ts — LLM/工具/compaction 主循环与消息清洗策略
- d:\dev_space\AI Agents\AgentFlyer\src\agent\process-runtime.ts — 可恢复进程状态机与 syscall 分层
- d:\dev_space\AI Agents\AgentFlyer\src\agent\kernel-turn-executor.ts — turn 级 kernel 执行器与恢复/超时模型
- d:\dev_space\AI Agents\AgentFlyer\src\mesh\bus.ts — 现有本地 MeshBus 能力与边界
- d:\dev_space\AI Agents\AgentFlyer\src\mesh\tools.ts — Mesh 任务调度与持久化现状
- d:\dev_space\AI Agents\AgentFlyer\src\federation\node.ts — Federation 节点生命周期、发现、记忆查询能力
- d:\dev_space\AI Agents\AgentFlyer\src\federation\transport\ws.ts — 联邦 WS 传输能力与限制
- d:\dev_space\AI Agents\AgentFlyer\src\gateway\deliverables.ts — 结构化交付物模型，可能成为超越 OpenClaw 的关键差异化能力
- d:\dev_space\AI Agents\AgentFlyer\docs\01-openclaw-architecture.md — 旧版对 OpenClaw 的抽象总结，需用源码校正
- d:\dev_space\AI Agents\AgentFlyer\docs\04-technical-architecture.md — AgentFlyer 设计意图与模块边界，用于对照“设计”与“现实”

**Verification**
1. 对每个关键结论至少绑定一个源码入口文件和一个相邻实现文件，避免只依据架构文档。
2. 对 OpenClaw 的性能/热路径结论优先引用懒加载入口、protocol 边界和 chat/reply 代码，而非测试命名。
3. 对 AgentFlyer 的协作/联邦结论优先引用 mesh、federation、kernel、deliverables 的实际实现，而非 docs 中的目标态描述。
4. 输出路线图时，逐条标记“直接借鉴”“重构后借鉴”“保持 AgentFlyer 现状更优”“暂缓引入”。
5. 最终报告中显式指出源码未证实或仍需进一步抽样验证的点，不把猜测写成结论。

**Decisions**
- 输出形式以改进路线图为主，不做泛泛的架构概述。
- 评估重点锁定：稳定性与会话鲁棒性、Gateway 热路径性能、多 Agent 协作、联邦/多主机能力、生态扩展。
- 对 OpenClaw 采用“深学但不盲抄”原则：优先吸收其生产化护栏、热路径纪律和协议边界；不默认继承其全部复杂性。
- AgentFlyer 已有潜在优势模块（kernel 恢复执行、mesh/federation、deliverables）将被视为超越基点，而不是只做差距清单。

**Further Considerations**
1. 重点警惕把 OpenClaw 的单机生产复杂度直接搬入 AgentFlyer：例如过早引入过多兼容分支、过大的会话/绑定模型、或对当前阶段收益不高的控制面复杂度。
2. 路线图应同时区分“底层基础设施改造”和“用户可感知能力提升”，防止全部建议都落在内部重构而难以体现价值。
3. 对协作/联邦路线要优先推动结构化结果、远程能力桥接和任务可观测性，而不是先做更多跨节点消息类型。
