# Deployment Guide

This guide covers deploying the Jira MCP Gateway to production.

## Prerequisites

- Node.js 24+ (recommended: 24.x)
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

## Published Images

Every push to `main` that passes CI (lint, typecheck, tests) also builds
and publishes the six images `docker-compose.yaml` pulls — `renkei`,
`renkei-migrate`, `renkei-worker`, `renkei-fileshares`, `renkei-onbase`,
`renkei-sandbox` — to Docker Hub from the `docker` job in
`.github/workflows/ci.yml`. Each image is pushed under two tags: `latest`
and the version in `apps/web/package.json` (the version every app in the
workspace shares, and the same one `scripts/docker-build.sh` stamps). Bump
that version when a release should keep its own tag; until then a new push
to `main` overwrites both tags. Images are built for `linux/amd64`, with
the short commit baked in as `GIT_COMMIT` so log rows name the exact build.
Pull requests never publish.

The job needs two repository secrets (Settings → Secrets and variables →
Actions): `DOCKERHUB_USERNAME`, the Docker Hub account to log in as, and
`DOCKERHUB_TOKEN`, an access token for it with read/write scope. Images go
under that username unless the repository variable `DOCKERHUB_NAMESPACE`
names a different namespace (an organization's, say). Without the secrets
the job fails at its first step and nothing is pushed; the checks job is
unaffected.

`scripts/docker-build.sh` / `docker-push.sh` remain the way to build from a
checkout — for another registry, another platform, or a version the
workflow has not published.

## Worker Processes and Queues

The queue consumer ships as **three processes off the same `renkei-worker`
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
- `worker-batch-jobs` — consumes the `batch_job_messages` queue: one
  message per unit of work in a batch job (document-ocr-pipeline's OCR
  calls today; a future batch kind is a new handler, not a new queue). Item
  work is slow, external, per-item network I/O, the same reasoning that
  moved embedding work off the interactive queue — so it never sits in
  front of a webhook reply either. Reaches `worker-fileshares` and
  `worker-sandbox` directly (`FILESHARES_WORKER_URL`/`SANDBOX_WORKER_URL`
  - their bearer keys, same as the web app uses) to read source documents
    and stage OCR results. Entrypoint: `pnpm --filter @renkei/worker start:batch-jobs`.
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
- `worker-mirth` — the same shape for Mirth Connect (NextGen Connect
  4.5.2): an internal HTTP service on its **own image** (`renkei-mirth`, the
  `mirth` target in `docker/Dockerfile`, opt-in prompts in the build/push
  scripts). It is the only process that dials an organization's Mirth
  servers — as many instances as an operator registers under Organization →
  Mirth Connect (dev, test, prod…), typically on private networks the web
  app's SSRF guard refuses by design — or decrypts a person's stored Mirth
  credential. It logs in as that person, keeps one session per (instance,
  person), and proxies every REST route. The web app reaches it at
  `MIRTH_WORKER_URL` (compose wires `http://renkei-worker-mirth:8093`)
  presenting the shared bearer key `MIRTH_WORKER_API_KEY` — set both in
  `.env` (`openssl rand -base64 32` makes a good key; the worker also honors
  `MIRTH_WORKER_PORT`, default 8093). Without them the Mirth connector
  answers "service not configured" everywhere — closed, never open.
  Entrypoint: `pnpm --filter @renkei/worker-mirth start`.
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
  explicitly. The image also bakes in a headless Chromium for the
  `sandbox_browser_*` tools (agents opening and interacting with web
  pages): set `SANDBOX_BROWSER_ENABLED=true` in `.env` — read by BOTH the
  web app (to register the tools) and this worker (to launch the browser,
  lazily on first use) — to turn it on; unset, the tools don't exist.
  Chromium never gets direct network access: every connection goes through
  the worker's own egress proxy, which refuses private and internal
  addresses, so the browser cannot reach the other compose services.
  `SANDBOX_BROWSER_EXECUTABLE` optionally names a different Chromium
  binary. Memory: a busy browser session runs 300–500MB (at most eight at
  once), so both compose files give this service a 1GB reservation, a
  `SANDBOX_WORKER_MEMORY` limit (default `4g` — raise it in `.env` for a
  deployment that drives many sessions), a 1GB `/dev/shm` (Docker's 64MB
  default is the usual cause of a "page crashed" on a heavy site), a
  negative OOM score so the kernel kills something else first, and a fixed
  1GB Node heap so the worker process itself never pushes the container
  over its limit. If sessions still vanish, the worker log says why:
  "browser process disconnected" is the browser dying, "unhandled
  rejection" / "uncaught exception" is the worker itself. Browser secrets
  (migration 090, the
  `sandbox_secrets` table) need no key of their own in `.env`: each is
  sealed under a passphrase the person holds. An unlocked secret's derived
  key is kept on `/data` for its window, sealed under
  `SANDBOX_ENV_SECRETS_KEY` (else `TOKEN_ENCRYPTION_KEY`) narrowed to its
  owner, so every replica can type it and a restart does not lock it;
  without either key it lives in this worker's memory and a restart locks
  every secret until its owner unlocks it again. **Code projects** (`docs/sandbox-workspaces-design.md`):
  set `SANDBOX_WORKSPACES_ENABLED=true` in `.env` — again read by BOTH the
  web app (the Code section and the `code_*` tools its chats get) and
  this worker — to let people make a code project from one of their
  Bitbucket or GitHub repositories, paste its `.env`, and have the
  project's chats work in it: read, edit, run the project's own
  commands, commit, push.
  **Language servers for the code pane** (`docs/code-editor-design.md`
  § Language servers): the sandbox image also carries a language server
  per common language — TypeScript/JavaScript (typescript-language-server),
  Python (Pyright), Java (Eclipse JDT on a Temurin JDK 21), SQL, C/C++
  (clangd), Go (gopls, with a Go toolchain), Rust (rust-analyzer, with a
  Rust toolchain), R and shell (bash-language-server with shellcheck) —
  which the worker starts on demand inside a
  project's checkout, as the project's own uid, when someone opens a
  file of that language in the pane; the browser's Monaco is the client,
  relayed through the web app (`…/code/projects/[id]/lsp`). Nothing to
  configure: the worker probes its PATH at boot and logs which servers
  it found, and a language whose server is missing gets syntax colouring
  alone. The toolchains are the bulk of the image (Rust and the JDK
  especially); `docker/Dockerfile` installs each in its own layer with
  pinned versions, so a deployment that wants a smaller sandbox can drop
  one and lose only that language. Each server is one more process in
  the sandbox container, sized by its language (tsserver and jdtls can
  each take a gigabyte on a large tree): raise `SANDBOX_WORKER_MEMORY`
  accordingly for a deployment with many code projects open at once. A
  server idle for ten minutes — no editor listening, nothing sent — is
  shut down; at most six run per checkout and forty-eight per worker.
  Files opened in the pane whose language has no server are counted in
  the `code_language_gaps` table (extension, language, whether the
  registry has no server or the worker lacks it, opens, last path) —
  there is no UI; `SELECT * FROM code_language_gaps ORDER BY open_count
  DESC` says which server to add next.
  Checkouts live on a second named volume
  (`renkei-sandbox-workspaces` / `sandbox_workspaces`) at
  `SANDBOX_WORKSPACES_DIR` (default `/workspaces`), a week since last use.
  That volume has to be mounted: without it the checkouts sit in the
  container's own filesystem and vanish when it is recreated, after which
  every command in a checkout the database still calls ready answers
  that the checkout is gone and the project has to be cloned again. That
  answer says which of two things it found: a worker with no files for
  the project at all (started without the volume, or a second instance
  behind the same address — there must be exactly one `worker-sandbox`,
  since checkouts live on its disk, not in the database) or the
  project's files minus this one checkout (removed). Every workspace the
  worker describes carries `worker`, its hostname, and the chat's clone
  step prints it, so a clone on one worker and a loss on another read as
  two different names; `docker ps --filter name=sandbox` and
  `docker inspect renkei-worker-sandbox --format '{{json .Mounts}}'` are
  the checks on the host.
  With the flag set the container's entrypoint keeps the worker **root**
  so every caller's commands can be dropped (setpriv) to that caller's own
  unprivileged uid — their checkout and home are theirs alone, the staged
  files and the worker's own environment are root's; without the flag the
  entrypoint drops to `worker` before starting, exactly as before. At
  boot, when root, the worker proves the drop works (setpriv present,
  `CAP_SETUID`/`CAP_SETGID`/`CAP_SETPCAP` held — Docker's defaults) and
  refuses to start otherwise, saying why. A
  command has the container's network (a project's install and tests
  need it), so a deployment that enables workspaces should give this
  service its own network with a route out and none to postgres or the
  other workers. `SANDBOX_ENV_SECRETS_KEY` (`openssl rand -base64 32`)
  seals the `.env` a code project's commands run with
  (migration 101, `sandbox_env_secrets`); it falls back to
  `TOKEN_ENCRYPTION_KEY`, and a dedicated key is the recommendation so the
  web app never holds one that opens them. **Stateful**, unlike the queue
  workers: its checkouts, staged bytes, browser sessions and unlocked keys
  are on its own disk and in its own memory, with only the rows in the
  database. Replicas on one host share those disks and work; replicas
  on separate disks do not — see "More than one sandbox replica" below.
  Entrypoint: `pnpm --filter @renkei/worker-sandbox start`.

**Code project services** (`docs/sandbox-workspaces-design.md`,
"Services"): with workspaces on, `SANDBOX_SERVICES_ENABLED=true` in
`.env` — read by BOTH the web app (the `code_service_*` tools a project's
chats get, and the Organization → Code services page) and this worker —
lets a project's chat start a container beside its checkout (Postgres,
Redis, a broker) for the project's tests, from the images the
organization allows. The worker needs a Docker engine for that:
uncomment the `/var/run/docker.sock` mount on `worker-sandbox` in
`docker-compose.yaml`, or run a socket proxy (docker-socket-proxy with
`CONTAINERS`, `IMAGES`, `NETWORKS` and `POST` allowed and nothing else)
and point `SANDBOX_DOCKER_HOST=tcp://<proxy>:2375` at it — the proxy is
the recommendation where it can be had, since the raw socket is the
engine itself. Either way the socket is root's inside the container: a
project's own commands run as other uids (above) and cannot open it;
what may run is decided by this worker against the organization's
rules, never by a command. The worker refuses to start with the flag
set and no engine answering, saying so. Services are created on an
internal Docker network (`SANDBOX_SERVICES_NETWORK`, default
`renkei-sandbox-services`; no route out of it), which this container
joins at boot so a project's commands reach a service by address —
`SANDBOX_CONTAINER_ID` names this container for that join (compose sets
it to `renkei-worker-sandbox`; the hostname works when compose is left
to set it). Each service is a plain container: no privileges,
`no-new-privileges`, a memory ceiling (`SANDBOX_SERVICE_MEMORY`, default
`1g`) and a process ceiling (`SANDBOX_SERVICE_PIDS`, default 512), no
restart policy, no published ports; it is stopped and removed with its
data a day after the project last ran a command, or when the chat
stops it. **The allow-list** is the organization's, at Organization →
Code services: every tenant starts with a handful of public images
(Postgres, pgvector, Redis, Valkey, MySQL, MariaDB, MongoDB, RabbitMQ,
SQL Server, Azurite) and an operator adds a whole private registry
(`myorg.azurecr.io`), a namespace on one (`myorg.azurecr.io/platform/*`)
or a single repository, with the credential a private registry is
pulled as (a service principal, a pull token): the secret is sealed by
this worker under `SANDBOX_ENV_SECRETS_KEY` (else `TOKEN_ENCRYPTION_KEY`),
the same key as the environment secrets, and never shown again.

