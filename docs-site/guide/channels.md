# Channels

Channels are the runtime entry and exit paths for people, bots, and systems.

## Current channel surfaces

AgentFlyer currently exposes these major paths:

- Web
- CLI
- Telegram
- Discord
- Feishu
- QQ

## Why channel support matters

The goal is not just to add more chat UIs. Channel support matters because the same runtime can serve different operator and end-user contexts without duplicating agent logic.

## Web surface

The Web surface is the most complete operator-facing path:

- Console UI
- RPC endpoint
- streaming chat over SSE
- WebSocket chat support
- OpenAI-compatible surface for integration scenarios

See [Events](../api/events) for the stream-oriented endpoints.

## Channel design principle

Channels should stay thin. Routing, memory, workflow state, tool access, and deliverables belong in the runtime, not inside one channel-specific implementation.

That is how AgentFlyer keeps the runtime coherent even when the same work shows up through different front doors.

## Operational guidance

- Start with Web and CLI.
- Add messaging channels only when they serve a real operator or delivery need.
- Keep channel-specific formatting small and let the runtime own the real process logic.

## Related pages

- [Architecture](./architecture)
- [Workflows](./workflows)
- [Federation](./federation)