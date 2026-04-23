# ── Stage 1: build console UI ──────────────────────────────────────────────────
FROM node:22-alpine AS console-builder
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY src/console/package.json ./src/console/
RUN npm install -g pnpm && pnpm install --frozen-lockfile
COPY . .
RUN pnpm console:build

# ── Stage 2: runtime ───────────────────────────────────────────────────────────
FROM oven/bun:1.2-alpine AS runtime
LABEL org.opencontainers.image.title="AgentFlyer Gateway" \
      org.opencontainers.image.description="Decentralized federated AI Agent framework" \
      org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /app

# Copy only production sources
COPY --from=console-builder /build/package.json ./
COPY --from=console-builder /build/pnpm-lock.yaml ./
COPY --from=console-builder /build/pnpm-workspace.yaml ./
COPY --from=console-builder /build/src ./src
COPY --from=console-builder /build/tsconfig.json ./
COPY --from=console-builder /build/tsconfig.build.json ./

RUN bun install --production --frozen-lockfile

# Copy built console assets
COPY --from=console-builder /build/src/console/dist ./src/console/dist

# Data directory (mounted as a volume in production)
RUN mkdir -p /data
ENV AGENTFLYER_DATA_DIR=/data

EXPOSE 19789

# Run as non-root
RUN addgroup -S agentflyer && adduser -S -G agentflyer agentflyer
RUN chown -R agentflyer:agentflyer /app /data
USER agentflyer

ENTRYPOINT ["bun", "run", "src/cli/main.ts"]
CMD ["start", "--data-dir", "/data"]