**More than one sandbox replica:** fine on one host, because Compose
replicas of a service share its named volumes — and the sandbox worker
keeps nothing about checkouts or staged files in memory; every verb loads
the row from Postgres and reads the disk. So `scale: N` works as long as
the service mounts BOTH volumes, `renkei-sandbox-data:/data` and
`renkei-sandbox-workspaces:/workspaces`. Mount only the first and each
replica keeps its checkouts in its own writable layer: a clone lands on
one replica and the next call, on another, finds nothing and reports the
checkout gone (and a recreate wipes them all). Two things stay per
replica whatever the volumes: nothing, once `/data` is shared and the
worker has `SANDBOX_ENV_SECRETS_KEY` (else `TOKEN_ENCRYPTION_KEY`) —
unlocked browser secret keys are sealed onto `/data` for their window
(above), and browser sessions carry over — after every call the
worker seals the session's cookies, page URL and last refs onto `/data`
under a key derived from `SANDBOX_ENV_SECRETS_KEY` (else
`TOKEN_ENCRYPTION_KEY`) and the caller, and whichever replica answers
next resumes from it (`docs/sandbox-connector-design.md`, "Across
replicas and restarts"); without either key, sessions stay per replica
and the worker says so at boot. Each replica's sweep removes
only bytes it can see and leaves the rest a day past expiry, so replicas
on separate disks (several hosts) never delete each other's rows early.

**Horizontal scale:** either process may run as N instances. Claims take
row locks (`FOR UPDATE SKIP LOCKED`), and messages sharing an ordering key
(one mailbox's index writes, one subscription's delta rounds, one room's
messages) are delivered strictly in order, one at a time, across all
instances — distinct keys drain in parallel. With docker compose, drop the
hardcoded `container_name` and use `--scale embeddings-worker=N`.

**Dead letters:** each queue pairs with a `*_dead_letters` table
(`events_dead_letters`, `embedding_jobs_dead_letters`,
`batch_job_messages_dead_letters`). A message that
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
FROM node:24-alpine
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

- Current LTS: Node 24.x

Test thoroughly before upgrading production.

## Support

For issues:

1. Check logs: `journalctl -u jira-mcp-gateway -n 50`
2. Verify config: `echo $DATABASE_URL` (never commit .env files)
3. Test connectivity: `curl -v https://yourdomain.com/api/health`
4. Check database: `psql $DATABASE_URL -c "\dt"`

## Chat voice (speech service)

The chat's read-aloud and voice conversation need no environment variables: an org administrator configures the speech service under **Connector setup → Voice** (Azure AI Speech today — a region or a custom domain/private endpoint, an API key, a default voice and language), and the key is stored encrypted in `connector_configs` like every other org-wide credential. Until it is configured and enabled, nothing about voice is shown to anyone.

Two deployment details do matter:

- **The microphone needs a secure context.** Browsers only expose `getUserMedia` on `https://` origins (or `localhost`), so voice conversations work behind the TLS setup above and not over plain `http://` on a LAN address. Reading replies aloud has no such requirement.
- **Outbound access to the speech service.** The web app calls `https://{region}.tts.speech.microsoft.com` and `https://{region}.stt.speech.microsoft.com` (or the configured custom endpoint) from the server, never from the browser; allow those hosts from wherever `web` runs. The browser only ever talks to the app's own `/api/tenant/…/voice/*` routes, which are session-guarded and rate-limited per person.

The microphone tap is an audio worklet served as a static file (`apps/web/public/voice-capture-worklet.js`); a reverse proxy that serves `/public` assets must serve it with a JavaScript content type, which Next.js does by default.

### Setting up Azure AI Speech

1. **Create the resource.** In the Azure portal, _Create a resource_ → search for **Speech** (under Azure AI services) → _Create_. Pick the subscription and resource group, a **region** close to your users (every region with neural voices works; `eastus`, `westeurope`, `australiaeast` are typical), a name, and a pricing tier: **F0** is free (roughly half a million characters of neural speech and five hours of recognition a month, one request at a time) and is enough to try it; **S0** is pay-as-you-go for real use. An existing multi-service _Azure AI services_ resource works too — its key and region are accepted the same way.
2. **Copy the key and region.** On the resource, open _Resource Management → Keys and Endpoint_. Note **KEY 1** (either key works; keep KEY 2 for rotation) and the **Location/Region** value (`eastus`, not `East US`).
3. **Enter them in Renkei.** As an operator, open _Admin → Connector setup → Voice_. Set _Region_ to the region value and paste the key into _API key_. Leave _Custom endpoint_ blank unless you use a private endpoint (below). Choose a _Default voice_ and _Default language_ — `en-US-AvaMultilingualNeural` and `en-US` are sensible defaults; any voice from Azure's Voice Gallery is valid by its short name (for example `en-GB-SoniaNeural`, `de-DE-KatjaNeural`). Tick _Enabled_ and _Save_.
4. **Test it.** Press _Test connection_. It lists the resource's voices and reports how many came back, and warns if the default voice is not among them. From here the speaker button appears in every chat, and people pick their own voice, pace, language and wave colours under _Preferences_.
5. **Rotating the key.** Regenerate KEY 2 in Azure, paste it into the form (the stored key is never shown; a blank field keeps it), save, then regenerate KEY 1. Every save records a `connector.configured` audit event.

**Private endpoint or custom domain.** A Speech resource reached through a private endpoint (or one with a custom subdomain enabled) is not served from the regional hosts. Set _Custom endpoint_ to the resource's base URL, `https://<name>.cognitiveservices.azure.com`, and Renkei uses Azure's custom-domain paths (`/tts/…` and `/stt/…`) under it instead; the region can then be left blank. The `web` container must be able to resolve and reach that name.

**The assistant plays from one speaker, muffled, or with artefacts — but only in a voice conversation.** That is the platform, not the service: when a page opens the microphone with echo cancellation, macOS routes sound through its voice-processing path and a Bluetooth headset drops to its hands-free profile, and either can leave playback one-sided or degraded until the microphone closes. Read-aloud, which opens no microphone, is unaffected. The person turns off _Cancel echo on this device_ in the chat's speaker menu; playback is then left alone, the microphone is closed to speech while the assistant talks, and Stop is how a reply is interrupted. The choice is kept per browser.

**What leaves for Azure.** Reply text for synthesis, and the person's recorded utterance for transcription — both over TLS from the server, never from the browser. Azure's data handling for Speech is covered by its standard terms; nothing is stored by Renkei beyond the chat's own text.

## Chat attachments (object storage)

Files people upload into the chat (`/[slug]/chat`) are the one thing the
web app stores as bytes at rest, and they live in an object store behind
`packages/blob-store`, never on the app's disk. The store is chosen by
`BLOB_STORE_PROVIDER`; today the only backend is Azure Blob Storage
(`azure`), spoken directly over its REST API with Shared Key auth:

- `AZURE_BLOB_ACCOUNT` — the storage account name
- `AZURE_BLOB_KEY` — one of the account's access keys (base64, as the
  portal shows it)
