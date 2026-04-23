# Plugin SDK

## Overview

Plugins are plain npm packages that export an `AgentFlyerPlugin` object.

```typescript
import type { AgentFlyerPlugin } from 'agentflyer/plugin-sdk';

const plugin: AgentFlyerPlugin = {
  name: 'my-plugin',
  version: '1.0.0',

  // Called once when the gateway loads the plugin
  async setup(ctx) {
    ctx.logger.info('my-plugin loaded');
  },

  // Lifecycle hooks (all optional)
  async onAgentStart({ agentId, config, logger }) {
    logger.info(`Agent ${agentId} starting`);
  },

  async onToolCall(ctx) {
    ctx.logger.debug(`Tool call: ${ctx.toolName}`);
    // Deny the call:
    // ctx.deny('Blocked by policy');
  },

  async onMessageReceive(ctx) {
    // Mutate message in place
    ctx.message.content = ctx.message.content.replace(/badword/gi, '***');
  },
};

export default plugin;
```

## package.json: declare entry point

```json
{
  "name": "agentflyer-plugin-example",
  "version": "1.0.0",
  "agentflyer": {
    "plugin": "dist/index.js",
    "requires": ">=0.9.0"
  },
  "main": "dist/index.js"
}
```

The `agentflyer.requires` field is a semver range checked against the gateway version before loading.

## Installing

```bash
agentflyer plugin install agentflyer-plugin-example
```

This installs the package and records it in `~/.agentflyer/plugins.json`. Then add the `entryPoint` path to `plugins` in `agentflyer.json`.

## API Reference

### `AgentFlyerPlugin`

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Plugin name |
| `version` | `string` | Plugin semver |
| `setup(ctx)` | `async fn` | Called once on load; `ctx.logger` available |
| `onAgentStart(ctx)` | `async fn` | Fires before an agent run starts |
| `onToolCall(ctx)` | `async fn` | Fires for every tool call; call `ctx.deny(reason)` to block |
| `onMessageReceive(ctx)` | `async fn` | Fires on incoming message; mutate `ctx.message` to transform |

### `ToolCallContext`

```typescript
interface ToolCallContext {
  agentId: string;
  toolName: string;
  args: Record<string, unknown>;
  logger: Logger;
  deny(reason: string): void;
}
```
