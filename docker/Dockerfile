# syntax=docker/dockerfile:1-labs
# The labs frontend supplies COPY --parents, which is what lets each stage pull
# in every workspace manifest by glob instead of by a hand-maintained list.

# Must match package.json's "packageManager" field. A bare `npm i -g pnpm`
# installs the latest major, which then tries to self-manage down to the pinned
# version by fetching a @pnpm/exe.<platform> binary it cannot verify against
# this lockfile — so the version is pinned here instead.
ARG PNPM_VERSION=10.34.6
# The build's git commit, baked into every stage's environment so the loggers
# can stamp each row with the exact code that produced it (version 0.1.0+sha),
# and the app's version (apps/web/package.json), which the web app shows
# beside it — read from the environment now that no package manager's
# lifecycle variables surround the process (scripts/docker-build.sh and the
# CI workflow pass both).
ARG GIT_COMMIT=unknown
ARG APP_VERSION=dev

# Base images are pinned by digest as well as tag: the tag says what the
# image is, the digest says exactly which build of it, so an upstream
# re-tag changes nothing here until someone chooses it. Dependabot (docker
# ecosystem, .github/dependabot.yml) proposes the new digest when the tag
# moves. Every stage also upgrades the distribution's packages at build
# time (`apk upgrade`, `apt-get upgrade`), so a fix the distribution has
# shipped since the base image was built is in the image — the CI image
# scan fails on a fixable HIGH/CRITICAL, and the base image lags its
# distribution by days.
#   docker.io/library/node:24-alpine         (every Node-only stage)
#   docker.io/library/node:24-bookworm-slim  (the sandbox: Chromium and the
#                                             toolchains need glibc)
#
# The images ship no package manager. npm (bundled with Node, with its own
# vendored tar, undici and brace-expansion) and the pnpm that installs the
# dependencies are build-time tools: every final stage removes them once
# the install is done and starts its process with `node` directly, from
# the app's own directory (the working directory pnpm would have given
# it). The scan then sees the application's dependencies and the runtime,
# nothing a running service never calls. The sandbox is the one exception
# for pnpm: a code workspace's own commands may want a package manager, so
# the pinned pnpm stays on its PATH; npm goes there too.

# Build stage
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder
ARG PNPM_VERSION

WORKDIR /app

# Install pnpm
RUN apk upgrade --no-cache && npm install -g pnpm@${PNPM_VERSION}

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
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
ARG PNPM_VERSION

WORKDIR /app

# Install dumb-init for proper signal handling and pnpm
RUN apk upgrade --no-cache && apk add --no-cache dumb-init && npm install -g pnpm@${PNPM_VERSION}

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
      node_modules/.pnpm/node_modules/@playwright && \
    rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx

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
# `next start` transpiles next.config.ts at boot and resolves its imports
# from disk, so every module the config pulls in has to be here too. Today
# that is the security-header rules (one file, no imports of its own); a
# config import that is missing here fails the container at start with
# "Failed to load next.config.ts … Cannot find module".
COPY --chown=nextjs:nodejs --from=builder /app/apps/web/lib/security-headers.ts ./apps/web/lib/

# The log-shipping key generator, runnable as a one-off container on a target
# machine (no repo checkout there):
#   docker compose -f docker-compose.yaml run --rm --no-deps renkei \
#     node scripts/generate-log-ship-keys.mjs
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
ARG APP_VERSION
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    GIT_COMMIT=${GIT_COMMIT} \
    APP_VERSION=${APP_VERSION}

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application from its own directory, as `pnpm --filter renkei
# start` would have: `next start` reads the project from the working
# directory, and lib/mockups resolves from it.
WORKDIR /app/apps/web
CMD ["node", "node_modules/next/dist/bin/next", "start"]

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
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS worker
ARG PNPM_VERSION

WORKDIR /app

RUN apk upgrade --no-cache && apk add --no-cache dumb-init && npm install -g pnpm@${PNPM_VERSION}

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
    rm -rf /root/.pnpm-store /root/.npm && \
    rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx

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
# tsx runs the TypeScript source directly, from the app's own directory as
# `pnpm --filter @renkei/worker start` did. The other processes off this
# image are compose commands over the same shape: another entry file for
# the embeddings and batch-jobs workers, and apps/worker-agents as the
# working directory for the agents worker (docker-compose.yaml).
WORKDIR /app/apps/worker
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]

