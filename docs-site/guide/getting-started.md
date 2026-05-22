# Getting Started

AgentFlyer is quickest to understand when you launch one model, one agent, and one runtime surface, then grow from there.

## What you need

- Bun 1.2 or newer is recommended.
- Node.js 22 or newer is supported.
- pnpm 9 or newer is recommended for source installs.
- At least one model provider credential.

## Install

### Global package

```bash
npm install -g agentflyer
```

You can also use pnpm or Bun if that matches your machine setup.

### From source

```bash
git clone https://github.com/tddt/AgentFlyer.git
cd AgentFlyer
pnpm install
pnpm build
```

## Create or find your config file

Ask AgentFlyer where it expects the configuration file:

```bash
agentflyer config path
```

Then create or edit that file with a minimal runtime definition:

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
      "apiKey": "sk-...",
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

Validate before starting:

```bash
agentflyer config validate
agentflyer config doctor
```

## Start the runtime

```bash
agentflyer start
```

Then use whichever operator surface fits the task:

- Open the Console UI at `http://localhost:19789`
- Open the browser directly with `agentflyer web`
- Start local chat with `agentflyer chat`
- Send a directed request with `agentflyer message send`

## Useful first commands

```bash
agentflyer status
agentflyer agent list
agentflyer sessions list
agentflyer skills list
agentflyer stats
```

## Development loop

If you are running from source:

```bash
pnpm dev:start
pnpm dev:chat
pnpm typecheck
pnpm check
pnpm test
```

## Next steps

1. Read [Architecture](./architecture) to understand the runtime layers.
2. Read [Configuration](./configuration) to structure models, agents, channels, and tools.
3. Read [Workflows](./workflows) when a task should become repeatable instead of staying inside chat.
4. Read [Deployment](./deployment) when you are ready to run the gateway in a more durable environment.
