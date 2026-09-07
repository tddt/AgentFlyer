---
layout: home

hero:
  name: AgentFlyer
  text: Operate agents like a system.
  tagline: A practical AgentOS runtime for multi-agent orchestration, workflows, memory, deliverables, MCP, sandboxed execution, and multi-channel operator control.
  image:
    src: /console-runtime.svg
    alt: AgentFlyer runtime console overview
  actions:
    - theme: brand
      text: Launch The Runtime
      link: /guide/getting-started
    - theme: alt
      text: Read The Architecture
      link: /guide/architecture
    - theme: alt
      text: View on GitHub
      link: https://github.com/tddt/AgentFlyer

features:
  - icon: ◌
    title: Multi-Agent Mesh
    details: Run coordinator, worker, and specialist agents in one runtime with discoverable collaboration instead of isolated chat tabs.
  - icon: ⟁
    title: Workflow Runtime
    details: Move from one-off prompts to repeatable execution graphs with scheduler triggers, execution history, and deliverables.
  - icon: ⌘
    title: MCP And Sandbox
    details: Connect external tools through MCP and keep execution boundaries tighter with approval policies and Docker-backed sandbox profiles.
  - icon: ◫
    title: Operator Control Plane
    details: Use the Console UI and CLI for sessions, approvals, memory, workflows, scheduler operations, and runtime health.
  - icon: ∿
    title: Multi-Channel Delivery
    details: Serve the same runtime through Web, CLI, Telegram, Discord, Feishu, and QQ entry points.
  - icon: ◎
    title: Federation Direction
    details: Build on an architecture that already includes peer identity, discovery, transport seams, and memory-sync foundations.
---

