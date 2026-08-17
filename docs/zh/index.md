---
layout: home

hero:
  name: AgentFlyer
  text: 让 Agent 像系统一样运转。
  tagline: 一个面向操作者的 AgentOS 运行时，把多 Agent 协作、工作流、记忆、交付物、MCP、Sandbox 和多通道控制面统一在同一套系统里。
  image:
    src: /console-runtime.svg
    alt: AgentFlyer 控制台运行时预览
  actions:
    - theme: brand
      text: 开始使用
      link: /zh/guide/getting-started
    - theme: alt
      text: 查看架构
      link: /zh/guide/architecture
    - theme: alt
      text: GitHub
      link: https://github.com/tddt/AgentFlyer

features:
  - icon: ◌
    title: Multi-Agent Mesh
    details: 让 coordinator、worker 和 specialist agent 在同一运行时里发现彼此并协作，而不是困在单个聊天窗口里。
  - icon: ⟁
    title: Workflow Runtime
    details: 把一次性 prompt 变成可重复执行的流程图，带 scheduler、历史记录和 deliverables。
  - icon: ⌘
    title: MCP 与 Sandbox
    details: 通过 MCP 接外部工具，用 Docker-backed sandbox profile 收紧执行边界。
  - icon: ◫
    title: Operator Control Plane
    details: 用 Console UI 和 CLI 管理 sessions、审批、memory、workflow、scheduler 和运行状态。
  - icon: ∿
    title: Multi-Channel Delivery
    details: 同一套 runtime 可从 Web、CLI、Telegram、Discord、飞书和 QQ 进入。
  - icon: ◎
    title: Federation Direction
    details: 已具备 peer identity、discovery、transport 和 memory-sync 的架构基础，并持续向多主机协作推进。
---