# Fileshares stage - the file-share I/O service, its own image on purpose:
# it is the only process that opens SMB/SFTP sessions or decrypts share
# credentials, so its container carries exactly the protocol stack (the
# patched @tryjsky/v9u-smb2 among it) and nothing of the queue workers' LLM
# and connector dependencies — and it rolls out independently of them.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS fileshares
ARG PNPM_VERSION

WORKDIR /app

RUN apk upgrade --no-cache && apk add --no-cache dumb-init && npm install -g pnpm@${PNPM_VERSION}

# Created before anything it owns — see the runtime stage for why a trailing
# chown -R would double the image.
RUN addgroup -g 1001 -S nodejs && \
    adduser -S worker -u 1001

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY --parents apps/*/package.json packages/*/package.json ./
RUN pnpm install --frozen-lockfile --prod --no-optional \
      --filter @renkei/worker-fileshares... && \
    rm -rf /root/.pnpm-store /root/.npm && \
    rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx

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
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.FILESHARES_WORKER_PORT || 8090) + '/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

ENTRYPOINT ["dumb-init", "--"]
WORKDIR /app/apps/worker-fileshares
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]

# OnBase stage - the OnBase egress service, its own image on purpose: it
# is the only process that dials a customer's on-prem OnBase API Server or
# Hyland IdP (the web app's SSRF guard refuses private hosts by design),
# and it rolls out independently of the queue workers.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS onbase
ARG PNPM_VERSION

WORKDIR /app

RUN apk upgrade --no-cache && apk add --no-cache dumb-init && npm install -g pnpm@${PNPM_VERSION}

# Created before anything it owns — see the runtime stage for why a trailing
# chown -R would double the image.
RUN addgroup -g 1001 -S nodejs && \
    adduser -S worker -u 1001

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY --parents apps/*/package.json packages/*/package.json ./
RUN pnpm install --frozen-lockfile --prod --no-optional \
      --filter @renkei/worker-onbase... && \
    rm -rf /root/.pnpm-store /root/.npm && \
    rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx

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
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.ONBASE_WORKER_PORT || 8091) + '/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

ENTRYPOINT ["dumb-init", "--"]
WORKDIR /app/apps/worker-onbase
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]

# Mirth stage - the Mirth Connect egress service, its own image on purpose:
# it is the only process that dials an organization's Mirth Connect servers
# (typically on a private network the web app's SSRF guard refuses by
# design) or decrypts a person's stored Mirth credential, and it rolls out
# independently of the queue workers.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS mirth
ARG PNPM_VERSION

WORKDIR /app

RUN apk upgrade --no-cache && apk add --no-cache dumb-init && npm install -g pnpm@${PNPM_VERSION}

# Created before anything it owns — see the runtime stage for why a trailing
# chown -R would double the image.
RUN addgroup -g 1001 -S nodejs && \
    adduser -S worker -u 1001

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY --parents apps/*/package.json packages/*/package.json ./
RUN pnpm install --frozen-lockfile --prod --no-optional \
      --filter @renkei/worker-mirth... && \
    rm -rf /root/.pnpm-store /root/.npm && \
    rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx

# tsx runs TypeScript source directly; workspace links need the package
# sources present (only the filtered deps' node_modules were installed).
COPY --chown=worker:nodejs --parents packages/*/src ./
COPY --chown=worker:nodejs apps/worker-mirth/src ./apps/worker-mirth/src
COPY --chown=worker:nodejs apps/worker-mirth/tsconfig.json ./apps/worker-mirth/

USER worker

ARG GIT_COMMIT
ENV NODE_ENV=production \
    GIT_COMMIT=${GIT_COMMIT}

EXPOSE 8093

# The service's own unauthenticated liveness endpoint (everything else on
# the port requires the bearer key).
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.MIRTH_WORKER_PORT || 8093) + '/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

ENTRYPOINT ["dumb-init", "--"]
WORKDIR /app/apps/worker-mirth
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]

# Delegate stage - the one process that holds a key
# (docs/delegate-key-design.md): the only container that reads
# USER_KEY_ENCRYPTION_KEY, derives a person's key-encryption key, unwraps a
# chat's or project's data key, or opens a person's sealed values. Its own
# image so that key is set on exactly one service and it rolls out
# independently of the queue workers.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS delegate
ARG PNPM_VERSION

WORKDIR /app

RUN apk upgrade --no-cache && apk add --no-cache dumb-init && npm install -g pnpm@${PNPM_VERSION}

RUN addgroup -g 1001 -S nodejs && \
    adduser -S worker -u 1001

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY --parents apps/*/package.json packages/*/package.json ./
RUN pnpm install --frozen-lockfile --prod --no-optional \
      --filter @renkei/worker-delegate... && \
    rm -rf /root/.pnpm-store /root/.npm && \
    rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx

COPY --chown=worker:nodejs --parents packages/*/src ./
COPY --chown=worker:nodejs apps/worker-delegate/src ./apps/worker-delegate/src
COPY --chown=worker:nodejs apps/worker-delegate/tsconfig.json ./apps/worker-delegate/

