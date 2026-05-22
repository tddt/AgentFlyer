# Publishing Packages

If you want to ship a reusable AgentFlyer extension through npm, package it as a plugin and expose a plugin entry in `package.json`.

## Minimum package metadata

```json
{
  "name": "agentflyer-plugin-example",
  "version": "1.0.0",
  "main": "dist/index.js",
  "keywords": ["agentflyer-plugin"],
  "agentflyer": {
    "plugin": "dist/index.js"
  }
}
```

This is the metadata shape expected by the current plugin CLI workflow.

## Distribution flow

1. Build your package.
2. Publish it to npm.
3. Search and install it through `agentflyer plugin` commands.
4. Add the installed entry point to the runtime `plugins` array.
5. Reload the runtime.

## Example operator flow

```bash
npm publish --access public
agentflyer plugin install agentflyer-plugin-example
agentflyer plugin list
agentflyer reload
```

## Guidance

- Keep one package focused on one extension concern.
- Document configuration and side effects clearly.
- Avoid hiding network or execution behavior behind vague package names.

## Related pages

- [Plugins Overview](./overview)
- [Marketplace](./marketplace)