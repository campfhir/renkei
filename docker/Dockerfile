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
# pnpm-workspace.yaml declares patchedDependencies; without the patch files
# themselves every install below fails against the frozen lockfile. Each
# stage that runs pnpm install copies patches/ alongside the manifests.
COPY patches ./patches
COPY --parents apps/*/package.json packages/*/package.json ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy workspace source
COPY apps ./apps
COPY packages ./packages

# Belt and braces with .dockerignore's `**/.next`.
#
# A production build writes into apps/web/.next WITHOUT clearing it, so
# anything already there survives — and a developer's tree holds ~1GB of
# Turbopack dev output under .next/dev. That went into the builder here and
# then into the runtime image via `COPY --from=builder .../.next`, which is
# how the image quietly grew by a gigabyte of files that never serve a
# request. The ignore rule is the real fix; this line means a regression in
# that file costs a slow build instead of a broken image.
RUN rm -rf apps/web/.next

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
COPY patches ./patches
COPY --parents apps/*/package.json packages/*/package.json ./
# next declares @playwright/test as an OPTIONAL peer dependency (its opt-in
# experimental/testmode/playwright integration, which nothing here uses —
# next's own server bootstrap never imports it). Because apps/web also
# carries @playwright/test as a real devDependency (for the e2e/ screenshot
# rig), pnpm's peer auto-install satisfies that optional peer from it and
# bakes the resolution into next's locked identity in pnpm-lock.yaml — so
# `--prod` no longer excludes it: installing "next" now means installing
# whatever peer-resolved variant is locked, dev split or not. The three
# playwright packages that drags in (playwright, playwright-core,
# @playwright/test — trace viewer, recorder, AI agent skill files, no
# browser binaries) are dead weight in a production image; strip them
# after install rather than fight pnpm's peer resolution.
RUN pnpm install --frozen-lockfile --prod --filter renkei... && \
    rm -rf /root/.pnpm-store /root/.npm && \
    rm -rf node_modules/.pnpm/playwright@* node_modules/.pnpm/playwright-core@* \
      node_modules/.pnpm/@playwright+test@* \
      node_modules/.pnpm/node_modules/playwright node_modules/.pnpm/node_modules/playwright-core \
      node_modules/.pnpm/node_modules/@playwright

