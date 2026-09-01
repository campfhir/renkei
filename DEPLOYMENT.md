# Deployment Guide

This guide covers deploying the Jira MCP Gateway to production.

## Prerequisites

- Node.js 18+ (recommended: 20.x)
- PostgreSQL 12+
- Atlassian OAuth app (for authentication)
- OIDC provider (Atlassian, Auth0, Okta, etc.)
- TLS certificate (HTTPS required for OAuth)

## Environment Setup

Create a `.env.local` file with production values:

```bash
# OAuth / OIDC Configuration
ATLASSIAN_CLIENT_ID=<your-client-id>
ATLASSIAN_CLIENT_SECRET=<your-client-secret>
ATLASSIAN_REDIRECT_URI=https://yourdomain.com/api/oauth/callback

# Encryption
# Generate with: openssl rand -base64 32
TOKEN_ENCRYPTION_KEY=<32-byte-base64-key>

# Database
DATABASE_URL=postgresql://user:password@postgres.example.com:5432/jira_mcp_db

# Server
PUBLIC_BASE_URL=https://yourdomain.com
NODE_ENV=production
```

### Generating Encryption Key

```bash
openssl rand -base64 32
# Output: zAq/TjlJxVVBkYO9H/NNfaJtfxhuQIXG69BfIWWX9ao=
```

## Database Setup

### Create PostgreSQL Database

```bash
createdb jira_mcp_db
createuser jira_mcp --createdb --pwprompt
psql jira_mcp_db -c "ALTER USER jira_mcp WITH PASSWORD '<secure-password>';"
```

### Run Migrations

Migrations are Kysely migrations under `lib/migrations`, applied in order and
recorded in the `kysely_migration` table. Never create these tables by hand:
the schema has changed several times — columns renamed, values re-encoded — and
a hand-built schema is not recorded in the ledger, so the migrations that would
bring it forward either re-run against tables that already exist or are skipped
on a table that is missing a column the code expects.

From a checkout:

```bash
pnpm tsx scripts/migrate.ts
```

From the published images, on a target machine:

```bash
docker compose -f docker-compose.yaml run --rm migrate
```

Run this **before** starting the gateway on every upgrade. The migrate service is
deliberately kept out of `docker compose up`, so starting the app never applies
migrations as a side effect — which means nothing applies them for you.

The app reports the mismatch rather than assuming it away. On startup it logs
every pending migration at error level, and `GET /api/health` answers 503 with
their names while any are outstanding:

```json
{
  "status": "degraded",
  "reason": "database schema is behind this build",
  "pendingMigrations": ["012-hash-client-secrets"],
  "action": "docker compose -f docker-compose.yaml run --rm migrate"
}
```

That is worth gating a deploy on. Skipping the step otherwise surfaces much
later and much further from the cause — a build expecting
`oauth_clients.client_secret_hash` against a database that still has
`client_secret` fails every MCP client registration with a 500, and the reason
appears only as a Postgres `42703 undefined_column` in the container log.

## Building for Production

```bash
# Install dependencies
pnpm install

# Build the application
npm run build

# Verify build
ls -la .next/
```

## Worker Processes and Queues

The queue consumer ships as **two processes off the same `renkei-worker`
image**, one per queue (RENKEI.md Decision #20; queues live behind
`@renkei/queue`, whose Postgres adapter carries them today and could be
swapped for RabbitMQ/Kafka without touching producers or consumers):

- `worker` — consumes the `events` queue: WebEx replies, webhook
  orchestration, Graph/Zoom fetches, periodic sweeps. Entrypoint:
  `pnpm --filter @renkei/worker start`.
- `embeddings-worker` — consumes the `embedding_jobs` queue: every
  ingest-time call to the org-configured embeddings endpoint (chunk
  ingestion, index deletes and purges, related-items back-fill).
  Entrypoint: `pnpm --filter @renkei/worker start:embeddings`.
- `worker-fileshares` — not a queue consumer but an internal HTTP service,
  and not on the shared worker image: it ships as its **own image**
  (`renkei-fileshares`, the `fileshares` target in `docker/Dockerfile`,
  opt-in prompts in `scripts/docker-build.sh` / `docker-push.sh`). It is
  the only process that opens SMB/SFTP sessions or decrypts file-share
  credentials, so its container carries exactly the protocol stack and
  none of the queue workers' dependencies — and it rolls out without
  restarting them. The web app reaches it at `FILESHARES_WORKER_URL`
  (compose wires `http://renkei-worker-fileshares:8090`) presenting the
  shared bearer key `FILESHARES_WORKER_API_KEY` — set both in `.env`
  (`openssl rand -base64 32` makes a good key; the worker also honors
  `FILESHARES_WORKER_PORT`, default 8090). Without them the file-share
  connector answers "service not configured" everywhere — closed, never
  open. Entrypoint: `pnpm --filter @renkei/worker-fileshares start`.
