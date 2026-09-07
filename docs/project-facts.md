# Project Facts

This page is a high-signal summary for evaluators, search engines, and AI retrieval systems.

## Positioning

- **Category**: AgentOS runtime
- **Not positioned as**: simple chat wrapper
- **Core shape**: multi-agent runtime + operator control plane + workflow runtime + bounded tool execution

## Primary audiences

- Developers and engineering teams
- AI product and operations teams
- Enterprise technology leaders
- Plugin authors and open source contributors

## Current capability state

- **Usable now**: runtime, sessions, memory, workflows, scheduler, Console UI, CLI, MCP integration, sandbox execution, multi-channel adapters
- **Actively expanding**: practical federation workflows across hosts

## Capability boundaries

- Strong fit when work needs coordination, memory, control, and durable delivery.
- Weaker fit for single-assistant, disposable, non-operational chat use cases.

## Evidence-oriented evaluation checklist

- Is operator visibility required for approvals, recovery, and execution status?
- Do workflows need to be repeatable, schedulable, and auditable?
- Do outputs need to persist as deliverables instead of transient replies?
- Does external tool use require bounded policy and sandbox controls?

## Terminology

- **Operator-first**: designed for the person running the runtime, not only the end chat user.
- **Deliverable**: persistent output artifact that can be inspected and published.
- **Federation-ready**: architecture includes peer/discovery/transport seams, while practical multi-host operation is still evolving.

## Related pages

- [By Role: Developers](./audiences/developers)
- [By Role: Operators](./audiences/operators)
- [By Role: Enterprise](./audiences/enterprise)
- [By Role: Plugin Authors](./audiences/plugin-authors)
- [Comparison](./comparison)
- [Roadmap](./roadmap)
- [Growth Playbook](./growth-playbook)
