# Getting Started

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.2  (or Node.js ≥ 22 with pnpm)
- An OpenAI **or** Anthropic API key

## Installation

### npm / pnpm / bun (global)

```bash
# with pnpm
pnpm add -g agentflyer

# or with npm
npm install -g agentflyer

# or with bun
bun add -g agentflyer
```

### From source

```bash
git clone https://github.com/agentflyer/agentflyer
cd AgentFlyer
pnpm install
pnpm build
```

## Quick start

```bash
# 1 — Initialise a config file in the current directory
agentflyer config init

# 2 — Edit agentflyer.json to add your API key and define an agent

# 3 — Start the gateway (default port 19789)
agentflyer start

# 4 — Open the web console
agentflyer web

# 5 — Chat interactively
agentflyer chat
```

## Docker

```bash
docker run -d \
  -p 19789:19789 \
  -v agentflyer_data:/data \
  -e OPENAI_API_KEY=sk-... \
  agentflyer/agentflyer:latest
```

See [Deployment](./deployment) for Docker Compose and Kubernetes instructions.