# The workspace packages ship TypeScript source (compiled into the build via
# transpilePackages); the workspace links still need the packages present, and
# each one's "main" points into src/.
COPY --parents packages/*/src ./

# Create the non-root user BEFORE anything it needs to own.
#
# Ordering matters more than it looks. `RUN chown -R nextjs:nodejs /app` at
# the end of the stage rewrote the metadata of every file above it, and in
# overlayfs a metadata change copies the file into a new layer — so that one
# line duplicated the whole application and weighed 697MB on its own, more
# than a third of the image. `COPY --chown` sets ownership as the bytes are
# written and costs nothing.
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001

# Copy built application from builder stage
COPY --chown=nextjs:nodejs --from=builder /app/apps/web/.next ./apps/web/.next
COPY --chown=nextjs:nodejs --from=builder /app/apps/web/public ./apps/web/public
COPY --chown=nextjs:nodejs --from=builder /app/apps/web/next.config.ts /app/apps/web/tsconfig.json /app/apps/web/proxy.ts ./apps/web/

# The log-shipping key generator, runnable as a one-off container on a target
# machine (no repo checkout there):
#   docker compose -f docker-compose.yaml run --rm --no-deps renkei \
#     pnpm --filter renkei generate:log-ship-keys
COPY --chown=nextjs:nodejs --from=builder /app/apps/web/scripts/generate-log-ship-keys.mjs ./apps/web/scripts/

# node_modules and the workspace sources stay root-owned and world-readable.
# The app only ever READS them, and a running service that cannot rewrite its
# own dependencies is the better arrangement anyway. Only the directories Next
# writes to at runtime need to belong to the user.
RUN mkdir -p /app/apps/web/.next/cache && \
    chown -R nextjs:nodejs /app/apps/web/.next/cache

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

# Worker stage - every long-running queue consumer, one image. The
# queue-consuming processes (interactive events, embeddings, agent runs,
# batch jobs) are compose services over this single image with different
# commands — the embeddings precedent, extended when apps/worker-agents
# arrived and again for batch-jobs-worker. That is why BOTH worker apps are
# installed and copied here: the agents worker is a separate app (its own
# deps and entry point), not a second script in apps/worker — batch-jobs,
# by contrast, IS a second script in apps/worker (start:batch-jobs),
# because it shares apps/worker's queue/handler plumbing directly. The
# file-share worker is NOT here: it ships as its own image (the
# `fileshares` stage below), so this image never carries the SMB/SSH
# protocol stack and the fileshare container never carries the agents' deps.
FROM node:24-alpine AS worker
ARG PNPM_VERSION

WORKDIR /app

RUN apk add --no-cache dumb-init && npm install -g pnpm@${PNPM_VERSION}

# Created before anything it owns — a trailing `chown -R /app` rewrites every
# file's metadata, and overlayfs copies each one into a new layer. See the
# runtime stage above for what that cost there.
RUN addgroup -g 1001 -S nodejs && \
    adduser -S worker -u 1001

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY --parents apps/*/package.json packages/*/package.json ./
RUN pnpm install --frozen-lockfile --prod --no-optional \
      --filter @renkei/worker... --filter @renkei/worker-agents... && \
    rm -rf /root/.pnpm-store /root/.npm

# The workers run TypeScript directly through tsx, so they ship source —
# their own and that of every workspace package they import. Owned by the
# runtime user at copy time; node_modules stays root-owned and readable,
# which is all a worker needs of it.
COPY --chown=worker:nodejs --parents packages/*/src ./
COPY --chown=worker:nodejs apps/worker/src ./apps/worker/src
COPY --chown=worker:nodejs apps/worker/tsconfig.json ./apps/worker/
COPY --chown=worker:nodejs apps/worker-agents/src ./apps/worker-agents/src
COPY --chown=worker:nodejs apps/worker-agents/tsconfig.json ./apps/worker-agents/

USER worker

ARG GIT_COMMIT
ENV NODE_ENV=production \
    GIT_COMMIT=${GIT_COMMIT}

ENTRYPOINT ["dumb-init", "--"]
CMD ["pnpm", "--filter", "@renkei/worker", "start"]

# Fileshares stage - the file-share I/O service, its own image on purpose:
# it is the only process that opens SMB/SFTP sessions or decrypts share
# credentials, so its container carries exactly the protocol stack (the
# patched @tryjsky/v9u-smb2 among it) and nothing of the queue workers' LLM
# and connector dependencies — and it rolls out independently of them.
FROM node:24-alpine AS fileshares
ARG PNPM_VERSION

WORKDIR /app

RUN apk add --no-cache dumb-init && npm install -g pnpm@${PNPM_VERSION}

# Created before anything it owns — see the runtime stage for why a trailing
# chown -R would double the image.
RUN addgroup -g 1001 -S nodejs && \
    adduser -S worker -u 1001

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY --parents apps/*/package.json packages/*/package.json ./
RUN pnpm install --frozen-lockfile --prod --no-optional \
      --filter @renkei/worker-fileshares... && \
    rm -rf /root/.pnpm-store /root/.npm