- `worker-onbase` — the same shape for Hyland OnBase: an internal HTTP
  service on its **own image** (`renkei-onbase`, the `onbase` target in
  `docker/Dockerfile`, opt-in prompts in the build/push scripts). It is
  the only process that dials a customer's on-prem OnBase API Server or
  Hyland IdP — hosts the web app's SSRF guard refuses by design — doing
  OIDC discovery, the PKCE token exchange, refresh, and all Document API
  calls. The web app reaches it at `ONBASE_WORKER_URL` (compose wires
  `http://renkei-worker-onbase:8091`) presenting the shared bearer key
  `ONBASE_WORKER_API_KEY` — set both in `.env` (the worker also honors
  `ONBASE_WORKER_PORT`, default 8091). Without them the OnBase connector
  answers "worker not configured" everywhere — closed, never open.
  Entrypoint: `pnpm --filter @renkei/worker-onbase start`.
- `worker-sandbox` — the same shape again, for the agent scratch space: an
  internal HTTP service on its **own image** (`renkei-sandbox`, the
  `sandbox` target in `docker/Dockerfile`, opt-in prompts in the build/push
  scripts). It is the only process that writes staged file bytes to disk —
  the first place Renkei deliberately holds file bytes at rest outside a
  provider or a browser (`docs/sandbox-connector-design.md`) — so it gets
  its own named volume (`renkei-sandbox-data` / `sandbox_data`), mounted at
  `SANDBOX_DATA_DIR` (default `/data`) and nowhere else. The web app
  reaches it at `SANDBOX_WORKER_URL` (compose wires
  `http://renkei-worker-sandbox:8092`) presenting the shared bearer key
  `SANDBOX_WORKER_API_KEY` — set both in `.env` (`openssl rand -base64 32`
  makes a good key; the worker also honors `SANDBOX_WORKER_PORT`, default
  8092). Without them the `sandbox_*` tools simply don't register — closed,
  never open, same as the other two. Staged files expire on a fixed TTL and
  a per-caller quota regardless of whether anything ever deletes them
  explicitly. Entrypoint: `pnpm --filter @renkei/worker-sandbox start`.

**Horizontal scale:** either process may run as N instances. Claims take
row locks (`FOR UPDATE SKIP LOCKED`), and messages sharing an ordering key
(one mailbox's index writes, one subscription's delta rounds, one room's
messages) are delivered strictly in order, one at a time, across all
instances — distinct keys drain in parallel. With docker compose, drop the
hardcoded `container_name` and use `--scale embeddings-worker=N`.

**Dead letters:** each queue pairs with a `*_dead_letters` table
(`events_dead_letters`, `embedding_jobs_dead_letters`). A message that
spends its retry budget (5 deliveries, exponential backoff) MOVES there
with its last error. Reprocess after fixing the underlying fault via
`@renkei/queue`'s `deadLetters.requeue(ids)` (fresh attempt budget,
original order restored), or inspect/purge with `list`/`purge`.

Both services are declared in `docker-compose.yaml`. Deploy them together
with migration 030 (`embedding_jobs` + dead-letter tables): the migration
must run first, and both worker containers must restart on the new image
in the same rollout — jobs enqueued by new code into `embedding_jobs` are
only consumed by the new embeddings worker.

## Deployment Options

### Option 1: Vercel (Recommended)

Vercel is the easiest way to deploy Next.js:

```bash
npm install -g vercel

# Deploy
vercel --prod

# Set environment variables in Vercel UI or via CLI
vercel env add ATLASSIAN_CLIENT_ID
vercel env add ATLASSIAN_CLIENT_SECRET
vercel env add TOKEN_ENCRYPTION_KEY
vercel env add DATABASE_URL
vercel env add PUBLIC_BASE_URL
```

### Option 2: Self-Hosted on Linux/Docker

**Docker Setup:**

```dockerfile
# Dockerfile
FROM node:20-alpine
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile

COPY . .
RUN npm run build

EXPOSE 3000
ENV NODE_ENV=production
CMD ["npm", "start"]
```

**Build and Run:**

```bash
docker build -t jira-mcp-gateway .

docker run \
  -e ATLASSIAN_CLIENT_ID="<value>" \
  -e ATLASSIAN_CLIENT_SECRET="<value>" \
  -e TOKEN_ENCRYPTION_KEY="<value>" \
  -e DATABASE_URL="postgresql://..." \
  -e PUBLIC_BASE_URL="https://yourdomain.com" \
  -p 3000:3000 \
  jira-mcp-gateway
```

