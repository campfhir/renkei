# Renkei

Renkei (連携 — "linkage, cooperation") is a permission-aware knowledge and action layer for the tools an organization already uses. The full product vision, architecture, and roadmap live in [RENKEI.md](./RENKEI.md).

**What this repo is today:** the first module of that platform — a multi-tenant **Jira MCP server**. It exposes 50+ Jira and Jira Service Management tools over the Model Context Protocol, with per-user OAuth so every action happens as the calling user and reads honor that user's Jira permissions.

## How it works

- **MCP endpoint:** `/api/mcp/{tenantId}/{transport}` (streamable HTTP, JSON-RPC via `mcp-handler`).
- **Auth, layer 1:** the server is an OAuth 2.1 authorization server toward MCP clients — per-tenant authorize/register/token endpoints with PKCE and RFC 8414/9728 discovery. Users sign in through their tenant's own OIDC provider.
- **Auth, layer 2:** each signed-in user links their own Atlassian account (OAuth 2.0 3LO). The grant is bound to the user's OIDC subject and encrypted at rest; tool calls hit `api.atlassian.com` with that user's token.
- **Storage:** PostgreSQL 16 via Kysely. Migrations live in `lib/migrations/`; `/api/health` returns 503 while migrations are pending, which gates deployments.

## Getting started

Requirements: Node 24+, pnpm, Docker (for Postgres).

```bash
pnpm install
cp .env.example .env.development   # fill in OIDC + Atlassian OAuth credentials
docker compose -f docker-compose.yml up -d postgres
npx tsx scripts/migrate.ts        # run database migrations
pnpm dev
```

MCP clients need a public HTTPS origin for OAuth callbacks during development — see [NGROK_SETUP.md](./NGROK_SETUP.md).

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Start the Next.js dev server |
| `pnpm build` | Production build |
| `pnpm start` | Run the production build |
| `pnpm lint` | ESLint over the repo |
| `pnpm typecheck` | TypeScript, no emit |
| `pnpm test` | Jest test suite |
| `pnpm db:types` | Regenerate `lib/db.types.ts` from the live database schema |

## Layout

```
app/            Next.js App Router: pages, MCP + OAuth + OIDC + admin API routes
lib/            business logic
  mcp-tools/    tool implementations (jira/, jira-service-management/)
  migrations/   Kysely migrations, run by lib/migrations/runner.ts
  crypto/       AES-256-GCM secretbox for grants at rest
docker/         multi-stage Dockerfile (builder / runtime / migrate)
scripts/        build, migration, docker, and ngrok helpers
```

## Deployment

`docker-compose.yaml` (production) runs prebuilt images with a `migrate` service behind the `tools` profile, so `up` never migrates as a side effect. See [DEPLOYMENT.md](./DEPLOYMENT.md) for the full guide.