USER worker

ARG GIT_COMMIT
ENV NODE_ENV=production \
    GIT_COMMIT=${GIT_COMMIT}

EXPOSE 8096

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.DELEGATE_WORKER_PORT || 8096) + '/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

ENTRYPOINT ["dumb-init", "--"]
WORKDIR /app/apps/worker-delegate
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]

# ADManager stage - the ManageEngine ADManager Plus egress service, its own
# image on purpose: it is the only process that dials an organization's
# ADManager Plus servers (typically on a private network the web app's SSRF
# guard refuses by design) or decrypts a person's stored authtoken, and it
# rolls out independently of the queue workers.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS admanager
ARG PNPM_VERSION

WORKDIR /app

RUN apk upgrade --no-cache && apk add --no-cache dumb-init && npm install -g pnpm@${PNPM_VERSION}

# Created before anything it owns — see the runtime stage for why a trailing
# chown -R would double the image.
RUN addgroup -g 1001 -S nodejs && \
    adduser -S worker -u 1001

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY --parents apps/*/package.json packages/*/package.json ./
RUN pnpm install --frozen-lockfile --prod --no-optional \
      --filter @renkei/worker-admanager... && \
    rm -rf /root/.pnpm-store /root/.npm && \
    rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx

# tsx runs TypeScript source directly; workspace links need the package
# sources present (only the filtered deps' node_modules were installed).
COPY --chown=worker:nodejs --parents packages/*/src ./
COPY --chown=worker:nodejs apps/worker-admanager/src ./apps/worker-admanager/src
COPY --chown=worker:nodejs apps/worker-admanager/tsconfig.json ./apps/worker-admanager/

USER worker

ARG GIT_COMMIT
ENV NODE_ENV=production \
    GIT_COMMIT=${GIT_COMMIT}

EXPOSE 8095

# The service's own unauthenticated liveness endpoint (everything else on
# the port requires the bearer key).
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.ADMANAGER_WORKER_PORT || 8095) + '/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

ENTRYPOINT ["dumb-init", "--"]
WORKDIR /app/apps/worker-admanager
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]

# Sandbox stage - the agent scratch-space worker, its own image on purpose:
# it is the first process that holds staged file bytes at rest, so it gets
# the same isolation as the fileshares/onbase workers — its own container,
# no published ports, and it rolls out independently of the queue workers.
#
# Debian rather than Alpine, unlike the other stages: this image also
# carries the headless Chromium behind the sandbox_browser_* tools
# (apps/worker-sandbox/src/browser.ts), and Playwright's browser builds only
# ship against glibc. `playwright-core install --with-deps` below pulls
# exactly the Chromium headless shell the pinned playwright-core version was
# tested with, plus its system libraries and fonts, into /ms-playwright
# where the unprivileged worker can read it — no distro Chromium of a
# different version, no download at container start.
#
# It also carries a developer's toolchain for the code workspaces behind
# the sandbox_workspace_* tools (apps/worker-sandbox/src/workspaces.ts):
# git for the checkout, ripgrep for search, and the languages and build
# tools a typical repository's own commands expect — Node and pnpm are
# already here; python3 with venv and pip, make and a C toolchain for
# native modules, jq, curl, unzip. util-linux supplies setpriv, which is
# how the worker drops each caller's commands to their own uid (and how
# the entrypoint drops itself when workspaces are off); the build checks
# it is there, because a missing one would show up only as a failed spawn
# on every command a caller runs.
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS sandbox
ARG PNPM_VERSION

WORKDIR /app

RUN apt-get update && \
    apt-get upgrade -y --no-install-recommends && \
    apt-get install -y --no-install-recommends \
      dumb-init ca-certificates util-linux \
      git ripgrep openssh-client \
      python3 python3-venv python3-pip \
      build-essential pkg-config \
      jq curl unzip zip less procps && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g pnpm@${PNPM_VERSION} && \
    setpriv --version >/dev/null

# The interpreter behind sandbox_run_python (apps/worker-sandbox/src/
# scripts.ts): a virtual environment of its own under /opt, apart from
# the system Python the language servers and a workspace's own commands
# use, holding the data libraries a script over a spreadsheet reaches
# for — pandas (with numpy), openpyxl to read and write .xlsx, XlsxWriter
# for a richer write. Pinned, readable and executable by every caller's
# uid (a run is dropped to one), and never written to at run time: a
# script cannot pip install into it — it has no network to install from
# in any case, and pip itself goes, with the setuptools the venv seeded,
# once the libraries are in — so what runs is the script and exactly
# these libraries.
# SANDBOX_PYTHON overrides the path; the worker checks the interpreter
# and lists what it found at boot. pandas 2.3 and numpy 2.3 are the last
# lines with wheels for bookworm's Python 3.11 (pandas 3 and numpy 2.5
# need 3.12); a move to a newer base image lifts both together.
ARG PANDAS_VERSION=2.3.2
ARG NUMPY_VERSION=2.3.5
ARG OPENPYXL_VERSION=3.1.5
ARG XLSXWRITER_VERSION=3.2.9
ARG PYTHON_DATEUTIL_VERSION=2.9.0.post0
RUN python3 -m venv /opt/sandbox-python && \
    /opt/sandbox-python/bin/pip install --no-cache-dir --upgrade pip && \
    /opt/sandbox-python/bin/pip install --no-cache-dir \
      "pandas==${PANDAS_VERSION}" \
      "numpy==${NUMPY_VERSION}" \
      "openpyxl==${OPENPYXL_VERSION}" \
      "XlsxWriter==${XLSXWRITER_VERSION}" \
      "python-dateutil==${PYTHON_DATEUTIL_VERSION}" && \
    /opt/sandbox-python/bin/python3 -m pip uninstall -y pip setuptools && \
    chmod -R a+rX /opt/sandbox-python && \
    /opt/sandbox-python/bin/python3 -I -c "import pandas, numpy, openpyxl, xlsxwriter; print(pandas.__version__)"

# Language servers for the code pane's editor (apps/worker-sandbox/src/
# lsp-sessions.ts; the registry of what each language runs is
# packages/connector-sandbox/src/lsp.ts). Each lands somewhere every
# caller's uid can read and execute, on the PATH a caller's process gets
# (workspaces.ts' SYSTEM_PATH: /usr/local/bin plus /usr/local/go/bin and
# /usr/local/cargo/bin), and writes its own state under the caller's HOME
# at run time, never here. One RUN per toolchain so a failed download
# names its toolchain, and so a version bump rebuilds one layer. The
# worker probes for each at boot and logs which it found; a language
# whose server is missing simply gets the tokenizer alone in the pane.
#
# Sizes are real (Rust and the JDK are the large ones — together these
# layers roughly double the image); an installation that wants a smaller
# sandbox can drop a RUN and lose only that language's server.
ARG TS_LANGUAGE_SERVER_VERSION=6.0.0
ARG TYPESCRIPT_VERSION=5.9.3
ARG PYRIGHT_VERSION=1.1.414
ARG BASH_LANGUAGE_SERVER_VERSION=5.8.1
ARG GO_VERSION=1.27.2
ARG GOPLS_VERSION=v0.23.0
# gopls is built here rather than installed as released: its release pins
# golang.org/x/mod and golang.org/x/text at versions with open advisories
# (sumdb verification bypass, UTF-8 denial of service), so the build
# replaces those two with the versions below. The replacement is a
# `replace`, not a plain upgrade, because the patched x/mod and x/text
# themselves require a newer golang.org/x/tools than the gopls release
# compiles against — so x/tools is pinned to exactly the pseudo-version
# the release's go.mod names. Bump the three together with gopls; drop
# them once a release requires fixed versions itself.
ARG GO_X_TOOLS_VERSION=v0.47.1-0.20260707181000-a299dadba899
ARG GO_X_MOD_VERSION=v0.42.0
ARG GO_X_TEXT_VERSION=v0.43.0
# Exact versions, never `stable`/`latest`, and every download below is
# checked against the checksum its vendor publishes before anything is
# extracted or run — go.dev's .sha256 beside each tarball, rustup's
# .sha256 beside each archived rustup-init, Adoptium's checksum endpoint,
# Eclipse's .sha256 beside each jdtls tarball. A tarball that does not
# match fails the build with sha256sum's own message.
ARG RUSTUP_VERSION=1.29.1
ARG RUST_TOOLCHAIN=1.99.0
ARG TEMURIN_RELEASE=jdk-21.0.12.1+1
ARG JDTLS_VERSION=1.61.0

# TypeScript/JavaScript, Python and shell: Node-based, beside the
# worker's own Node. The shell server lints through shellcheck when it
# finds one, so Debian's is installed with clangd below. No SQL server:
# the one the registry names (sql-language-server, packages/connector-
# sandbox/src/lsp.ts) has no release without critical advisories in its
# dependencies (mysql2 2.x, ssh2 0.8, tar 6), so SQL gets the tokenizer
# alone until it ships one; an installation that wants it anyway can add
# the package here.
RUN npm install -g \
      typescript-language-server@${TS_LANGUAGE_SERVER_VERSION} \
      typescript@${TYPESCRIPT_VERSION} \
      pyright@${PYRIGHT_VERSION} \
      bash-language-server@${BASH_LANGUAGE_SERVER_VERSION} && \
    rm -rf /root/.npm && \
    typescript-language-server --version && pyright --version

# C and C++: Debian's clangd. R: Debian's R with the languageserver package
# from CRAN. Its heavier dependencies (stringi's ICU, xml2, roxygen2,
# lintr) come from Debian so nothing compiles them; the two bookworm does
# not package — styler and collections — install.packages pulls from
# CRAN itself, with styler's own dependencies from Debian below it.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      clangd shellcheck \
      r-base-core r-cran-jsonlite r-cran-r6 r-cran-callr r-cran-fs r-cran-lintr \
      r-cran-repr r-cran-roxygen2 r-cran-stringi r-cran-xml2 r-cran-xmlparsedata \
      r-cran-r.cache r-cran-purrr r-cran-rlang r-cran-cli r-cran-vctrs r-cran-withr \
      r-cran-magrittr r-cran-rprojroot r-cran-digest && \
    rm -rf /var/lib/apt/lists/* && \
    R --slave -e 'install.packages("languageserver", repos = "https://cloud.r-project.org"); stopifnot(requireNamespace("languageserver"))' && \
    clangd --version

# Go and gopls: the toolchain under /usr/local/go (on every caller's PATH),
# gopls built with it into /usr/local/bin; the build caches go with the layer.
RUN ARCH="$(dpkg --print-architecture)" && \
    GO_TGZ="go${GO_VERSION}.linux-${ARCH}.tar.gz" && \
    curl -fsSL -o "/tmp/${GO_TGZ}" "https://dl.google.com/go/${GO_TGZ}" && \
    curl -fsSL -o /tmp/go.sha256 "https://dl.google.com/go/${GO_TGZ}.sha256" && \
    echo "$(cat /tmp/go.sha256)  /tmp/${GO_TGZ}" | sha256sum -c - && \
    tar -C /usr/local -xzf "/tmp/${GO_TGZ}" && rm -f "/tmp/${GO_TGZ}" /tmp/go.sha256 && \
    mkdir -p /tmp/gopls-build && cd /tmp/gopls-build && \
    export GOPATH=/tmp/gopath GOCACHE=/tmp/gocache && \
    printf '//go:build tools\n\npackage tools\n\nimport _ "golang.org/x/tools/gopls"\n' > tools.go && \
    /usr/local/go/bin/go mod init renkei/gopls-build && \
    /usr/local/go/bin/go mod edit -require "golang.org/x/tools/gopls@${GOPLS_VERSION}" \
      -replace "golang.org/x/tools=golang.org/x/tools@${GO_X_TOOLS_VERSION}" \
      -replace "golang.org/x/mod=golang.org/x/mod@${GO_X_MOD_VERSION}" \
      -replace "golang.org/x/text=golang.org/x/text@${GO_X_TEXT_VERSION}" && \
    /usr/local/go/bin/go mod tidy && \
    /usr/local/go/bin/go build -trimpath -o /usr/local/bin/gopls golang.org/x/tools/gopls && \
    cd / && rm -rf /tmp/gopls-build /tmp/gopath /tmp/gocache && \
    /usr/local/go/bin/go version && gopls version

# Rust and rust-analyzer: rustup's toolchain under /usr/local/rustup, shared
# read-only (workspaces.ts sets RUSTUP_HOME to it and CARGO_HOME under each
# caller's HOME), its proxies in /usr/local/cargo/bin on every caller's PATH.
RUN ARCH="$(dpkg --print-architecture)" && \
    case "$ARCH" in amd64) RUST_TRIPLE=x86_64-unknown-linux-gnu ;; arm64) RUST_TRIPLE=aarch64-unknown-linux-gnu ;; *) echo "no rustup build for $ARCH" >&2; exit 1 ;; esac && \
    RUSTUP_BASE="https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${RUST_TRIPLE}" && \
    mkdir -p /tmp/rustup && cd /tmp/rustup && \
    curl -fsSL -o rustup-init "${RUSTUP_BASE}/rustup-init" && \
    curl -fsSL -o rustup-init.sha256 "${RUSTUP_BASE}/rustup-init.sha256" && \
    sha256sum -c rustup-init.sha256 && chmod +x rustup-init && \
    RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo \
      ./rustup-init -y --no-modify-path --profile minimal \
        --default-toolchain "${RUST_TOOLCHAIN}" --component rust-analyzer --component rust-src && \
    cd / && rm -rf /tmp/rustup && \
    chmod -R a+rX /usr/local/rustup /usr/local/cargo && \
    RUSTUP_HOME=/usr/local/rustup /usr/local/cargo/bin/rust-analyzer --version

# Java: Eclipse JDT Language Server on a Temurin JDK 21 (jdtls needs 21;
# Debian bookworm ships 17), the exact release TEMURIN_RELEASE names,
# checked against Adoptium's published checksum; jdtls is the milestone's
# tarball checked against the .sha256 published beside it. The launcher,
# `jdtls`, is a Python script that copies its configuration under the
# caller's cache when the install is read-only, as it is here.
RUN ARCH="$(dpkg --print-architecture)" && \
    case "$ARCH" in amd64) JDK_ARCH=x64 ;; arm64) JDK_ARCH=aarch64 ;; *) JDK_ARCH="$ARCH" ;; esac && \
    mkdir -p /usr/local/java /usr/local/jdtls && \
    TEMURIN_API="https://api.adoptium.net/v3" && \
    TEMURIN_REL="$(printf '%s' "${TEMURIN_RELEASE}" | sed 's/+/%2B/')" && \
    TEMURIN_PATH="${TEMURIN_REL}/linux/${JDK_ARCH}/jdk/hotspot/normal/eclipse" && \
    curl -fsSL -o /tmp/temurin.tgz "${TEMURIN_API}/binary/version/${TEMURIN_PATH}" && \
    curl -fsSL "${TEMURIN_API}/checksum/version/${TEMURIN_PATH}" | awk '{print $1 "  /tmp/temurin.tgz"}' | sha256sum -c - && \
    tar -C /usr/local/java --strip-components=1 -xzf /tmp/temurin.tgz && rm -f /tmp/temurin.tgz && \
    JDTLS_BASE="https://download.eclipse.org/jdtls/milestones/${JDTLS_VERSION}" && \
    JDTLS_FILE="$(curl -fsSL "${JDTLS_BASE}/latest.txt" | tr -d '[:space:]')" && \
    curl -fsSL -o /tmp/jdtls.tgz "${JDTLS_BASE}/${JDTLS_FILE}" && \
    echo "$(curl -fsSL "${JDTLS_BASE}/${JDTLS_FILE}.sha256" | tr -d '[:space:]')  /tmp/jdtls.tgz" | sha256sum -c - && \
    tar -C /usr/local/jdtls -xzf /tmp/jdtls.tgz && rm -f /tmp/jdtls.tgz && \
    ln -s /usr/local/java/bin/java /usr/local/bin/java && \
    ln -s /usr/local/jdtls/bin/jdtls /usr/local/bin/jdtls && \
    chmod -R a+rX /usr/local/java /usr/local/jdtls && \
    java -version && test -x /usr/local/jdtls/bin/jdtls

# Created before anything it owns — see the runtime stage for why a trailing
# chown -R would double the image.
RUN groupadd -g 1001 nodejs && \
    useradd -r -u 1001 -g nodejs -d /app -s /usr/sbin/nologin worker

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY --parents apps/*/package.json packages/*/package.json ./
RUN pnpm install --frozen-lockfile --prod --no-optional \
      --filter @renkei/worker-sandbox... && \
    rm -rf /root/.pnpm-store /root/.npm

# The browser. PLAYWRIGHT_BROWSERS_PATH is set for the runtime too (below),
# so playwright-core resolves the very binary installed here. Headless
# shell only: the full Chromium build is twice the size and headless
# launches never use it.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pnpm --filter @renkei/worker-sandbox exec playwright-core install --with-deps --only-shell chromium && \
    rm -rf /var/lib/apt/lists/* /root/.cache && \
    chmod -R a+rX /ms-playwright

# tsx runs TypeScript source directly; workspace links need the package
# sources present (only the filtered deps' node_modules were installed).
COPY --chown=worker:nodejs --parents packages/*/src ./
COPY --chown=worker:nodejs apps/worker-sandbox/src ./apps/worker-sandbox/src
COPY --chown=worker:nodejs apps/worker-sandbox/tsconfig.json ./apps/worker-sandbox/

