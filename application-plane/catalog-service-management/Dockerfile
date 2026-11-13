# =============================================================================
# catalog-service-management — specialties, services, professionals (RF3, RF4).
# Multi-stage image. Build context: repository root (npm workspaces monorepo):
#   docker build -f application-plane/catalog-service-management/Dockerfile .
# Runtime stage: node:24-slim + production dependencies of this workspace only,
# compiled JavaScript only (no TypeScript, no sources, no npm/npx/corepack), non-root.
# =============================================================================

# --- 1. Workspace manifests (shared by the build and production-deps stages) ------
FROM node:24-slim AS manifests
WORKDIR /repo
COPY package.json package-lock.json ./
COPY shared-plane/kernel/package.json shared-plane/kernel/
COPY shared-plane/observability/package.json shared-plane/observability/
COPY shared-plane/identity/package.json shared-plane/identity/
COPY shared-plane/messaging/package.json shared-plane/messaging/
COPY shared-plane/cache/package.json shared-plane/cache/
COPY shared-plane/runtime/package.json shared-plane/runtime/
COPY control-plane/tenant-management/package.json control-plane/tenant-management/
COPY control-plane/onboarding-orchestrator/package.json control-plane/onboarding-orchestrator/
COPY application-plane/user-management/package.json application-plane/user-management/
COPY application-plane/user-management-orchestrator/package.json application-plane/user-management-orchestrator/
COPY application-plane/catalog-service-management/package.json application-plane/catalog-service-management/
COPY application-plane/scheduler-management/package.json application-plane/scheduler-management/
COPY application-plane/appointment-orchestrator/package.json application-plane/appointment-orchestrator/
COPY application-plane/api-gateway/package.json application-plane/api-gateway/

# --- 2. Install every dependency and compile this service and its references -----
FROM manifests AS build
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY shared-plane/kernel shared-plane/kernel
COPY shared-plane/observability shared-plane/observability
COPY shared-plane/identity shared-plane/identity
COPY shared-plane/messaging shared-plane/messaging
COPY shared-plane/runtime shared-plane/runtime
COPY application-plane/catalog-service-management/tsconfig.json application-plane/catalog-service-management/
COPY application-plane/catalog-service-management/src application-plane/catalog-service-management/src
RUN npx tsc -b application-plane/catalog-service-management

# --- 3. Production dependencies of this workspace (and its workspace deps) only -
FROM manifests AS prod-deps
RUN npm ci --omit=dev --ignore-scripts --workspace @medicitas/catalog-service-management --no-audit --no-fund \
 && npm cache clean --force

# --- 4. Runtime ------------------------------------------------------------------
FROM node:24-slim AS runtime
# Package managers are not needed at runtime: remove them from the final image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    SERVICE_PORT=3000
WORKDIR /app
# Root-owned and read-only for the runtime user.
COPY --from=prod-deps /repo ./
COPY --from=build /repo/shared-plane/kernel/dist shared-plane/kernel/dist
COPY --from=build /repo/shared-plane/observability/dist shared-plane/observability/dist
COPY --from=build /repo/shared-plane/identity/dist shared-plane/identity/dist
COPY --from=build /repo/shared-plane/messaging/dist shared-plane/messaging/dist
COPY --from=build /repo/shared-plane/runtime/dist shared-plane/runtime/dist
COPY --from=build /repo/application-plane/catalog-service-management/dist application-plane/catalog-service-management/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.SERVICE_PORT||3000)+'/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "application-plane/catalog-service-management/dist/main.js"]
