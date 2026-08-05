# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy only necessary source files (exclude node_modules, .next, dist, etc.)
COPY app ./app
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
COPY instrumentation.ts proxy.ts next.config.ts tsconfig.json postcss.config.mjs ./

# Compile migrations with esbuild (handles aliases)
RUN node scripts/build-migrations.js

# Build the application
RUN npm run build

# Production stage (runtime)
FROM node:24-alpine AS runtime

WORKDIR /app

# Install dumb-init for proper signal handling and pnpm
RUN apk add --no-cache dumb-init && npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install only production dependencies (no dev deps, no optional)
RUN pnpm install --frozen-lockfile --prod --no-optional && \
    pnpm prune --prod && \
    rm -rf /root/.pnpm-store && \
    rm -rf /root/.npm

# Copy built application from builder stage
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/proxy.ts ./proxy.ts

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
CMD ["pnpm", "start"]

# Migration stage - runs migrations only
FROM node:24-alpine AS migrate

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install only production dependencies (no dev deps, no optional)
RUN pnpm install --frozen-lockfile --prod --no-optional && \
    pnpm prune --prod && \
    rm -rf /root/.pnpm-store && \
    rm -rf /root/.npm

# Copy built migrations from builder stage
COPY --from=builder /app/dist ./dist

# Set environment variable to point to compiled migrations
ENV MIGRATIONS_DIR=/app/dist/lib/migrations

# Run migrations
CMD ["node", "dist/migrate.cjs"]
