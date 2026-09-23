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
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

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
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.FILESHARES_WORKER_PORT || 8090) + '/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

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
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.ONBASE_WORKER_PORT || 8091) + '/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

ENTRYPOINT ["dumb-init", "--"]
CMD ["pnpm", "--filter", "@renkei/worker-onbase", "start"]

# Mirth stage - the Mirth Connect egress service, its own image on purpose:
# it is the only process that dials an organization's Mirth Connect servers
# (typically on a private network the web app's SSRF guard refuses by
# design) or decrypts a person's stored Mirth credential, and it rolls out
# independently of the queue workers.
FROM node:24-alpine AS mirth
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
      --filter @renkei/worker-mirth... && \
    rm -rf /root/.pnpm-store /root/.npm

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
CMD ["pnpm", "--filter", "@renkei/worker-mirth", "start"]

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
FROM node:24-bookworm-slim AS sandbox
ARG PNPM_VERSION

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      dumb-init ca-certificates util-linux \
      git ripgrep openssh-client \
      python3 python3-venv python3-pip \
      build-essential pkg-config \
      jq curl unzip zip less procps && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g pnpm@${PNPM_VERSION} && \
    setpriv --version >/dev/null

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
ARG SQL_LANGUAGE_SERVER_VERSION=1.7.1
ARG GO_VERSION=1.27.1
ARG GOPLS_VERSION=v0.23.0
ARG RUST_TOOLCHAIN=stable
ARG JDTLS_VERSION=1.50.0

# TypeScript/JavaScript, Python and SQL: Node-based, beside the worker's own Node.
RUN npm install -g \
      typescript-language-server@${TS_LANGUAGE_SERVER_VERSION} \
      typescript@${TYPESCRIPT_VERSION} \
      pyright@${PYRIGHT_VERSION} \
      sql-language-server@${SQL_LANGUAGE_SERVER_VERSION} && \
    rm -rf /root/.npm && \
    typescript-language-server --version && pyright --version

# C and C++: Debian's clangd. R: Debian's R with the languageserver package
# from CRAN, its heavier dependencies from Debian so nothing compiles ICU.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      clangd \
      r-base-core r-cran-jsonlite r-cran-r6 r-cran-callr r-cran-collections \
      r-cran-fs r-cran-lintr r-cran-repr r-cran-roxygen2 r-cran-stringi \
      r-cran-styler r-cran-xml2 r-cran-xmlparsedata && \
    rm -rf /var/lib/apt/lists/* && \
    R --slave -e 'install.packages("languageserver", repos = "https://cloud.r-project.org", quiet = TRUE); stopifnot(requireNamespace("languageserver"))' && \
    clangd --version

# Go and gopls: the toolchain under /usr/local/go (on every caller's PATH),
# gopls built with it into /usr/local/bin; the build caches go with the layer.
RUN ARCH="$(dpkg --print-architecture)" && \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" | tar -C /usr/local -xz && \
    GOPATH=/tmp/gopath GOCACHE=/tmp/gocache GOBIN=/usr/local/bin GOFLAGS=-mod=mod \
      /usr/local/go/bin/go install golang.org/x/tools/gopls@${GOPLS_VERSION} && \
    rm -rf /tmp/gopath /tmp/gocache && \
    /usr/local/go/bin/go version && gopls version

# Rust and rust-analyzer: rustup's toolchain under /usr/local/rustup, shared
# read-only (workspaces.ts sets RUSTUP_HOME to it and CARGO_HOME under each
# caller's HOME), its proxies in /usr/local/cargo/bin on every caller's PATH.
RUN curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh && \
    RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo \
      sh /tmp/rustup-init.sh -y --no-modify-path --profile minimal \
        --default-toolchain "${RUST_TOOLCHAIN}" --component rust-analyzer --component rust-src && \
    rm /tmp/rustup-init.sh && \
    chmod -R a+rX /usr/local/rustup /usr/local/cargo && \
    RUSTUP_HOME=/usr/local/rustup /usr/local/cargo/bin/rust-analyzer --version

# Java: Eclipse JDT Language Server on a Temurin JDK 21 (jdtls needs 21;
# Debian bookworm ships 17). The launcher, `jdtls`, is a Python script
# that copies its configuration under the caller's cache when the
# install is read-only, as it is here.
RUN ARCH="$(dpkg --print-architecture)" && \
    case "$ARCH" in amd64) JDK_ARCH=x64 ;; arm64) JDK_ARCH=aarch64 ;; *) JDK_ARCH="$ARCH" ;; esac && \
    mkdir -p /usr/local/java /usr/local/jdtls && \
    curl -fsSL "https://api.adoptium.net/v3/binary/latest/21/ga/linux/${JDK_ARCH}/jdk/hotspot/normal/eclipse" \
      | tar -C /usr/local/java --strip-components=1 -xz && \
    JDTLS_FILE="$(curl -fsSL "https://download.eclipse.org/jdtls/milestones/${JDTLS_VERSION}/latest.txt" | tr -d '[:space:]')" && \
    curl -fsSL "https://download.eclipse.org/jdtls/milestones/${JDTLS_VERSION}/${JDTLS_FILE}" \
      | tar -C /usr/local/jdtls -xz && \
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
RUN mkdir -p /data /workspaces && chown worker:nodejs /data && chmod 711 /workspaces

# No `USER worker` here, unlike every other stage: the entrypoint decides.
# Without SANDBOX_WORKSPACES_ENABLED it drops to `worker` before the
# process starts, exactly as before; with it the worker stays root so each
# caller's commands can be dropped to their own uid (see the script).
COPY docker/sandbox-entrypoint.sh /usr/local/bin/sandbox-entrypoint
RUN chmod 755 /usr/local/bin/sandbox-entrypoint

ARG GIT_COMMIT
ENV NODE_ENV=production \
    GIT_COMMIT=${GIT_COMMIT} \
    SANDBOX_DATA_DIR=/data \
    SANDBOX_WORKSPACES_DIR=/workspaces \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 8092

# The service's own unauthenticated liveness endpoint (everything else on
# the port requires the bearer key).
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.SANDBOX_WORKER_PORT || 8092) + '/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

ENTRYPOINT ["dumb-init", "--", "sandbox-entrypoint"]
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