- `AZURE_BLOB_CONTAINER` — container name, default `renkei-chat`; created
  on first use if it does not exist
- `AZURE_BLOB_ENDPOINT` — optional, default
  `https://{account}.blob.core.windows.net`

Set them in `.env`: the web app reads them to accept uploads and serve
downloads (always through the app, under the caller's session — no
public or signed URLs), and `worker-agents` reads them because the chat
retention sweep (the org's **Chat retention** setting, default keep
forever) deletes attachment blobs before it deletes the rows. Unset, chat
uploads are simply off — closed, never open, like the worker keys above.

`docker-compose.yml` (dev) runs the Azurite emulator instead of a real
account, with Azurite's published development account and key; nothing in
that configuration is a secret.

An organization can also configure its own account on **Organization →
Storage** in the app (the row lives in `connector_configs`, the key sealed
like any connector secret); when one is saved and enabled it takes
precedence over these variables for that organization.

### Storage behind Azure Front Door

The storage account can sit behind the same Azure Front Door (Premium)
profile that fronts the app, so it accepts no public traffic and every
byte crosses the WAF. Nothing in Renkei changes for this beyond the
endpoint: the client builds every URL from the configured endpoint plus
the resource path, and Shared Key signing canonicalizes by account name
and path (`/{account}/{container}/{blob}`), never by host — so any
hostname that forwards the path, query and `x-ms-*`/`Authorization`
headers to the account untouched works. What has to be right is the Front
Door and WAF configuration, because the only client of that hostname is
Renkei's server, not a browser.

