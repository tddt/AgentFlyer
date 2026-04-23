# Configuration

AgentFlyer uses a single JSON file (`agentflyer.json`) that is hot-reload capable — the gateway watches for file changes and only restarts the affected parts (MCP servers or agents) when their config actually changes.

## Minimal example

```json
{
  "gateway": {
    "port": 19789,
    "host": "127.0.0.1",
    "adminToken": "change-me"
  },
  "agents": [
    {
      "id": "assistant",
      "name": "Assistant",
      "llm": {
        "provider": "openai",
        "model": "gpt-4o-mini",
        "apiKey": "${OPENAI_API_KEY}"
      },
      "systemPrompt": "You are a helpful assistant."
    }
  ]
}
```

## Keys

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `gateway.port` | number | `19789` | HTTP port the gateway listens on |
| `gateway.host` | string | `127.0.0.1` | Bind address |
| `gateway.adminToken` | string | — | Admin bearer token (required) |
| `agents` | array | `[]` | Agent definitions |
| `mcp` | object | `{}` | MCP server configurations |
| `users` | array | `[]` | RBAC user definitions |
| `plugins` | array | `[]` | Plugin entry-point paths |
| `log.level` | string | `info` | Log level: `debug` \| `info` \| `warn` \| `error` |

## RBAC users

```json
{
  "users": [
    { "id": "alice", "role": "admin",    "apiKey": "secret-admin" },
    { "id": "bob",   "role": "operator", "apiKey": "secret-bob" },
    { "id": "ci",    "role": "viewer",   "apiKey": "secret-ci" }
  ]
}
```

Roles: `admin` > `operator` > `viewer`.

When `users` is empty, the root `adminToken` is the only authentication method and all methods are allowed.

## Environment variable substitution

Values of the form `${ENV_VAR}` are substituted at load time from `process.env`.

## Hot-reload

```bash
agentflyer reload
# or send SIGHUP to the gateway process
```

Only the MCP registry or agents whose configuration changed are restarted — unchanged agents keep their sessions.
