# Agents

Agents are the runtime identities that hold instructions, model references, skills, and collaboration posture.

## What an agent represents

In AgentFlyer, an agent is not just a preset prompt. It is a long-lived runtime participant that can:

- receive direct requests
- own sessions and memory context
- participate in mesh collaboration
- be targeted by workflows and scheduler tasks
- publish outputs into deliverables and channels

## Good agent boundaries

Create a new agent when the responsibility is stable and operationally meaningful.

Examples:

- `main` or `coordinator` for routing and orchestration
- `research` for evidence gathering
- `review` for validation and risk checks
- `publish` for formatting and delivery

Avoid creating separate agents for tiny prompt variations that do not change ownership or workflow shape.

## Common topology

| Role | Use it for |
|---|---|
| Coordinator | Intake, routing, decomposition, and final synthesis |
| Worker | Focused execution on a bounded class of tasks |
| Specialist | Domain-heavy tasks such as code review, analysis, or formatting |

## Agent configuration signals

The most important fields usually are:

- `id` and `name`
- the model reference inherited from `defaults` or overridden locally
- `skills`
- mesh role, capabilities, and visibility
- optional workspace or execution-related settings

## Operational advice

- Keep the number of always-on agents small at first.
- Let workflows handle repeatability; do not overload a single agent with every process concern.
- Use deliverables when outputs need to move from “reply text” to “operational asset”.

## Related pages

- [Configuration](./configuration)
- [Workflows](./workflows)
- [Memory](./memory)