1. **Storage account** — Networking → Public network access _Disabled_
   (keep it enabled from selected networks while cutting over). Keep the
   account key; Renkei keeps using Shared Key.
2. **Origin group** (e.g. `renkei-storage`) on the Front Door profile:
   one origin of type _Storage (Azure Blobs)_, host
   `{account}.blob.core.windows.net`, origin host header the same, HTTPS
   only. **Enable private link** to the account, target sub-resource
   `blob`, then approve the pending connection on the storage account
   (Networking → Private endpoint connections). Health probes _off_ for
   this single-origin group: a probe against a private blob endpoint has
   nothing anonymous to hit, and a 4xx would mark the origin unhealthy.
3. **A dedicated domain and route** — never the app's route, since storage
   paths would collide with the app's URL space. A custom domain such as
   `files.<your-domain>` (or a second endpoint on the profile) with a
   route on `/*`, HTTPS only, origin path empty, **caching disabled**.
   Caching is not just pointless here (uploads are `PUT`s, downloads are
   per-session): with caching on, Front Door fetches origin content in
   chunks by adding a `Range` header to its `GET`, and `Range` is one of
   the headers in the Shared Key string-to-sign — Storage then rejects
   every read with 403 `AuthenticationFailed` while writes still pass.
4. **A second WAF policy** for that domain (e.g. `renkeistoragewaf`),
   attached through the profile's Security policy: Prevention mode, DRS
   2.1, **no Bot Manager rule set** (it classifies the server's `fetch`
   as an unknown bot and blocks it), and two custom rules: priority 1
   _Allow_ only Renkei's egress IPs (the web app's and `worker-agents`'
   outbound addresses — the platform's outbound IPs or the NAT gateway),
   priority 2 _Block_ everything else. The allow-list is the real
   protection; the managed rules are belt and braces. Two managed-rule
   effects to expect on raw binary `PUT` bodies: the WAF inspects only the
   first 128 KB of a body, and DRS can flag an unparseable body (the
   200000-group "failed to parse request body" rules). If the connection
   test or a real upload comes back 403/413, add a rule exclusion for the
   storage domain on those rule ids rather than weakening the policy.
