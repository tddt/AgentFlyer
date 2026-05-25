# Skills And Tools

AgentFlyer separates lightweight behavioral knowledge from executable tool access.

## Skills

Skills are prompt-side runtime assets. They are ideal for:

- reusable instructions
- domain operating procedures
- stable task framing
- small compositional behavior changes

The skill system is built around `SKILL.md` content and on-demand prompt injection.

## Tools

Tool access should be explicit. In AgentFlyer, the main tool paths are:

- built-in runtime capabilities
- MCP servers
- plugin-provided runtime extensions
- sandboxed execution paths where applicable

## Why the split matters

This distinction keeps the runtime easier to reason about:

- skills shape behavior
- tools perform actions

When those concerns stay separate, approvals, audits, and operator control become much clearer.

## Choosing the right extension path

| Need | Use |
|---|---|
| Reusable prompt context | Skills |
| External APIs or tool servers | MCP |
| Installable runtime package | Marketplace plugin |

## Operational guidance

- Keep skills readable and specific.
- Give tools stable names and narrow responsibility.
- Use approval policies when tool access has real-world side effects.
- Prefer MCP or sandboxed execution to invisible shell access.

## Related pages

- [Memory](./memory)
- [Extension Surfaces](../api/plugin-sdk)
- [Plugins Overview](../plugins/overview)