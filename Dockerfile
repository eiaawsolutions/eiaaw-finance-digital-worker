# =============================================================================
# EIAAW Finance Digital Worker — multi-stage build
#
# One image, three entrypoints (api | worker | console), selected at runtime by
# the Railway service's start command. Keeping them in one image guarantees the
# API and the workflow worker always run the same PLATFORM_VERSION, which the
# decision record and evidence bundle both reference (DWD-06 s.3.10, s.3.13).
# =============================================================================

# ---- deps -------------------------------------------------------------------
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/ ./packages/
COPY apps/ ./apps/

# Fetch into the store first so a lockfile-only change does not invalidate
# the whole dependency layer.
RUN pnpm install --frozen-lockfile --prefer-offline


# ---- build ------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json tsconfig.build.json tsconfig.dev.json ./
COPY scripts/ ./scripts/
COPY test/ ./test/

RUN pnpm build


# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
# COREPACK_HOME is set before `prepare` so the pnpm tarball lands in a shared
# location rather than root's home. Without this the unprivileged `worker` user
# finds an empty cache and corepack re-downloads pnpm from the network on every
# container start — a startup dependency on npmjs.org that a deploy should not
# have.
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate && chmod -R a+rX /opt/corepack

# Non-root. The connector runtime sandboxes outbound calls, but the process
# itself should never hold more than it needs.
RUN addgroup -S worker && adduser -S worker -G worker

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build --chown=worker:worker /app/node_modules ./node_modules
COPY --from=build --chown=worker:worker /app/packages ./packages
COPY --from=build --chown=worker:worker /app/apps ./apps
COPY --from=build --chown=worker:worker /app/package.json ./package.json
COPY --from=build --chown=worker:worker /app/pnpm-workspace.yaml ./pnpm-workspace.yaml

# The migrate service runs the migration and seed CLIs through tsx, from source.
# That is deliberate: it means the migration path exercised in development is
# byte-for-byte the one that runs in production, rather than a second compiled
# entrypoint that only ever runs where it cannot be observed. tsx needs these
# two configs to resolve workspace packages.
COPY --from=build --chown=worker:worker /app/tsconfig.base.json ./tsconfig.base.json
COPY --from=build --chown=worker:worker /app/tsconfig.dev.json ./tsconfig.dev.json

USER worker
EXPOSE 3000

# Overridden per Railway service:
#   api      → node apps/api/dist/main.js
#   worker   → node apps/worker/dist/main.js
#   console  → pnpm --filter @eiaaw/console start
CMD ["node", "apps/api/dist/main.js"]
