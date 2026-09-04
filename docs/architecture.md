# Architecture (as built)

This describes the monorepo as it exists in code today. For the target architecture and the reasoning behind it, see [`RENKEI.md`](../RENKEI.md); for what's stale about the root README, see [`docs/README.md`](./README.md).

## Processes

Five long-running/deployable units, all built from one monorepo (`docker/Dockerfile` is a multi-stage builder producing images for each):

| Process | Entry point | What it does |
| --- | --- | --- |
| `apps/web` | Next.js App Router | Every user- and agent-facing surface: the tenant web UI, the MCP gateway, both OAuth/OIDC layers, the admin UI, the first-party chat (`/[slug]/chat`, which runs its LLM turns in this process and calls back into its **own** MCP endpoint over loopback for tool calls — see [`chat.md`](./chat.md)), and webhook **receipt** (verify signature, insert an `events` row, return 200 — no processing here). |
| `apps/worker` (`index.ts`) | Node | Consumes the `events` queue: per-connector webhook handlers, a `domain:{provider}` dispatch step that fans events out to knowledge indexing and agent triggers, and periodic sweeps (webhook health, subscription renewal, grant expiry, log retention, agent trigger firing). |
| `apps/worker` (`embeddings-worker.ts`) | Node, separate process from the above, same image | Consumes the `embedding_jobs` queue only: knowledge ingest/delete/purge/reconcile/enrich. Isolated so a slow org-configured embeddings endpoint can never stall an event reply. |
| `apps/worker-agents` | Node | Consumes the `agent_jobs` queue: runs agents step-by-step (`engine.ts`), turns prose into agent drafts, and fires schedule- and approval-timeout-driven runs. Talks back into `apps/web`'s own MCP endpoint (`RENKEI_WEB_INTERNAL_URL`) to execute tool calls as the run's owner. Also hosts the chat sweeps (`chat-sweep.ts`): the turn janitor that marks a crashed turn `interrupted`, the retention sweep that deletes attachment blobs and then chats, and the orphan-grant prune. |
| `apps/worker-fileshares` | Bearer-authenticated HTTP server | Owns every SMB/SFTP session and is the only process besides the admin save path that decrypts fileshare credentials. Isolated because file-share I/O is slow and fragile relative to a request handler. |
| `apps/worker-onbase` | Bearer-authenticated HTTP server | Owns all traffic to a tenant's on-prem OnBase API Server / Hyland IdP, which typically lives in private address space that `apps/web`'s SSRF guard refuses to reach by design. Holds no long-lived tokens of its own (per-user tokens ride each request); does hold the tenant's connector config. |

All five share one Postgres 16 instance (Kysely via `packages/db`) — see Decision #11 in `RENKEI.md`. pgvector lives in the same database as the relational tables. The one datastore beyond Postgres is the **object store for chat attachments** (`packages/blob-store`, Azure Blob Storage today; the dev compose file runs Azurite in its place) — bytes only, every row describing them stays in Postgres, and the app is fully functional with it unconfigured (uploads are simply off).

`apps/worker` and `apps/worker-agents` both run their poll loop and sweeps through the shared `packages/worker-loop` (`createEventLoop`, `schedulePeriodicSweep`) rather than duplicating that logic.

## The queue

`packages/queue` is the one broker-agnostic contract behind three named queues (`webhookEventsQueue`, `embeddingJobsQueue`, `agentJobsQueue`), all backed by the same Postgres tables (`FOR UPDATE SKIP LOCKED` claims, lease-based reclaim, `attempts`-based retry with a dead-letter store). Messages sharing an `orderingKey` are delivered strictly in order across all consumer instances. A `memory.ts` adapter exists for tests. This is "everything is an event" made concrete: webhook routes and scheduler sweeps both just insert a row; the consumer doesn't know or care which produced it.

## Request/event flow

**An MCP tool call** (an LLM acting for a user, or an agent run acting for its owner):
`app/api/mcp/[tenantId]/[transport]/route.ts` resolves the bearer token → loads the caller's connector grants → applies org settings (read-only mode, disabled connectors) and the capability-registry's per-user projection → `registerRenkeiTools` wires in only the tools that survive the projection → the tool handler calls out to the relevant connector package (per-user OAuth token in hand) or to `@renkei/knowledge` for `search_knowledge`. See [`mcp-gateway.md`](./mcp-gateway.md).

**An inbound provider event** (WebEx message, Graph change notification, Zoom recording-ready webhook):
webhook route in `apps/web` verifies the signature and inserts an `events` row → `apps/worker` claims it, runs the connector-specific handler, normalizes it into a `domain:{provider}` event → `domain-dispatch.ts` fans that out in fixed order: (1) knowledge indexing, if the event type is in the static `KNOWLEDGE_SUBSCRIBERS` map, enqueued onto `embedding_jobs`; (2) agent triggers, via `fanOutAgentEvents` from `@renkei/agents`, enqueued onto `agent_jobs`. A lightweight heuristic classifier (`pipeline/classify.ts`) can also propose a suggested action (e.g. "this WebEx message looks like an issue report" → draft a `jira_create_issue` card) — this is the cheapest tier of a pluggable classify step, not an LLM call.