<div class="marketing-shell">
  <section id="why-agentflyer" class="marketing-panel">
    <div class="marketing-panel-inner">
      <p class="marketing-eyebrow">Why it exists</p>
      <h2 class="marketing-title">Most agent stacks still feel like glued demos.</h2>
      <p class="marketing-lead">
        AgentFlyer is aimed at a different category: an operator-facing runtime where agents, workflows,
        memory, tools, deliverables, and channel delivery live inside the same system boundary.
        It is already useful on a single machine today and intentionally structured to grow toward
        cross-host collaboration later.
      </p>
      <div class="marketing-stats">
        <div class="marketing-stat">
          <strong>1 runtime</strong>
          <span>for chat, orchestration, memory, tools, and delivery</span>
        </div>
        <div class="marketing-stat">
          <strong>6 channels</strong>
          <span>web, CLI, Telegram, Discord, Feishu, and QQ surfaces</span>
        </div>
        <div class="marketing-stat">
          <strong>Operator-first</strong>
          <span>Console UI, sessions, approvals, scheduler, workflows, stats</span>
        </div>
        <div class="marketing-stat">
          <strong>Federation-ready</strong>
          <span>with peer, discovery, transport, and sync seams already present</span>
        </div>
      </div>
    </div>
  </section>

  <section class="marketing-grid">
    <article class="marketing-panel">
      <div class="marketing-panel-inner">
        <p class="marketing-eyebrow">System shape</p>
        <h2 class="marketing-title">A runtime, not another wrapper.</h2>
        <ul class="marketing-list">
          <li>
            <span class="marketing-kicker">Mesh</span>
            <div>Run multiple agents in the same instance and let them delegate and coordinate instead of keeping every workflow inside one giant prompt.</div>
          </li>
          <li>
            <span class="marketing-kicker">State</span>
            <div>Persist sessions, searchable memory, deliverables, and artifacts so useful results survive beyond a single turn.</div>
          </li>
          <li>
            <span class="marketing-kicker">Control</span>
            <div>Operate the system through CLI and Console UI with visibility into sessions, approvals, scheduler activity, and runtime health.</div>
          </li>
          <li>
            <span class="marketing-kicker">Execution</span>
            <div>Integrate MCP tool servers and sandboxed execution instead of handing raw host access to every model-driven action.</div>
          </li>
        </ul>
      </div>
    </article>
    <article class="marketing-panel">
      <div class="marketing-panel-inner">
        <p class="marketing-eyebrow">Today vs next</p>
        <h2 class="marketing-title">Built on shipped surfaces.</h2>
        <ul class="marketing-list">
          <li>
            <span class="marketing-kicker">Now</span>
            <div>Runtime, Console UI, workflows, scheduler, memory, channels, CLI, deliverables, MCP, and sandbox are present in the tree.</div>
          </li>
          <li>
            <span class="marketing-kicker">Next</span>
            <div>Federation is already represented in architecture and modules, with practical multi-host operation continuing as an active expansion area.</div>
          </li>
        </ul>
      </div>
    </article>
  </section>

  <section class="marketing-showcase">
    <article class="marketing-panel">
      <div class="marketing-panel-inner marketing-showcase-copy">
        <p class="marketing-eyebrow">Console UI</p>
        <h2 class="marketing-title">A control plane people can actually operate.</h2>
        <p class="marketing-lead">
          AgentFlyer is not asking operators to infer system state from logs and prompt text alone.
          The runtime is shaped around visible surfaces for sessions, approvals, workflows, scheduler activity,
          deliverables, and live operational context.
        </p>
        <ul class="marketing-checks">
          <li>Inspect agent activity, backlog, and suspended runs without opening the codebase.</li>
          <li>Move from chat output to deliverable records and publication targets inside one runtime surface.</li>
          <li>Track MCP status, scheduler progress, and workflow execution from the same operator boundary.</li>
        </ul>
      </div>
    </article>
    <article class="console-preview">
      <div class="console-preview-topbar">
        <div class="console-preview-dots">
          <span></span>
          <span></span>
          <span></span>
        </div>
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
            <div class="console-preview-stat">
              <strong>12</strong>
              <span>scheduled runs today</span>
            </div>
            <div class="console-preview-stat">
              <strong>3</strong>
              <span>suspended approvals waiting</span>
            </div>
            <div class="console-preview-stat">
              <strong>8</strong>
              <span>deliverables published</span>
            </div>
          </div>
          <div class="console-preview-feed">
            <div class="console-preview-card">
              <div class="console-preview-card-head">
                <span>weekly-market-brief</span>
                <span class="console-preview-tag">running</span>
              </div>
              <p>Research agent completed evidence gathering. Review agent is validating contradictory signals before publish.</p>
            </div>
            <div class="console-preview-card">
              <div class="console-preview-card-head">
                <span>mcp/content-indexer</span>
                <span class="console-preview-tag">connected</span>
              </div>
              <p>Tool registry refreshed. Operator policy allows indexed search, summarization, and export within sandbox profile.</p>
            </div>
            <div class="console-preview-card">
              <div class="console-preview-card-head">
                <span>policy-review-run</span>
                <span class="console-preview-tag">approval</span>
              </div>
              <p>One tool call is paused for approval. Session state, reasoning context, and next action remain recoverable.</p>
            </div>
          </div>
        </div>
      </div>
    </article>
  </section>

  <section class="marketing-blueprint">
    <article class="marketing-panel">
      <div class="marketing-panel-inner marketing-visual-panel">
        <p class="marketing-eyebrow">Runtime map</p>
        <h2 class="marketing-title">One runtime, multiple operating surfaces.</h2>
        <p class="marketing-lead">
          The important part is not that AgentFlyer has channels, workflows, memory, MCP, and sandboxing.
          The important part is that they are arranged as one coherent runtime instead of scattered subsystems.
        </p>
        <img class="marketing-diagram" src="/runtime-topology.svg" alt="AgentFlyer layered runtime topology" />
      </div>
    </article>
    <article class="marketing-panel">
      <div class="marketing-panel-inner marketing-showcase-copy">
        <p class="marketing-eyebrow">Deployment path</p>
        <h2 class="marketing-title">Start local, grow operationally.</h2>
        <p class="marketing-lead">
          AgentFlyer works best when adoption is incremental: first one machine, then one control plane,
          then more disciplined deployment, and only then cross-host collaboration.
        </p>
        <div class="deployment-steps">
          <div class="deployment-step">
            <strong>01</strong>
            <div>
              <h3>Single-host runtime</h3>
              <p>Bring up the gateway, Console UI, and one or two agents to validate system shape and operator flow.</p>
            </div>
          </div>
          <div class="deployment-step">
            <strong>02</strong>
            <div>
              <h3>Operational process</h3>
              <p>Add workflows, scheduler runs, deliverables, and approvals so repeated work stops living inside ad hoc chats.</p>
            </div>
          </div>
          <div class="deployment-step">
            <strong>03</strong>
            <div>
              <h3>Bounded tool access</h3>
              <p>Move external actions through MCP and sandbox profiles so execution boundaries stay visible and controllable.</p>
            </div>
          </div>
          <div class="deployment-step">
            <strong>04</strong>
            <div>
              <h3>Multi-host direction</h3>
              <p>Extend toward federation once the local runtime is already clean, durable, and operationally meaningful.</p>
            </div>
          </div>
        </div>
      </div>
    </article>
  </section>

  <section class="marketing-proof">
    <article class="marketing-proof-card">
      <h3>Operator Surfaces</h3>
      <p>Console UI and CLI are not optional extras. They are part of the product boundary.</p>
      <ul>
        <li>Sessions and recovery</li>
        <li>Approvals and policy control</li>
        <li>Scheduler, workflows, deliverables</li>
      </ul>
    </article>
    <article class="marketing-proof-card">
      <h3>Execution Discipline</h3>
      <p>Tool access is treated as a controllable runtime concern, not an afterthought.</p>
      <ul>
        <li>MCP registry and transport layer</li>
        <li>Docker-backed sandbox profiles</li>
        <li>Approval-aware execution flow</li>
      </ul>
    </article>
    <article class="marketing-proof-card">
      <h3>Delivery Paths</h3>
      <p>The same runtime can meet users where they already are instead of forcing one UI.</p>
      <ul>
        <li>Web and streaming chat</li>
        <li>CLI for local operations</li>
        <li>Messaging channel adapters</li>
      </ul>
    </article>
  </section>

  <section class="marketing-panel">
    <div class="marketing-panel-inner">
      <p class="marketing-eyebrow">Where it fits</p>
      <h2 class="marketing-title">Use it when the work needs coordination, memory, and control.</h2>
      <div class="marketing-cases">
        <article class="marketing-case">
          <h3>Team AgentOS</h3>
          <p>Run coordinator, analyst, and specialist agents in one runtime for repeatable internal operations.</p>
        </article>
        <article class="marketing-case">
          <h3>Operator Workflows</h3>
          <p>Build collection, review, debate, and publishing flows that create trackable deliverables instead of disposable chat logs.</p>
        </article>
        <article class="marketing-case">
          <h3>Controlled Tooling</h3>
          <p>Adopt MCP and sandboxed execution when agents need to call external systems without inheriting unrestricted host access.</p>
        </article>
      </div>
    </div>
  </section>

  <section class="marketing-panel">
    <div class="marketing-panel-inner">
      <p class="marketing-eyebrow">Decision help</p>
      <h2 class="marketing-title">Not every agent project needs this shape.</h2>
      <p class="marketing-lead">
        AgentFlyer is a better fit when the problem has already outgrown single-chat workflows,
        hidden tool calls, or one-off automation scripts. If you need a real operator surface,
        durable runtime state, and a path from one host to many, this is where the system starts to make sense.
      </p>
      <div class="marketing-decisions">
        <article class="marketing-decision-card">
          <h3>Choose AgentFlyer if...</h3>
          <p>You want sessions, workflows, deliverables, channels, approvals, and tools to live inside one runtime instead of being stitched together across separate products.</p>
        </article>
        <article class="marketing-decision-card">
          <h3>Use something smaller if...</h3>
          <p>You only need a single assistant with a couple of tools and no operator-facing coordination, memory, scheduler, or multi-channel requirements.</p>
        </article>
      </div>
      <div class="marketing-links">
        <a class="marketing-link-card" href="/use-cases">
          <strong>Use Cases</strong>
          <span>See the runtime shapes where AgentFlyer is most practical.</span>
        </a>
        <a class="marketing-link-card" href="/comparison">
          <strong>Comparison</strong>
          <span>Understand how this differs from chat wrappers, tool runners, and workflow-only stacks.</span>
        </a>
        <a class="marketing-link-card" href="/faq">
          <strong>FAQ</strong>
          <span>Get direct answers on maturity, federation, extensibility, and operator workflows.</span>
        </a>
        <a class="marketing-link-card" href="/roadmap">
          <strong>Roadmap</strong>
          <span>See which parts are already real and which layers are still being deepened.</span>
        </a>
      </div>
    </div>
  </section>

  <section class="marketing-panel">
    <div class="marketing-panel-inner">
      <p class="marketing-eyebrow">Adoption path</p>
      <h2 class="marketing-title">Who should use it, when to avoid it, and where to start now.</h2>
      <div class="marketing-decisions">
        <article class="marketing-decision-card">
          <h3>Who should use it</h3>
          <p>Teams that need durable workflows, operator visibility, approval-aware tool execution, and one runtime shared across channels.</p>
        </article>
        <article class="marketing-decision-card">
          <h3>When to avoid it</h3>
          <p>Single-assistant or disposable chat tasks with no workflow state, no control plane, and no policy boundaries.</p>
        </article>
      </div>
      <div class="marketing-links">
        <a class="marketing-link-card" href="/audiences/developers">
          <strong>By Role</strong>
          <span>Choose the shortest path for developers, operators, enterprise teams, and plugin authors.</span>
        </a>
        <a class="marketing-link-card" href="/project-facts">
          <strong>Project Facts</strong>
          <span>Review scope, capability boundaries, and evaluator checklists in one page.</span>
        </a>
        <a class="marketing-link-card" href="/guide/getting-started">
          <strong>Try It Now</strong>
          <span>Launch one runtime and validate fit with a practical first workflow.</span>
        </a>
      </div>
    </div>
  </section>

  <section class="marketing-panel">
    <div class="marketing-panel-inner marketing-cta">
      <div>
        <p class="marketing-eyebrow">Fast start</p>
        <h2 class="marketing-title">Boot the runtime in minutes.</h2>
        <p class="marketing-lead">
          Install the package, define one model and one agent, then open the Console UI or use the CLI.
        </p>
        <div class="marketing-cta-actions">
          <span class="marketing-pill">npm install -g agentflyer</span>
          <span class="marketing-pill">agentflyer start</span>
          <span class="marketing-pill">http://localhost:19789</span>
          <span class="marketing-pill">agentflyer chat</span>
        </div>
      </div>
      <div class="marketing-cta-actions">
        <a class="VPButton brand" href="/guide/getting-started">Get Started</a>
        <a class="VPButton alt" href="/guide/configuration">View Config</a>
        <a class="VPButton alt" href="/roadmap">See Roadmap</a>
        <a class="VPButton alt" href="/comparison">Read Comparison</a>
      </div>
    </div>
  </section>
</div>
