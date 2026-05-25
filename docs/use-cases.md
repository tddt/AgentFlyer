# Use Cases

AgentFlyer is most useful when the work needs more than a single assistant window. The runtime starts paying off when state, coordination, and operator control all matter at the same time.

## Team AgentOS

Use AgentFlyer when a small team wants one runtime that can host coordinator, analyst, and specialist agents without turning collaboration into manual copy-paste.

Typical shape:

- one intake or coordinator agent
- several specialist agents
- workflow steps for collection, review, and publish
- sessions and deliverables preserved for operator follow-through

## Research, review, publish pipelines

This is a strong fit when the task naturally breaks into stages:

1. gather inputs
2. cross-check or review findings
3. format a final result
4. publish or attach deliverables

The runtime matters here because the process becomes durable and inspectable instead of disappearing into one long prompt.

## Operator-controlled automation

Choose AgentFlyer when the work is automated but still needs humans in the loop.

Examples:

- approval before high-impact tool calls
- recovery from suspended runs
- scheduler-triggered operations with auditability
- controlled publishing to channels or downstream systems

## Multi-channel command center

If different users or teams interact through Web, CLI, and messaging channels, AgentFlyer lets them share the same runtime logic instead of running separate bots per channel.

This is valuable when:

- the same workflow should be reachable from more than one interface
- the operator still needs a control plane above those channels
- state should stay coherent even when entry points differ

## Tool-heavy, bounded execution

AgentFlyer is a good fit when agents need external tools but you do not want unbounded host execution.

That is where MCP, approval policies, and sandbox profiles become part of the product story rather than scattered implementation details.

## Early federated operations

If you expect the runtime to grow across machines or trust boundaries over time, AgentFlyer is already structured with federation-oriented seams instead of assuming everything lives forever on one host.

## When not to use it

Do not reach for AgentFlyer first if all you need is:

- one conversational assistant
- a tiny internal helper with no workflow state
- a very small tool runner with no operator UI or scheduling

Those problems usually want a smaller stack.

## Related pages

- [Comparison](./comparison)
- [Architecture](./guide/architecture)
- [Getting Started](./guide/getting-started)