**Docker Compose:**

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: jira_mcp
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: jira_mcp_db
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - '5432:5432'

  app:
    build: .
    environment:
      DATABASE_URL: postgresql://jira_mcp:${DB_PASSWORD}@postgres:5432/jira_mcp_db
      ATLASSIAN_CLIENT_ID: ${ATLASSIAN_CLIENT_ID}
      ATLASSIAN_CLIENT_SECRET: ${ATLASSIAN_CLIENT_SECRET}
      TOKEN_ENCRYPTION_KEY: ${TOKEN_ENCRYPTION_KEY}
      PUBLIC_BASE_URL: https://yourdomain.com
      NODE_ENV: production
    ports:
      - '3000:3000'
    depends_on:
      - postgres

volumes:
  postgres_data:
```

### Option 3: Traditional Server (Ubuntu)

**Install Dependencies:**

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install pnpm
npm install -g pnpm

# Install PostgreSQL
sudo apt install -y postgresql postgresql-contrib
```

**Setup Application:**

```bash
# Create app directory
sudo mkdir -p /opt/jira-mcp-gateway
sudo chown ubuntu:ubuntu /opt/jira-mcp-gateway
cd /opt/jira-mcp-gateway

# Clone repository
git clone <repo-url> .

# Install dependencies
pnpm install --frozen-lockfile

# Build
npm run build

# Create .env file
nano .env.local
```

**Systemd Service:**

```ini
# /etc/systemd/system/jira-mcp-gateway.service
[Unit]
Description=Jira MCP Gateway
After=network.target postgresql.service

[Service]
Type=simple
User=app-user
WorkingDirectory=/opt/jira-mcp-gateway
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10

# Environment variables
EnvironmentFile=/opt/jira-mcp-gateway/.env.local

[Install]
WantedBy=multi-user.target
```

**Start Service:**

```bash
sudo systemctl daemon-reload
sudo systemctl enable jira-mcp-gateway
sudo systemctl start jira-mcp-gateway
sudo systemctl status jira-mcp-gateway
```

## Nginx Reverse Proxy

```nginx
upstream jira_mcp {
  server 127.0.0.1:3000;
}

# Keep-alive must survive ordinary requests: only actual WebSocket upgrades
# should send `Connection: upgrade`, everything else keeps its connection.
map $http_upgrade $connection_upgrade {
  default upgrade;
  '' close;
}

server {
  listen 80;
  server_name yourdomain.com;
  return 301 https://$server_name$request_uri;
}

server {
  listen 443 ssl http2;
  server_name yourdomain.com;

  ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

  # SSL configuration
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_ciphers HIGH:!aNULL:!MD5;
  ssl_prefer_server_ciphers on;

  # /api/upload/{slotId} receives RAW file bytes (the out-of-band upload
  # endpoint the *_request_*_upload tools mint) — the default 20 MB
  # attachment cap needs headroom here. Without this, nginx's 1 MB default
  # rejects any real file with an HTML 413.
  client_max_body_size 32m;
  client_body_timeout 60s;

  # Security headers
  add_header Strict-Transport-Security "max-age=31536000" always;
  add_header X-Frame-Options DENY;
  add_header X-Content-Type-Options nosniff;

  location / {
    proxy_pass http://jira_mcp;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
    # Match the app's upload timeout (120s): large multipart uploads to
    # Jira/Graph legitimately take minutes on slow links. The app aborts
    # its own upstream calls at 15s (reads) / 120s (uploads), so nginx
    # should never be the layer that gives up first.
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
    # Optional for very large uploads: stream the body to the app instead
    # of buffering it to disk first.
    # proxy_request_buffering off;
  }
}
```

### The out-of-band upload endpoint