# The scratch disk itself — a dedicated volume mounts here in compose so the
# staged bytes survive a container restart but stay off every other image.
# The workspace volume is a second one, apart from it: checkouts belong to
# per-caller uids and must never share a directory with the staged files.
# /runs is a third place, with no volume: a script run's throwaway
# directory (src/scripts.ts) lives there for the run and is removed with
# it, and whatever a crash leaves is removed at the next boot.
RUN mkdir -p /data /workspaces /runs && chown worker:nodejs /data && chmod 711 /workspaces /runs && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# No `USER worker` here, unlike every other stage: the entrypoint keeps the
# worker root so each caller's commands can be dropped to their own uid
# (see the script); SANDBOX_RUN_AS_WORKER=true drops to `worker` before the
# process starts, for a deployment that will never run anyone's commands.
COPY docker/sandbox-entrypoint.sh /usr/local/bin/sandbox-entrypoint
RUN chmod 755 /usr/local/bin/sandbox-entrypoint

ARG GIT_COMMIT
ENV NODE_ENV=production \
    GIT_COMMIT=${GIT_COMMIT} \
    SANDBOX_DATA_DIR=/data \
    SANDBOX_WORKSPACES_DIR=/workspaces \
    SANDBOX_RUNS_DIR=/runs \
    SANDBOX_PYTHON=/opt/sandbox-python/bin/python3 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 8092

