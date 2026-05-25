# Plugins Overview

Plugins are the installable package layer in AgentFlyer's extensibility story.

## Where plugins fit

AgentFlyer has three main ways to extend the runtime:

- skills for behavior
- MCP for tools
- plugins for installable runtime packages

Plugins matter when an operator should be able to discover, install, and manage an extension through the CLI instead of modifying the core codebase directly.

## Good plugin use cases

- shared runtime hooks distributed through npm
- reusable integrations packaged for multiple deployments
- optional runtime behavior that should stay outside the main repository

## Operator workflow

```bash
agentflyer plugin search <keyword>
agentflyer plugin install <name>
agentflyer plugin list
agentflyer plugin remove <name>
```

Installed plugin packages are recorded in the runtime data directory and can then be activated through the `plugins` array in configuration.

## Design advice

- Keep plugins narrow and composable.
- Publish them as explicit packages instead of ad hoc copied files.
- Prefer MCP when the extension is mostly external tool execution rather than runtime behavior.

## Related pages

- [Extension Surfaces](../api/plugin-sdk)
- [Publishing Packages](./writing)
- [Marketplace](./marketplace)