<div class="marketing-shell">
  <section id="why-agentflyer" class="marketing-panel">
    <div class="marketing-panel-inner">
      <p class="marketing-eyebrow">为什么存在</p>
      <h2 class="marketing-title">大多数 Agent 项目仍然像被临时粘起来的 Demo。</h2>
      <p class="marketing-lead">
        AgentFlyer 瞄准的是另一类东西：一个真正面向操作者的运行时，
        把 agents、workflow、memory、tools、deliverables 和 channel delivery 放进同一套系统边界里。
        它今天已经能在单机上产生真实价值，同时为后续的跨主机协作保留清晰的演进路径。
      </p>
      <div class="marketing-stats">
        <div class="marketing-stat">
          <strong>1 runtime</strong>
          <span>统一承载 chat、orchestration、memory、tools 和 delivery</span>
        </div>
        <div class="marketing-stat">
          <strong>6 channels</strong>
          <span>Web、CLI、Telegram、Discord、飞书和 QQ</span>
        </div>
        <div class="marketing-stat">
          <strong>Operator-first</strong>
          <span>Console UI、sessions、审批、scheduler、workflow、stats</span>
        </div>
        <div class="marketing-stat">
          <strong>Federation-ready</strong>
          <span>peer、discovery、transport 和 sync seam 已在树中</span>
        </div>
      </div>
    </div>
  </section>

  <section class="marketing-grid">
    <article class="marketing-panel">
      <div class="marketing-panel-inner">
        <p class="marketing-eyebrow">系统形态</p>
        <h2 class="marketing-title">这是一套 runtime，不是另一层 wrapper。</h2>
        <ul class="marketing-list">
          <li><span class="marketing-kicker">Mesh</span><div>让多个 agent 在同一实例里分工协作，而不是把所有流程都压进一个超长 prompt。</div></li>
          <li><span class="marketing-kicker">State</span><div>把 sessions、searchable memory、deliverables 和 artifacts 变成持久状态，而不是一次性聊天输出。</div></li>
          <li><span class="marketing-kicker">Control</span><div>通过 CLI 和 Console UI 可见地管理 sessions、审批、scheduler 活动和运行健康度。</div></li>
          <li><span class="marketing-kicker">Execution</span><div>把 MCP 工具和 sandbox execution 纳入运行时边界，而不是默认向模型开放宿主机能力。</div></li>
        </ul>
      </div>
    </article>
    <article class="marketing-panel">
      <div class="marketing-panel-inner">
        <p class="marketing-eyebrow">现在与下一步</p>
        <h2 class="marketing-title">它建立在已落地的系统表面上。</h2>
        <ul class="marketing-list">
          <li><span class="marketing-kicker">Now</span><div>Runtime、Console UI、workflow、scheduler、memory、channels、CLI、deliverables、MCP 和 sandbox 都已经在仓库里。</div></li>
          <li><span class="marketing-kicker">Next</span><div>Federation 已有明确模块和架构边界，实用化的多主机协作仍在持续扩展。</div></li>
        </ul>
      </div>
    </article>
  </section>

  <section class="marketing-showcase">
    <article class="marketing-panel">
      <div class="marketing-panel-inner marketing-showcase-copy">
        <p class="marketing-eyebrow">Console UI</p>
        <h2 class="marketing-title">一套人能真正操作的控制平面。</h2>
        <p class="marketing-lead">
          AgentFlyer 不要求操作者只能靠日志和 prompt 文本去猜系统状态。
          这套 runtime 从一开始就围绕 sessions、审批、workflow、scheduler、deliverables 和 live context 来设计可视化表面。
        </p>
        <ul class="marketing-checks">
          <li>无需打开代码，就能查看 agent 活动、backlog 和 suspended runs。</li>
          <li>把 chat 输出提升为 deliverable record，并继续发布到目标渠道。</li>
          <li>在同一控制面里追踪 MCP 状态、scheduler 进度和 workflow 执行。</li>
        </ul>
      </div>
    </article>
    <article class="console-preview">
      <div class="console-preview-topbar">
        <div class="console-preview-dots"><span></span><span></span><span></span></div>
        <div class="console-preview-title">AgentFlyer Console</div>
      </div>
      <div class="console-preview-body">
        <aside class="console-preview-sidebar">
          <h3>Surfaces</h3>
          <div class="console-preview-nav">
            <span>Overview</span>
            <span>Agents</span>
            <span>Inbox</span>
            <span class="active">Scheduler</span>
            <span>Workflow</span>
            <span>Deliverables</span>
            <span>Federation</span>
          </div>
        </aside>
        <div class="console-preview-main">
          <h3>Runtime Snapshot</h3>
          <div class="console-preview-stats">
            <div class="console-preview-stat"><strong>12</strong><span>今日计划执行</span></div>
            <div class="console-preview-stat"><strong>3</strong><span>待审批的 suspended runs</span></div>
            <div class="console-preview-stat"><strong>8</strong><span>已发布 deliverables</span></div>
          </div>
          <div class="console-preview-feed">
            <div class="console-preview-card"><div class="console-preview-card-head"><span>weekly-market-brief</span><span class="console-preview-tag">running</span></div><p>Research agent 已完成信息收集，Review agent 正在处理相互矛盾的信号后再发布。</p></div>
            <div class="console-preview-card"><div class="console-preview-card-head"><span>mcp/content-indexer</span><span class="console-preview-tag">connected</span></div><p>工具注册表已刷新，当前 operator policy 允许在 sandbox profile 内执行索引搜索和导出。</p></div>
            <div class="console-preview-card"><div class="console-preview-card-head"><span>policy-review-run</span><span class="console-preview-tag">approval</span></div><p>有一条工具调用正在等待审批，session 状态、推理上下文和下一步动作仍可恢复。</p></div>
          </div>
        </div>
      </div>
    </article>
  </section>

  <section class="marketing-blueprint">
    <article class="marketing-panel">
      <div class="marketing-panel-inner marketing-visual-panel">
        <p class="marketing-eyebrow">运行时拓扑</p>
        <h2 class="marketing-title">一个 runtime，多种操作表面。</h2>
        <p class="marketing-lead">真正重要的不是它“有 channels、workflow、memory、MCP 和 sandbox”，而是这些能力被组织成同一套 coherent runtime，而不是散落在多个临时系统里。</p>
        <img class="marketing-diagram" src="/runtime-topology.svg" alt="AgentFlyer 分层运行时拓扑图" />
      </div>
    </article>
    <article class="marketing-panel">
      <div class="marketing-panel-inner marketing-showcase-copy">
        <p class="marketing-eyebrow">部署路径</p>
        <h2 class="marketing-title">从单机开始，再逐步系统化。</h2>
        <p class="marketing-lead">AgentFlyer 最合理的采用方式是递进式的：先一台机器，再一个 control plane，再更严格的部署和边界，最后才是跨主机协作。</p>
        <div class="deployment-steps">
          <div class="deployment-step"><strong>01</strong><div><h3>单机 runtime</h3><p>先拉起 gateway、Console UI 和一两个 agent，验证 system shape 和 operator flow。</p></div></div>
          <div class="deployment-step"><strong>02</strong><div><h3>运营化流程</h3><p>引入 workflow、scheduler、deliverables 和审批，让重复工作脱离临时聊天。</p></div></div>
          <div class="deployment-step"><strong>03</strong><div><h3>受控工具访问</h3><p>把外部动作逐步迁移到 MCP 和 sandbox profile，让执行边界可见且可控。</p></div></div>
          <div class="deployment-step"><strong>04</strong><div><h3>多主机演进</h3><p>当本地 runtime 已经足够干净和稳定时，再继续向 federation 演进。</p></div></div>
        </div>
      </div>
    </article>
  </section>

  <section class="marketing-proof">
    <article class="marketing-proof-card"><h3>Operator Surfaces</h3><p>Console UI 和 CLI 不是附加功能，而是产品边界的一部分。</p><ul><li>Sessions 与恢复</li><li>审批与策略控制</li><li>Scheduler、workflow、deliverables</li></ul></article>
    <article class="marketing-proof-card"><h3>Execution Discipline</h3><p>工具访问是运行时里的受控能力，而不是临时加进去的接口。</p><ul><li>MCP registry 与 transport layer</li><li>Docker-backed sandbox profiles</li><li>审批感知的执行流</li></ul></article>
    <article class="marketing-proof-card"><h3>Delivery Paths</h3><p>同一套 runtime 可以直接服务多个渠道，而不是每个入口各写一套机器人。</p><ul><li>Web 与 streaming chat</li><li>CLI 本地操作路径</li><li>消息渠道适配器</li></ul></article>
  </section>

  <section class="marketing-panel">
    <div class="marketing-panel-inner">
      <p class="marketing-eyebrow">适合在什么场景里使用</p>
      <h2 class="marketing-title">当工作需要协作、记忆和控制时，它就开始值得。</h2>
      <div class="marketing-cases">
        <article class="marketing-case"><h3>Team AgentOS</h3><p>在同一 runtime 中运行 coordinator、analyst 和 specialist agents，形成可复用的内部操作系统。</p></article>
        <article class="marketing-case"><h3>Operator Workflows</h3><p>构建采集、辩论、评审和发布型流程，让输出变成可追踪 deliverables，而不是一次性聊天记录。</p></article>
        <article class="marketing-case"><h3>Controlled Tooling</h3><p>当 agent 需要访问外部系统，但又不能直接继承宿主机全部权限时，MCP 和 sandbox 就变得有意义。</p></article>
      </div>
    </div>
  </section>

  <section class="marketing-panel">
    <div class="marketing-panel-inner">
      <p class="marketing-eyebrow">辅助决策</p>
      <h2 class="marketing-title">不是所有 Agent 项目都需要这种形态。</h2>
      <p class="marketing-lead">AgentFlyer 适合的是已经超出单一聊天工作流、隐藏工具调用和一次性自动化脚本的问题。只要开始需要 operator surface、durable state 和从一台机器走向多台机器的演进路径，这套系统形态就会成立。</p>
      <div class="marketing-decisions">
        <article class="marketing-decision-card"><h3>适合用 AgentFlyer</h3><p>当你希望 sessions、workflows、deliverables、channels、approvals 和 tools 都存在于一套 runtime 里，而不是散落在多个产品中。</p></article>
        <article class="marketing-decision-card"><h3>适合更小的栈</h3><p>如果你只需要一个带少量工具的单助手，没有 operator 控制面、scheduler、workflow 或多 channel 需求，那么它可能太重了。</p></article>
      </div>
      <div class="marketing-links">
        <a class="marketing-link-card" href="/zh/use-cases"><strong>适用场景</strong><span>查看在哪些 runtime 形态里 AgentFlyer 最实用。</span></a>
        <a class="marketing-link-card" href="/zh/comparison"><strong>对比说明</strong><span>理解它与聊天壳子、工具跑器和 workflow-only 工具的差异。</span></a>
        <a class="marketing-link-card" href="/zh/faq"><strong>常见问题</strong><span>直接查看关于成熟度、federation、扩展性和 operator workflow 的回答。</span></a>
        <a class="marketing-link-card" href="/zh/roadmap"><strong>路线图</strong><span>分清哪些层已经落地，哪些层仍在持续深化。</span></a>
      </div>
    </div>
  </section>

  <section class="marketing-panel">
    <div class="marketing-panel-inner">
      <p class="marketing-eyebrow">转化路径</p>
      <h2 class="marketing-title">先判断谁该用、何时不用，再立即开始试用。</h2>
      <div class="marketing-decisions">
        <article class="marketing-decision-card">
          <h3>谁适合用</h3>
          <p>需要可持续 workflow、操作者可见性、审批感知工具执行、并希望多通道共享同一 runtime 的团队。</p>
        </article>
        <article class="marketing-decision-card">
          <h3>何时不建议用</h3>
          <p>如果只是单助手或一次性聊天任务，不需要工作流状态、控制面和策略边界，这套系统可能偏重。</p>
        </article>
      </div>
      <div class="marketing-links">
        <a class="marketing-link-card" href="/zh/audiences/developers">
          <strong>按角色选择</strong>
          <span>给开发者、运营团队、企业和插件作者的最短落地路径。</span>
        </a>
        <a class="marketing-link-card" href="/zh/project-facts">
          <strong>项目事实</strong>
          <span>在一页内快速核对定位、能力边界与评估清单。</span>
        </a>
        <a class="marketing-link-card" href="/zh/guide/getting-started">
          <strong>立即试用</strong>
          <span>先拉起一个 runtime，再用首个流程验证匹配度。</span>
        </a>
      </div>
    </div>
  </section>

  <section class="marketing-panel">
    <div class="marketing-panel-inner marketing-cta">
      <div>
        <p class="marketing-eyebrow">快速启动</p>
        <h2 class="marketing-title">几分钟内拉起运行时。</h2>
        <p class="marketing-lead">安装包、定义一个模型和一个 agent，然后打开 Console UI 或直接使用 CLI。</p>
        <div class="marketing-cta-actions">
          <span class="marketing-pill">npm install -g agentflyer</span>
          <span class="marketing-pill">agentflyer start</span>
          <span class="marketing-pill">http://localhost:19789</span>
          <span class="marketing-pill">agentflyer chat</span>
        </div>
      </div>
      <div class="marketing-cta-actions">
        <a class="VPButton brand" href="/zh/guide/getting-started">开始使用</a>
        <a class="VPButton alt" href="/zh/guide/configuration">查看配置</a>
        <a class="VPButton alt" href="/zh/roadmap">查看路线图</a>
        <a class="VPButton alt" href="/zh/comparison">阅读对比</a>
      </div>
    </div>
  </section>
</div>