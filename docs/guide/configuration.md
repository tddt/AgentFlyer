# Configuration

AgentFlyer uses one primary configuration file that defines the runtime boundary: gateway, models, agents, channels, MCP servers, memory-related behavior, and optional plugin or operator settings.

## Core shape

```jsonc
{
  "gateway": {
    "port": 19789,
    "auth": { "mode": "token", "token": "change-me" }
  },
  "models": {
    "main": {
      "provider": "openai-compat",
      "apiBaseUrl": "https://api.openai.com/v1",
      "apiKey": "${OPENAI_API_KEY}",
      "models": {
        "chat": { "id": "gpt-4.1", "maxTokens": 8192 }
      }
    }
  },
  "defaults": {
    "model": "main/chat"
  },
  "agents": [
    {
      "id": "main",
      "name": "Main Agent",
      "skills": ["base"],
      "mesh": {
        "role": "coordinator",
        "capabilities": ["general"],
        "visibility": "public"
      }
    }
  ],
  "channels": {
    "web": { "enabled": true },
    "cli": { "enabled": true }
  }
}
```

## What each section controls

| Section | Purpose |
|---|---|
| `gateway` | Bind port, auth mode, and operator-facing runtime entry |
| `models` | Provider definitions and named model groups |
| `defaults` | Runtime defaults such as the model reference used by agents |
| `agents` | Agent identities, skills, mesh role, workspace, and behavior settings |
| `channels` | Which delivery surfaces are enabled for this runtime |
| `mcp` | External MCP server configuration and tool exposure |
| `users` | Optional role-based API users for viewer, operator, and admin access |
| `plugins` | Marketplace-installed plugin entry points |

## Recommended configuration workflow

1. Use `agentflyer config path` to locate the live file.
2. Edit the file directly or use `agentflyer config set` for top-level changes.
3. Run `agentflyer config validate` before restart or reload.
4. Run `agentflyer config doctor` if the runtime fails to start cleanly.

## Validation and diagnostics

```bash
agentflyer config show
agentflyer config validate
agentflyer config doctor
agentflyer reload
```

`config doctor` is especially useful because it checks schema validity, model credential presence, agent model references, workspace paths, and gateway port availability.

## Roles and API access

When you define `users`, AgentFlyer can enforce different permissions for operator and viewer workflows:

```jsonc
{
  "users": [
    { "id": "alice", "role": "admin", "apiKey": "secret-admin" },
    { "id": "ops", "role": "operator", "apiKey": "secret-ops" },
    { "id": "monitor", "role": "viewer", "apiKey": "secret-viewer" }
  ]
}
```

Use this when the Console UI, RPC layer, or channel integrations should not all share one root token.

## Design advice

### Start with one model group

Keep the first runtime small: one model group, one default agent, one or two channels.

### Split agents by role, not by whim

Create new agents when they have a stable responsibility such as coordinator, researcher, reviewer, or publisher. Do not create a new agent for every prompt variation.

### Keep tools explicit

If an agent needs to touch external systems, define that boundary through MCP, built-in tools, or plugins instead of burying it inside free-form prompts.

### Use reload for config iteration

AgentFlyer supports iterative operator workflows better when configuration changes are validated and reloaded in controlled steps instead of being edited blind.

## Related guides

- [Agents](./agents)
- [Skills And Tools](./skills)
- [Channels](./channels)
- [Federation](./federation)