# tsx runs TypeScript source directly; workspace links need the package
# sources present (only the filtered deps' node_modules were installed).
COPY --chown=worker:nodejs --parents packages/*/src ./
COPY --chown=worker:nodejs apps/worker-fileshares/src ./apps/worker-fileshares/src
COPY --chown=worker:nodejs apps/worker-fileshares/tsconfig.json ./apps/worker-fileshares/

USER worker

ARG GIT_COMMIT
ENV NODE_ENV=production \
    GIT_COMMIT=${GIT_COMMIT}

EXPOSE 8090

# The service's own unauthenticated liveness endpoint (everything else on
# the port requires the bearer key).
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.FILESHARES_WORKER_PORT || 8090) + '/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

ENTRYPOINT ["dumb-init", "--"]
CMD ["pnpm", "--filter", "@renkei/worker-fileshares", "start"]

# OnBase stage - the OnBase egress service, its own image on purpose: it
# is the only process that dials a customer's on-prem OnBase API Server or
# Hyland IdP (the web app's SSRF guard refuses private hosts by design),
# and it rolls out independently of the queue workers.
FROM node:24-alpine AS onbase
ARG PNPM_VERSION

WORKDIR /app

RUN apk add --no-cache dumb-init && npm install -g pnpm@${PNPM_VERSION}

# Created before anything it owns — see the runtime stage for why a trailing
# chown -R would double the image.
RUN addgroup -g 1001 -S nodejs && \
    adduser -S worker -u 1001

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY --parents apps/*/package.json packages/*/package.json ./
RUN pnpm install --frozen-lockfile --prod --no-optional \
      --filter @renkei/worker-onbase... && \
    rm -rf /root/.pnpm-store /root/.npm

# tsx runs TypeScript source directly; workspace links need the package
# sources present (only the filtered deps' node_modules were installed).
COPY --chown=worker:nodejs --parents packages/*/src ./
COPY --chown=worker:nodejs apps/worker-onbase/src ./apps/worker-onbase/src
COPY --chown=worker:nodejs apps/worker-onbase/tsconfig.json ./apps/worker-onbase/

USER worker

ARG GIT_COMMIT
ENV NODE_ENV=production \
    GIT_COMMIT=${GIT_COMMIT}

EXPOSE 8091

# The service's own unauthenticated liveness endpoint (everything else on
# the port requires the bearer key).
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.ONBASE_WORKER_PORT || 8091) + '/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

ENTRYPOINT ["dumb-init", "--"]
CMD ["pnpm", "--filter", "@renkei/worker-onbase", "start"]

# Sandbox stage - the agent scratch-space worker, its own image on purpose:
# it is the first process that holds staged file bytes at rest, so it gets
# the same isolation as the fileshares/onbase workers — its own container,
# no published ports, and it rolls out independently of the queue workers.
FROM node:24-alpine AS sandbox
ARG PNPM_VERSION

WORKDIR /app

RUN apk add --no-cache dumb-init && npm install -g pnpm@${PNPM_VERSION}

# Created before anything it owns — see the runtime stage for why a trailing
# chown -R would double the image.
RUN addgroup -g 1001 -S nodejs && \
    adduser -S worker -u 1001

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY --parents apps/*/package.json packages/*/package.json ./
RUN pnpm install --frozen-lockfile --prod --no-optional \
      --filter @renkei/worker-sandbox... && \
    rm -rf /root/.pnpm-store /root/.npm

# tsx runs TypeScript source directly; workspace links need the package
# sources present (only the filtered deps' node_modules were installed).
COPY --chown=worker:nodejs --parents packages/*/src ./
COPY --chown=worker:nodejs apps/worker-sandbox/src ./apps/worker-sandbox/src
COPY --chown=worker:nodejs apps/worker-sandbox/tsconfig.json ./apps/worker-sandbox/

# The scratch disk itself — a dedicated volume mounts here in compose so the
# staged bytes survive a container restart but stay off every other image.
RUN mkdir -p /data && chown worker:nodejs /data

USER worker

ARG GIT_COMMIT
ENV NODE_ENV=production \
    GIT_COMMIT=${GIT_COMMIT} \
    SANDBOX_DATA_DIR=/data

EXPOSE 8092

# The service's own unauthenticated liveness endpoint (everything else on
# the port requires the bearer key).
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.SANDBOX_WORKER_PORT || 8092) + '/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

ENTRYPOINT ["dumb-init", "--"]
CMD ["pnpm", "--filter", "@renkei/worker-sandbox", "start"]

# Migration stage - runs migrations only
FROM node:24-alpine AS migrate
ARG PNPM_VERSION

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@${PNPM_VERSION}

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
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
