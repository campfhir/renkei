# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Manifests first, so the dependency install caches independently of source edits
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/db/package.json ./packages/db/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy workspace source
COPY apps ./apps
COPY packages ./packages

# Compile the migrate CLI and migration files for the migrate stage
RUN node packages/db/scripts/build-migrations.js

# Build the web application
RUN pnpm --filter @renkei/web build

# Web runtime stage
FROM node:24-alpine AS runtime

WORKDIR /app

# Install dumb-init for proper signal handling and pnpm
RUN apk add --no-cache dumb-init && npm install -g pnpm

# Copy manifests and install only the web app's production dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/db/package.json ./packages/db/
RUN pnpm install --frozen-lockfile --prod --no-optional --filter @renkei/web... && \
    rm -rf /root/.pnpm-store /root/.npm

# @renkei/db ships TypeScript source (compiled into the build via
# transpilePackages); the workspace link still needs the package present.
COPY --from=builder /app/packages/db/src ./packages/db/src

# Copy built application from builder stage
COPY --from=builder /app/apps/web/.next ./apps/web/.next
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/apps/web/next.config.ts /app/apps/web/tsconfig.json /app/apps/web/proxy.ts ./apps/web/

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
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["pnpm", "--filter", "@renkei/web", "start"]

# Worker stage - the long-running queue consumer
FROM node:24-alpine AS worker

WORKDIR /app

RUN apk add --no-cache dumb-init && npm install -g pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/db/package.json ./packages/db/
RUN pnpm install --frozen-lockfile --prod --no-optional --filter @renkei/worker... && \
    rm -rf /root/.pnpm-store /root/.npm

# The worker runs TypeScript directly through tsx, so it ships source.
COPY --from=builder /app/packages/db/src ./packages/db/src
COPY --from=builder /app/apps/worker/src ./apps/worker/src
COPY --from=builder /app/apps/worker/tsconfig.json ./apps/worker/

RUN addgroup -g 1001 -S nodejs && \
    adduser -S worker -u 1001 && \
    chown -R worker:nodejs /app
USER worker

ENV NODE_ENV=production

ENTRYPOINT ["dumb-init", "--"]
CMD ["pnpm", "--filter", "@renkei/worker", "start"]

# Migration stage - runs migrations only
FROM node:24-alpine AS migrate

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json ./packages/db/
RUN pnpm install --frozen-lockfile --prod --no-optional --filter @renkei/db... && \
    rm -rf /root/.pnpm-store /root/.npm

# Copy compiled migrations from builder stage
COPY --from=builder /app/packages/db/dist ./packages/db/dist

# The CJS bundle cannot resolve a script-relative default, so the migrations
# directory is set explicitly (see packages/db/scripts/build-migrations.js).
ENV MIGRATIONS_DIR=/app/packages/db/dist/migrations

# Run migrations
CMD ["node", "packages/db/dist/migrate.cjs"]
