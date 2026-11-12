# =============================================================================
# rabbitmq-bootstrap — one-shot tool image that applies the declarative RabbitMQ
# topology (shared-plane/messaging/src/topology.ts) through the management API.
# Build context: repository root.
# =============================================================================

# --- 1. Install all dependencies and compile -----------------------------------
FROM node:24-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY shared-plane/kernel/package.json shared-plane/kernel/
COPY shared-plane/observability/package.json shared-plane/observability/
COPY shared-plane/identity/package.json shared-plane/identity/
COPY shared-plane/messaging/package.json shared-plane/messaging/
COPY shared-plane/cache/package.json shared-plane/cache/
RUN npm ci --no-audit --no-fund
COPY shared-plane/kernel shared-plane/kernel
COPY shared-plane/observability shared-plane/observability
COPY shared-plane/messaging shared-plane/messaging
RUN npx tsc -b shared-plane/messaging

# --- 2. Runtime: production dependencies of the messaging workspace only -------
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY package.json package-lock.json ./
COPY shared-plane/kernel/package.json shared-plane/kernel/
COPY shared-plane/observability/package.json shared-plane/observability/
COPY shared-plane/identity/package.json shared-plane/identity/
COPY shared-plane/messaging/package.json shared-plane/messaging/
COPY shared-plane/cache/package.json shared-plane/cache/
RUN npm ci --omit=dev --workspace @medicitas/messaging --no-audit --no-fund && npm cache clean --force
COPY --from=build /repo/shared-plane/kernel/dist shared-plane/kernel/dist
COPY --from=build /repo/shared-plane/observability/dist shared-plane/observability/dist
COPY --from=build /repo/shared-plane/messaging/dist shared-plane/messaging/dist
USER node
CMD ["node", "shared-plane/messaging/dist/bin/bootstrap-broker.js"]
