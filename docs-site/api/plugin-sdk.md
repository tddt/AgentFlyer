# Extension Surfaces

AgentFlyer is extensible in more than one way. The right surface depends on what you are trying to extend.

## Choose the right seam

| Goal | Best fit |
|---|---|
| Inject domain knowledge into prompts | Skills |
| Expose external tools or services | MCP servers |
| Add runtime hooks or installable packages | Marketplace plugins |
| Add a delivery surface | Channel adapter work in the core runtime |

## Skills

Skills are the lightest-weight extension path. They are ideal when you want to shape agent behavior, prompt context, or reusable operator instructions without introducing a new execution runtime.

Use skills when you need:

- domain-specific prompting
- reusable operating procedures
- lightweight behavioral composition

## MCP servers

MCP is the right fit when AgentFlyer should call tools that live outside the core process. MCP keeps tool execution explicit and makes approval-aware operator flows easier to reason about.

Use MCP when you need:

- external APIs or local service bridges
- tool catalogs with explicit naming and descriptions
- stronger separation between model reasoning and tool execution

## Marketplace plugins

Plugins are installable npm packages managed through the AgentFlyer CLI:

```bash
agentflyer plugin search <keyword>
agentflyer plugin install <name>
agentflyer plugin list
agentflyer plugin remove <name>
```

The current CLI expects plugin packages to expose an `agentflyer.plugin` entry in `package.json`, and installed packages are tracked in the runtime data directory.

Minimal package metadata:

```json
{
  "name": "agentflyer-plugin-example",
  "version": "1.0.0",
  "main": "dist/index.js",
  "agentflyer": {
    "plugin": "dist/index.js"
  }
}
```

## Practical recommendation

Start with the smallest seam that solves the problem:

1. Use a skill if the change is mostly behavioral.
2. Use MCP if the change is mostly about external tools.
3. Use a plugin package when the runtime needs an installable extension artifact.

## Related pages

- [Skills And Tools](../guide/skills)
- [Plugins Overview](../plugins/overview)
- [Publishing Packages](../plugins/writing)