File uploads never travel inside a tool call. A `*_request_*_upload` tool
(`jira_request_attachment_upload`, `jsm_request_attachment_upload`,
`confluence_request_attachment_upload`, `onedrive_request_document_upload`,
`sharepoint_request_document_upload`,
`outlook_request_draft_attachment_upload`) mints a single-use slot that
expires in 15 minutes, and the client sends the RAW bytes to
`POST /api/upload/{slotId}` with the opaque bearer token in the
`Authorization` header — from a shell via `curl --data-binary`, or through
the browser page `GET /api/upload/{slotId}` serves (the token rides the URL
fragment, so it never appears in server logs). Only the SHA-256 of the token
is stored; the claim is atomic, so a token works exactly once.
`check_file_upload` reports the outcome. `PUBLIC_BASE_URL` must be set (or
the request's origin is used) for the minted URLs to be reachable.

### Troubleshooting: uploads fail or tool calls "hang"

- A tool call that stalls at EVERY file size, while small probes answer
  instantly, is almost never the server: it is the LLM client generating
  file content as base64 tool-call output tokens (a 1 MB file is hundreds of
  thousands of output tokens — the request never finishes streaming, and the
  server never sees it). That is why the base64 upload tools were removed;
  point the model at the `*_request_*_upload` flow instead.
- A 413 from `POST /api/upload/{slotId}` before the size limit you expect:
  check `client_max_body_size` (nginx's default is 1 MB).
- Check `proxy_read_timeout`/`proxy_send_timeout` cover the app's upload
  budget (120s).
- A 410 from the upload endpoint means the slot expired (15 minutes), was
  already used, or the token is wrong — mint a fresh one.
- The app itself aborts stalled upstream calls at 15s (reads) / 120s
  (uploads) and reports a timeout error — if a request to the app still
  never returns, the layer eating it is in front of the app.

## SSL/TLS with Let's Encrypt

```bash
sudo apt install -y certbot python3-certbot-nginx

sudo certbot certonly --standalone -d yourdomain.com

# Auto-renewal
sudo systemctl enable certbot.timer
sudo systemctl start certbot.timer
```

## Monitoring

### Health Check

```bash
curl https://yourdomain.com/api/health
# Expected: {"status":"ok"}
```

### Logs

View application logs:

```bash
# Systemd
sudo journalctl -u jira-mcp-gateway -f

# Docker
docker logs <container-id> -f
```

### Database Backups

```bash
# Daily backup script
#!/bin/bash
pg_dump -U jira_mcp jira_mcp_db | gzip > /backups/jira_mcp_$(date +%Y%m%d).sql.gz

# Keep last 30 days
find /backups -name "jira_mcp_*.sql.gz" -mtime +30 -delete
```

## Security Checklist

- [x] HTTPS enabled (TLS 1.2+)
- [x] Environment variables set (no secrets in code)
- [x] Database password strong (16+ characters, mixed case, symbols)
- [x] Regular database backups
- [x] PostgreSQL firewall rules (only app can connect)
- [x] Failed login attempts logged
- [x] Rate limiting configured (nginx or app-level)
- [x] Security headers configured (X-Frame-Options, etc.)
- [x] CORS configured properly
- [x] SQL injection prevention (using Kysely ORM)
- [x] CSRF protection (state verification in OAuth)
- [x] XSS protection (React escaping, no dangerouslySetInnerHTML)

## Troubleshooting

### Database Connection Failed

```bash
# Test connection
psql postgresql://user:pass@host:5432/db

# Check PostgreSQL is running
sudo systemctl status postgresql

# Verify firewall rules
sudo ufw status
```

### OAuth Redirect URI Mismatch

Error: "Redirect URI mismatch"

**Solution:** Ensure `PUBLIC_BASE_URL` matches OAuth app configuration exactly:

- App setting: `https://yourdomain.com`
- `ATLASSIAN_REDIRECT_URI`: `https://yourdomain.com/api/oauth/callback`
- `PUBLIC_BASE_URL`: `https://yourdomain.com`

### Token Encryption Errors

Error: "TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key"

**Solution:** Regenerate the key:

```bash
openssl rand -base64 32
```

### High Memory Usage

If Node.js is using too much memory:

```bash
# Increase Node.js memory limit
export NODE_OPTIONS="--max-old-space-size=1024"

# Or in systemd service
EnvironmentFile=/opt/jira-mcp-gateway/.env.local
Environment="NODE_OPTIONS=--max-old-space-size=1024"
```

## Performance Optimization

### Database Connection Pooling

Already configured in `lib/db.ts` using node-postgres pool.

### Caching

Consider implementing:

- Redis for session caching
- CDN for static assets
- Jira API response caching (with TTL)

### Monitoring Query Performance

```sql
-- Enable query logging
SET log_statement = 'all';

-- View slow queries
SELECT * FROM pg_stat_statements ORDER BY mean_time DESC LIMIT 10;
```

## Version Upgrades

### Next.js Upgrades

```bash
npm update next
npm run build
npm start
```

### Node.js LTS Updates

- Current LTS: Node 20.x
- Next LTS: Node 22.x (April 2024)

Test thoroughly before upgrading production.

## Support

For issues:

1. Check logs: `journalctl -u jira-mcp-gateway -n 50`
2. Verify config: `echo $DATABASE_URL` (never commit .env files)
3. Test connectivity: `curl -v https://yourdomain.com/api/health`
4. Check database: `psql $DATABASE_URL -c "\dt"`