**A chat turn** (a person talking to the org's model roster in the web UI): `POST …/chat/chats/[chatId]/turns` inserts the turn and message rows and answers 202 → the rest runs in the web process after the response (`after()`), streaming the model's text, thinking and tool calls into the message rows and onto a per-turn in-process channel the SSE route forwards to the browser → each tool call goes through the same MCP gateway with a token minted for the turn (application `agent`, no agent id, the person's roles), so the projection, read-only mode, usage tracking and redaction that apply to any MCP client apply here too. See [`chat.md`](./chat.md).

**An agent run**: triggered by event fan-out above, a cron/recurrence sweep, an approval/question timing out or being answered, or a manual `agent_run_now` call → `apps/worker-agents` claims the `agent_jobs` message → `engine.ts` walks the agent's step document, writing one `agent_run_steps` row per attempt *before* running the LLM loop (so a redelivered job resumes instead of double-acting) → tool calls go back through the MCP gateway in `apps/web` using a minted per-run token. See [`agents.md`](./agents.md).

## Shared packages

Everything not in `apps/*` lives under `packages/*` and is consumed by more than one process (mainly `apps/web` and `apps/worker*`) via workspace imports (`@renkei/<name>`). See [`connectors.md`](./connectors.md) for the provider-integration packages and [`knowledge-and-security.md`](./knowledge-and-security.md) for the knowledge/ACL/disclosure/redaction stack. The remaining infrastructure packages:

- **`db`** — Kysely client and migrations (`packages/db/src/migrations/`, sequentially numbered, run via `pnpm --filter @renkei/db migrate`). `db:types` regenerates the generated schema type file from a live database — that generated file is the closest thing to an up-to-date schema reference; there is no separate ERD.
- **`provider-grants`** — the generic OAuth grant lifecycle behind a `ProviderAdapter` interface (encrypted, subject-bound storage; cross-process refresh with distributed locking), with one adapter per per-user-OAuth provider (Atlassian, Bitbucket, WebEx, Zoom, OnBase, Microsoft).
- **`connector-config`** — per-tenant connector configuration/credential store backing every connector package (enabled flag, non-secret settings, encrypted secrets), with a short-lived read cache.
- **`crypto`** — secretbox authenticated encryption for tokens/secrets at rest, plus a content-envelope used for knowledge-chunk text.
- **`settings`** — typed, cached accessor over org- and tenant-level policy rows (read-only mode, disabled connectors, redaction toggles, retention windows, poll intervals) — policy is data in Postgres, not environment variables (except the pre-auth `PUBLIC_BASE_URL`).
- **`rate-limit`** — a process-scoped token-bucket limiter protecting outbound provider calls from webhook floods or sweep bursts.
- **`tool-outcomes`** — the shared vocabulary describing what an MCP tool call did or can fail at (read vs. act, curated outcome categories); exists as its own package specifically so `apps/worker-agents` can use it without importing from `apps/web`.
- **`user-prefs`** — per-user notification preferences (run started/finished/failed, per-connector/category overrides), reusing `tool-outcomes`' category taxonomy.
- **`notifications`** — Web Push delivery (VAPID keys, subscriptions, best-effort per-device send); the newest package in the repo (added 2026-08-30).
- **`email-sanitizer`** — a deterministic classify → route → clean/extract/exclude pipeline that runs ahead of embedding for mail, including a sandboxed per-org cleaner-script runtime.
- **`document-text`** — dependency-light OOXML (docx/xlsx/pptx) and PDF text extraction for the knowledge index; deliberately does no OCR.
- **`worker-loop`** — the shared poll-loop and independent-sweep-timer logic used identically by `apps/worker` and `apps/worker-agents`.
- **`mcp-client`** — the HTTP JSON-RPC client (`HttpMcpClient`) and per-run/per-turn token minting (`mintRunToken`, `revokeRunToken`) that `apps/worker-agents` and the chat both use to call the MCP gateway in `apps/web` as a specific person; it used to live inside the agents worker.
- **`blob-store`** — the `BlobStore` interface (put/get/stream/delete/ensureContainer, keys built from ids only) behind `BLOB_STORE_PROVIDER`, with an Azure Blob backend hand-rolled over `fetch` (Shared Key auth). Other providers are an empty slot in `config.ts`; nothing hands out signed URLs — downloads stream through the app under a session check.

## What's out of date elsewhere

The root `README.md`'s "How it works" and "Layout" sections describe the repo as it looked when it was a single-purpose Jira MCP server. That framing is no longer accurate — the MCP tool tree now spans 11+ connectors plus agents, cards, and knowledge search — but the getting-started steps and script table in that README are still correct and worth using as-is. Treat this file, not the README's "How it works" section, as the current picture.
