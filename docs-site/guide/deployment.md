# Deployment

AgentFlyer can start as a local operator runtime and later move into a containerized or managed environment without changing its core operating model.

## Local single-host deployment

This is the fastest way to run the system for internal operations, prototyping, or a small team.

```bash
agentflyer start
agentflyer status
```

Recommended setup:

- Keep the runtime bound to loopback unless you intentionally expose it.
- Put credentials in environment variables or an external secret store.
- Keep your configuration under source control if it contains only non-secret structure.
- Store secrets separately from the committed config template.

## Source deployment

Useful when you want direct control of the codebase, UI assets, or integration changes.

```bash
pnpm install
pnpm build
pnpm start
```

For active development:

```bash
pnpm dev:start
pnpm console:build
```

## Container deployment

The repository already includes container-related assets, which makes Docker-based rollout a natural next step when local process management stops being enough.

Typical goals for a container deployment:

- stable runtime startup
- explicit mounted config and data directories
- clean separation of image, config, and secrets
- predictable reverse-proxy ingress in front of the gateway

## Helm and cluster-oriented rollout

The repo includes a chart path under `charts/agentflyer`, which is the natural place to package a Kubernetes deployment when AgentFlyer becomes a shared internal control plane.

Use a chart-backed deployment when you need:

- managed persistent storage for runtime data
- secret injection through cluster primitives
- ingress and TLS management
- replicated operational tooling around the runtime

## Production checklist

- Use strong bearer tokens and move ongoing access toward explicit `users` roles.
- Terminate TLS in a reverse proxy or ingress layer.
- Keep model credentials out of plain committed config.
- Monitor process health, agent backlog, workflow failures, and MCP connectivity.
- Treat sandbox and tool policies as deployment-time controls, not just developer conveniences.

## Suggested progression

1. Local runtime on one machine.
2. Reverse-proxied internal service with persistent data.
3. Containerized deployment with externalized secrets.
4. Cluster-managed rollout when the runtime becomes shared infrastructure.

## Related guides

- [Architecture](./architecture)
- [Configuration](./configuration)
- [Federation](./federation)
