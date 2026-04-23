# Plugin Marketplace

## Browse & Install

```bash
# Search npm for agentflyer plugins
agentflyer plugin search <keyword>

# Install a plugin
agentflyer plugin install agentflyer-plugin-<name>

# List installed plugins
agentflyer plugin list

# Remove a plugin
agentflyer plugin remove agentflyer-plugin-<name>
```

After installing, add the entry point to `agentflyer.json`:

```json
{
  "plugins": [
    "~/.agentflyer/plugins/agentflyer-plugin-name/node_modules/agentflyer-plugin-name/dist/index.js"
  ]
}
```

Then reload: `agentflyer reload`.

## Building & publishing a plugin

See [Writing a Plugin](./writing) for the full guide. Once ready:

```bash
npm publish --access public
```

Tag your package with the `agentflyer-plugin` keyword in `package.json` so it appears in search results.
