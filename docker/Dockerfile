# syntax=docker/dockerfile:1-labs
# The labs frontend supplies COPY --parents, which is what lets each stage pull
# in every workspace manifest by glob instead of by a hand-maintained list.

# Must match package.json's "packageManager" field. A bare `npm i -g pnpm`
# installs the latest major, which then tries to self-manage down to the pinned
# version by fetching a @pnpm/exe.<platform> binary it cannot verify against
# this lockfile — so the version is pinned here instead.
ARG PNPM_VERSION=10.33.0
# The build's git commit, baked into every stage's environment so the loggers
# can stamp each row with the exact code that produced it (version 0.1.0+sha).
ARG GIT_COMMIT=unknown

# Build stage
FROM node:24-alpine AS builder
ARG PNPM_VERSION

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@${PNPM_VERSION}

# Manifests first, so the dependency install caches independently of source edits.
# Globbed rather than listed one by one: the explicit list went stale every time
# a workspace package was added, and a missing manifest fails the install with a
# module-not-found much further along, in the Next build.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --parents apps/*/package.json packages/*/package.json ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy workspace source
COPY apps ./apps
COPY packages ./packages

# Compile the migrate CLI and migration files for the migrate stage
RUN node packages/db/scripts/build-migrations.js

# Build the web application
RUN pnpm --filter renkei build

# Web runtime stage
FROM node:24-alpine AS runtime
ARG PNPM_VERSION

WORKDIR /app

# Install dumb-init for proper signal handling and pnpm
RUN apk add --no-cache dumb-init && npm install -g pnpm@${PNPM_VERSION}

# Copy manifests and install only the web app's production dependencies.
# Optionals are NOT stripped here, unlike the worker and migrate stages: Next
# ships its native SWC binary as an optionalDependency, and next.config.ts has
# to be transpiled at startup. Without the binary in the image, `next start`
# downloads it from npm on every boot — slow, and broken on an offline host.
# pnpm's os/cpu fields mean only the matching platform binary is installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --parents apps/*/package.json packages/*/package.json ./
RUN pnpm install --frozen-lockfile --prod --filter renkei... && \
    rm -rf /root/.pnpm-store /root/.npm

# The workspace packages ship TypeScript source (compiled into the build via
# transpilePackages); the workspace links still need the packages present, and
# each one's "main" points into src/.
COPY --parents packages/*/src ./

# Copy built application from builder stage
COPY --from=builder /app/apps/web/.next ./apps/web/.next
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/apps/web/next.config.ts /app/apps/web/tsconfig.json /app/apps/web/proxy.ts ./apps/web/

# The log-shipping key generator, runnable as a one-off container on a target
# machine (no repo checkout there):
#   docker compose -f docker-compose.yaml run --rm --no-deps renkei \
#     pnpm --filter renkei generate:log-ship-keys
COPY --from=builder /app/apps/web/scripts/generate-log-ship-keys.mjs ./apps/web/scripts/

# Create a non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001

# Change ownership of app directory
RUN chown -R nextjs:nodejs /app

# Switch to non-root user
USER nextjs

# Expose port (can be overridden with -e PORT=xxxx)
EXPOSE 3000

# Set environment variables
ARG GIT_COMMIT
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    GIT_COMMIT=${GIT_COMMIT}

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["pnpm", "--filter", "renkei", "start"]

# Worker stage - the long-running queue consumer
FROM node:24-alpine AS worker
ARG PNPM_VERSION

WORKDIR /app

RUN apk add --no-cache dumb-init && npm install -g pnpm@${PNPM_VERSION}

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --parents apps/*/package.json packages/*/package.json ./
RUN pnpm install --frozen-lockfile --prod --no-optional --filter @renkei/worker... && \
    rm -rf /root/.pnpm-store /root/.npm

# The worker runs TypeScript directly through tsx, so it ships source — its own
# and that of every workspace package it imports.
COPY --parents packages/*/src ./
COPY apps/worker/src ./apps/worker/src
COPY apps/worker/tsconfig.json ./apps/worker/

RUN addgroup -g 1001 -S nodejs && \
    adduser -S worker -u 1001 && \
    chown -R worker:nodejs /app
USER worker

ARG GIT_COMMIT
ENV NODE_ENV=production \
    GIT_COMMIT=${GIT_COMMIT}

ENTRYPOINT ["dumb-init", "--"]
CMD ["pnpm", "--filter", "@renkei/worker", "start"]

# The agents worker — its own image so it scales by adding containers
# independently of the interactive worker (RENKEI.md Decision #21 context).
# Same shape as the worker stage: tsx runs TypeScript source directly.
FROM node:24-alpine AS worker-agents
ARG PNPM_VERSION

WORKDIR /app

RUN apk add --no-cache dumb-init && npm install -g pnpm@${PNPM_VERSION}

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --parents apps/*/package.json packages/*/package.json ./
RUN pnpm install --frozen-lockfile --prod --no-optional --filter @renkei/worker-agents... && \
    rm -rf /root/.pnpm-store /root/.npm

COPY --parents packages/*/src ./
COPY apps/worker-agents/src ./apps/worker-agents/src
COPY apps/worker-agents/tsconfig.json ./apps/worker-agents/

RUN addgroup -g 1001 -S nodejs && \
    adduser -S worker -u 1001 && \
    chown -R worker:nodejs /app
USER worker

ARG GIT_COMMIT
ENV NODE_ENV=production \
    GIT_COMMIT=${GIT_COMMIT}

ENTRYPOINT ["dumb-init", "--"]
CMD ["pnpm", "--filter", "@renkei/worker-agents", "start"]

# Migration stage - runs migrations only
FROM node:24-alpine AS migrate
ARG PNPM_VERSION

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@${PNPM_VERSION}

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --parents apps/*/package.json packages/*/package.json ./
RUN pnpm install --frozen-lockfile --prod --no-optional --filter @renkei/db... && \
    rm -rf /root/.pnpm-store /root/.npm

# Copy compiled migrations from builder stage
COPY --from=builder /app/packages/db/dist ./packages/db/dist

# The CJS bundle cannot resolve a script-relative default, so the migrations
# directory is set explicitly (see packages/db/scripts/build-migrations.js).
ENV MIGRATIONS_DIR=/app/packages/db/dist/migrations

# Run migrations
CMD ["node", "packages/db/dist/migrate.cjs"]
