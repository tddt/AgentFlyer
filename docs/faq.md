# FAQ

## Is AgentFlyer already usable, or is it still just an architecture experiment?

It is already usable as a local or single-host AgentOS runtime. Core runtime behavior, Console UI, CLI, workflows, scheduler, memory, deliverables, channels, MCP, and sandbox support are all present in the repository. Federation is the part that is still clearly in expansion.

## Is this meant to replace every existing agent framework?

No. The point is narrower and more practical: provide one runtime that can own agent execution, workflows, memory, tool access, operator control, and multi-channel delivery without forcing those concerns to live in separate stitched-together systems.

## Why not just use a chatbot UI with a few tools attached?

Because that approach breaks down once the work becomes repeatable, multi-agent, approval-sensitive, or operationally visible. AgentFlyer is more useful when you need sessions, deliverables, scheduler runs, workflow history, and tool boundaries to remain explicit over time.

## Is federation finished?

No. Federation is present as an architectural direction with actual modules and seams already in the codebase, but practical multi-host operations are still being expanded.

## When should I use workflows instead of chat?

Use chat for exploratory work. Use workflows when the process is repeatable, multi-stage, reviewable, schedulable, or expected to produce deliverables rather than only transient replies.

## How should I think about extensibility?

Use the smallest seam that matches the problem:

- skills for behavior and prompt composition
- MCP for external tool access
- plugins for installable npm-packaged runtime extensions

## Can I operate it without building my own frontend?

Yes. AgentFlyer already includes a Console UI and CLI. The web surface, RPC endpoints, SSE chat, and channel adapters are designed so you can operate the runtime before building custom product surfaces on top of it.

## What does “operator-first” mean here?

It means the system is intentionally shaped for the person running it, not only the person chatting with it. That includes approvals, sessions, queue visibility, workflow status, scheduler history, deliverables, and runtime health.