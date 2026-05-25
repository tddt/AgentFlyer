# Events And Streaming

AgentFlyer exposes several stream-friendly surfaces for chat and integration scenarios.

## Primary endpoints

| Endpoint | Purpose |
|---|---|
| `POST /chat` | Server-sent events stream for agent replies |
| `GET /ws/chat` | WebSocket upgrade path for chat clients |
| `GET /v1/models` | OpenAI-compatible model listing surface |
| `POST /v1/chat/completions` | OpenAI-compatible chat completions surface |

## `POST /chat`

This is the main SSE endpoint.

Request body shape:

```json
{
  "agentId": "main",
  "message": "Summarize today's inbound requests"
}
```

Response:

- `Content-Type: text/event-stream`
- each event is sent as JSON under `data:`
- the stream ends with `data: [DONE]`

## Stream event types

The `/chat` stream carries both runtime lifecycle events and model/tool chunks.

| Type | Meaning |
|---|---|
| `queued` | The run entered the per-agent queue |
| `started` | The run began execution or resumed |
| `text_delta` | Incremental model text |
| `thinking_delta` | Incremental reasoning text when supported |
| `tool_use_start` | A tool call started |
| `tool_use_delta` | Tool input JSON is streaming in |
| `tool_result` | A tool returned output |
| `progress` | Runtime progress message |
| `error` | Terminal or actionable stream error |
| `done` | Final token and stop metadata |

## Example chunks

```json
{ "type": "queued", "position": 2, "runId": "01ABC..." }
```

```json
{ "type": "started", "queueDepth": 0, "runId": "01ABC..." }
```

```json
{ "type": "text_delta", "text": "Here is the summary...", "runId": "01ABC..." }
```

```json
{ "type": "tool_use_delta", "id": "tool_1", "name": "search", "inputJson": "{\"query\":\"pricing\"}", "runId": "01ABC..." }
```

```json
{ "type": "done", "inputTokens": 812, "outputTokens": 233, "stopReason": "end_turn", "runId": "01ABC..." }
```

## WebSocket chat

When a client needs a persistent upgraded connection, AgentFlyer handles upgrades at `/ws/chat`.

## Operator recommendation

- Use RPC for structured automation.
- Use SSE when a human or browser client should watch the turn unfold.
- Use WebSocket when the client benefits from a persistent full-duplex session.