# The service's own unauthenticated liveness endpoint (everything else on
# the port requires the bearer key).
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.SANDBOX_WORKER_PORT || 8092) + '/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

ENTRYPOINT ["dumb-init", "--", "sandbox-entrypoint"]
# From the app's own directory, as pnpm would have run it: charts.ts finds
# the Mermaid bundle through this package's dependencies from the working
# directory. npm is gone from this image (its vendored dependencies carry
# open advisories and the worker never calls it); the pinned pnpm stays for
# a workspace's own commands.
WORKDIR /app/apps/worker-sandbox
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]

# Migration stage - runs migrations only
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS migrate
ARG PNPM_VERSION

WORKDIR /app

# Install pnpm
RUN apk upgrade --no-cache && npm install -g pnpm@${PNPM_VERSION}

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY --parents apps/*/package.json packages/*/package.json ./
RUN pnpm install --frozen-lockfile --prod --no-optional --filter @renkei/db... && \
    rm -rf /root/.pnpm-store /root/.npm && \
    rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx

# Copy compiled migrations from builder stage
COPY --from=builder /app/packages/db/dist ./packages/db/dist

# The CJS bundle cannot resolve a script-relative default, so the migrations
# directory is set explicitly (see packages/db/scripts/build-migrations.js).
ENV MIGRATIONS_DIR=/app/packages/db/dist/migrations

# Run migrations
CMD ["node", "packages/db/dist/migrate.cjs"]