5. **Renkei** — Organization → Storage → _Endpoint_
   `https://files.<your-domain>` (account, key and container unchanged) →
   **Test connection** → Save. The test writes, reads and deletes a probe
   through the new path, so it exercises Front Door, the private link and
   the WAF in one go. Deployments configured through the environment set
   `AZURE_BLOB_ENDPOINT` to the same value.

Cutover order: origin group with private link, approved → domain, route
and WAF policy → test from Renkei with public access still enabled →
disable public access → test again. A 403 from the test with public access
still on points at the WAF (Front Door → Monitoring → WAF logs name the
rule); a 5xx points at the origin or private link (pending approval, wrong
sub-resource, or a health probe left on). From a machine outside the
allow-list, `curl -I https://files.<your-domain>/renkei-chat/` must come
back blocked by Front Door.

**Reading a failed test.** The Storage page's Test connection names the
step that failed and who refused it:

- _Blocked before reaching Azure Blob (403 from the edge; x-azure-ref …)_
  — a Front Door WAF rule or route on that host refused the request
  before it reached the account. Look the reference up in the profile's
  WAF logs (Front Door → Monitoring → Logs, or the policy's diagnostics)
  to see the rule id; then either exclude that rule for the storage domain
  or, the usual fix, move storage to its own domain and policy as above.
  A policy in _Detection_ mode never blocks, so this answer means a
  policy in _Prevention_ mode or a route that does not reach the account
  (an endpoint shared with the app, for instance). The endpoint must be a
  route that forwards to the account.
- _Azure Blob 403 AuthenticationFailed: … string to sign …_ — the account
  answered and rejected the signature, so the request was altered on the
  way. Writes passing while reads fail means **caching is on** for the
  route: the quoted string-to-sign will show a `Range: bytes=…` line that
  Renkei never sent (Front Door's object chunking). Turn caching off on
  the route. Otherwise look for a rewritten path (an origin path on the
  route) or a stripped or added `x-ms-*` header, comparing the quoted
  string with the path Renkei sent (`/{container}/probe/{tenant}/{time}`
  for the test).
- _Azure Blob 403 AuthorizationFailure_ — the account's network rules
  refused the source (public access off without the private link
  approved, or the wrong sub-resource).
- A 5xx _from the edge_ — the route's origin is unhealthy or unreachable:
  a pending private-endpoint approval, or a health probe left on.
