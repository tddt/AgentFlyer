# Comparison

AgentFlyer is not trying to win by being the smallest possible wrapper around a model. Its value appears when the work needs runtime structure.

## Category comparison

| Category | Good at | Usually weak at | AgentFlyer difference |
|---|---|---|---|
| Single chat wrapper | fast setup, one assistant, simple tools | durable state, operator control, repeatable workflows | AgentFlyer adds sessions, workflows, deliverables, approvals, and multi-agent runtime structure |
| Workflow-only automation tool | deterministic flows, simple task graphs | live agent collaboration, multi-channel runtime surfaces, rich operator chat loops | AgentFlyer keeps workflow orchestration but also supports agent turns, sessions, and runtime control surfaces |
| Tool runner with LLM on top | executing commands or API calls | durable operator-facing system shape, memory, delivery surfaces | AgentFlyer treats tools as one layer inside a broader runtime, not the whole product |
| Custom internal bot per channel | channel-specific convenience | duplicated logic, fragmented state, weak shared operations | AgentFlyer centralizes runtime logic and lets channels stay thin |

## What AgentFlyer is optimized for

- agents as long-lived runtime participants
- workflows as operational processes
- memory and deliverables as durable assets
- CLI and Console UI as first-class operator surfaces
- tool access with clearer boundaries
- a future path from one host to many hosts

## What it is not optimized for

- the smallest possible toy demo
- a single bot with no runtime state
- purely deterministic workflow automation with no conversational runtime
- “just attach some tools to chat” use cases that do not need operators or durable process state

## Choose AgentFlyer when...

- you need more than one agent role
- workflows should be inspectable and schedulable
- outputs should become deliverables
- operators need approvals, recovery, and runtime visibility
- channel entry points should share one runtime core
- tool access needs policy and execution boundaries

## Use a smaller stack when...

- one assistant is enough
- no one needs a control plane
- there is no scheduler, workflow, or deliverable concept
- the runtime does not need to grow beyond one narrow interaction loop

## Bottom line

AgentFlyer becomes more valuable as the work becomes more operational. If the system needs coordination, memory, control, and delivery together, it is in the right category. If the task is tiny and disposable, it is probably too much runtime.

## Related pages

- [Use Cases](./use-cases)
- [FAQ](./faq)
- [Roadmap](./roadmap)