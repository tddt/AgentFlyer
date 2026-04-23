# Deployment

## Docker Compose

```bash
# Clone the repo or copy docker-compose.yml
docker compose up -d

# Tail logs
docker compose logs -f
```

The compose file mounts a named volume `agentflyer_data` at `/data`. Place your `agentflyer.json` inside that volume or bind-mount it read-only.

## Kubernetes / Helm

```bash
helm install agentflyer ./charts/agentflyer \
  --set env.OPENAI_API_KEY=sk-... \
  --set config.content='{"gateway":{"adminToken":"secret"},"agents":[]}'
```

### Custom values

```yaml
# my-values.yaml
replicaCount: 1

image:
  tag: "0.9.0"

persistence:
  size: 5Gi

ingress:
  enabled: true
  className: nginx
  hosts:
    - host: agents.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: agents-tls
      hosts:
        - agents.example.com
```

```bash
helm install agentflyer ./charts/agentflyer -f my-values.yaml
```

## Production checklist

- Set a strong `adminToken` and rotate it via RBAC user `apiKey` instead
- Use TLS termination at the ingress / reverse-proxy layer
- Mount secrets via Kubernetes Secrets or your vault solution — never hard-code keys in `agentflyer.json`
- Enable structured log shipping (the gateway emits JSON to stdout)
- Scrape `/metrics` with Prometheus; alert on `agentflyer_agent_runs_total{status="error"}`
