# Renkei

Renkei (連携 — "linkage, cooperation") is a permission-aware knowledge and action layer for the tools an organization already uses. The full product vision, architecture, and roadmap live in [RENKEI.md](./RENKEI.md).

**What this repo is today:** the first module of that platform — a multi-tenant **Jira MCP server**. It exposes 50+ Jira and Jira Service Management tools over the Model Context Protocol, with per-user OAuth so every action happens as the calling user and reads honor that user's Jira permissions.

> This section describes the repo's original scope. The MCP tool surface has since grown to cover Confluence, Bitbucket, WebEx, Outlook/Graph, SharePoint, OneDrive, Zoom, OnBase, and network fileshares, plus an agent system, permission-aware knowledge search, and cross-tool cards — see [`docs/architecture.md`](./docs/architecture.md) for the current, maintained picture and [`docs/README.md`](./docs/README.md) for the full documentation index.

## How it works

- **MCP endpoint:** `/api/mcp/{tenantId}/{transport}` (streamable HTTP, JSON-RPC via `mcp-handler`). Beyond the Jira tools, `search_knowledge` searches what Renkei has indexed from connected tools — every result is verified against the source system for the calling user's access before disclosure, and withheld results are reported as a count.
- **Auth, layer 1:** the server is an OAuth 2.1 authorization server toward MCP clients — per-tenant authorize/register/token endpoints with PKCE and RFC 8414/9728 discovery. Users sign in through their tenant's own OIDC provider.
- **Auth, layer 2:** each signed-in user links their own Atlassian account (OAuth 2.0 3LO). The grant is bound to the user's OIDC subject and encrypted at rest; tool calls hit `api.atlassian.com` with that user's token.
- **Storage:** PostgreSQL 16 via Kysely. Migrations live in `lib/migrations/`; `/api/health` returns 503 while migrations are pending, which gates deployments.

## Getting started

Requirements: Node 24+, pnpm, Docker (for Postgres).

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.development   # fill in OIDC + Atlassian OAuth credentials
docker compose -f docker-compose.yml up -d postgres
pnpm --filter @renkei/db migrate    # run database migrations
pnpm dev
```

MCP clients need a public HTTPS origin for OAuth callbacks during development — see [NGROK_SETUP.md](./NGROK_SETUP.md).

**WebEx connector:** store the bot token and webhook secret via
`PUT /api/admin/{slug}/connectors/webex`, then let Renkei register its own
webhooks: `POST /api/admin/{slug}/connectors/webex/webhooks` creates the
two required registrations (`messages/created` for ingestion,
`attachmentActions/created` for the "Push to Renkei" card button) pointing
at `/api/webhooks/webex/{tenantId}`. `GET` on the same path reports their
health. The worker also re-checks every 15 minutes and re-creates webhooks
that were deleted, disabled by WebEx after repeated failures, or left
signing with a stale secret — so a rotting connector repairs itself and the
repair is visible in the worker log.

## Scripts

| Command                             | What it does                                  |
| ----------------------------------- | --------------------------------------------- |
| `pnpm dev`                          | Start the Next.js dev server (`renkei`)       |
| `pnpm build`                        | Production build across the workspace         |
| `pnpm lint`                         | ESLint over the whole repo                    |
| `pnpm typecheck`                    | TypeScript, no emit, every package            |
| `pnpm test`                         | Jest suites of every package                  |
| `pnpm --filter @renkei/db migrate`  | Run database migrations                       |
| `pnpm --filter @renkei/db db:types` | Regenerate `db.types.ts` from the live schema |
| `pnpm --filter @renkei/worker dev`  | Run the worker with reload                    |

## Layout

The monorepo follows the web/worker/packages topology of `RENKEI.md` (Decision #17):

```
apps/web/          Next.js: all surfaces, MCP gateway, OAuth/OIDC, admin UI,
                   and (thin) webhook receipt
  app/             App Router: pages, MCP + OAuth + OIDC + admin API routes
  lib/             business logic; mcp-tools/ holds the Jira + JSM tools
apps/worker/       two long-running processes, one per queue (Decision
                   #20): index.ts consumes `events` (replies, webhook
                   orchestration); embeddings-worker.ts consumes
                   `embedding_jobs` (all ingest-time embedding calls), so
                   a slow embeddings endpoint can never stall a reply.
                   Both scale horizontally: row-locked claims + ordering
                   keys (see packages/queue)
packages/queue/    @renkei/queue — the broker-agnostic queue contract
                   (leases, ack/nack, retry, ordering keys, dead-letter
                   requeue) with Postgres and in-memory adapters
packages/db/       @renkei/db — Kysely client, generated schema types, and
                   migrations; shared by web, worker, and the migrate CLI
docker/            multi-stage Dockerfile (builder / runtime / worker / migrate)
scripts/           docker build/push and ngrok helpers
```

## Deployment

`docker-compose.yaml` (production) runs prebuilt images with a `migrate` service behind the `tools` profile, so `up` never migrates as a side effect. The worker ships as two services off one image — `worker` (the `events` queue) and `embeddings-worker` (the `embedding_jobs` queue), both horizontally scalable (Decision #20) — which must be deployed together with migration 030. See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full guide.
