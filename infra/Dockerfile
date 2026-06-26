FROM node:20-alpine AS base
RUN apk add --no-cache bash git
RUN npm install -g @anthropic-ai/claude-code @openai/codex
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
# Copy all package.json files for workspace resolution
COPY packages/approval/package.json ./packages/approval/
COPY packages/core-types/package.json ./packages/core-types/
COPY packages/daemon-protocol/package.json ./packages/daemon-protocol/
COPY packages/feishu-adapter/package.json ./packages/feishu-adapter/
COPY packages/llm-client/package.json ./packages/llm-client/
COPY packages/memory/package.json ./packages/memory/
COPY packages/observability/package.json ./packages/observability/
COPY packages/orchestrator/package.json ./packages/orchestrator/
COPY packages/queue/package.json ./packages/queue/
COPY packages/registry/package.json ./packages/registry/
COPY packages/runtime-adapters/package.json ./packages/runtime-adapters/
COPY packages/session/package.json ./packages/session/
COPY packages/storage/package.json ./packages/storage/
COPY apps/api/package.json ./apps/api/
COPY apps/daemon/package.json ./apps/daemon/
COPY apps/worker/package.json ./apps/worker/
RUN pnpm install --frozen-lockfile || pnpm install

# Build all packages
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/ ./apps/
COPY soul/ ./soul/
RUN pnpm build

# API production image
FROM base AS api
COPY --from=build /app ./
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]

# Worker production image
FROM base AS worker
COPY --from=build /app ./
# Daemon gateway (pairing REST + daemon WebSocket)
EXPOSE 3001
CMD ["node", "apps/worker/dist/main.js"]
