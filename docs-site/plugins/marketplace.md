# Plugin Marketplace

The plugin marketplace path is built around installable npm packages managed by the AgentFlyer CLI.

## Search, install, list, remove

```bash
agentflyer plugin search <keyword>
agentflyer plugin install <name>
agentflyer plugin list
agentflyer plugin remove <name>
```

The CLI stores plugin installation records in the AgentFlyer data directory and keeps a plugin manifest there so operators can see what is installed.

## Enabling an installed plugin

After install, add the plugin entry point to the `plugins` array in your AgentFlyer config, then reload the runtime.

```jsonc
{
  "plugins": [
    "~/.agentflyer/plugins/agentflyer-plugin-name/node_modules/agentflyer-plugin-name/dist/index.js"
  ]
}
```

```bash
agentflyer reload
```

## When to use marketplace plugins

Choose a plugin package when you want:

- an installable extension artifact that operators can manage with CLI commands
- repeatable deployment of runtime hooks or packaged behaviors
- a distribution path through npm instead of direct repository edits

If you only need prompt composition, use [skills](../guide/skills). If you need external tool execution, prefer MCP first.

## Publishing guidance

See [Publishing Packages](./writing) for package metadata and release guidance.
