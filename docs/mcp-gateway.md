# MCP gateway, auth, admin UI, and cards

Everything here lives in `apps/web`. See [`architecture.md`](./architecture.md) for how this fits into the rest of the system.

## The MCP endpoint

Route: `app/api/mcp/[tenantId]/[transport]/route.ts`, built on `mcp-handler`'s `createMcpHandler`. Per request:

1. Resolve the bearer token to a caller — either an MCP-client subject or an agent-run token — via `lib/mcp-token.ts`. The first-party chat is a third caller in the second shape: each turn mints a short-lived `agent` token with no agent id and the person's own roles (`@renkei/mcp-client`), and the web process calls this endpoint over loopback with it, so a chat is gated exactly like any external MCP client (see [`chat.md`](./chat.md)).
2. Load the caller's connector grants (Jira/JSM, Microsoft, WebEx, Zoom, OnBase, Bitbucket — whichever are provisioned).
3. Apply org settings (`@renkei/settings`: read-only mode, disabled connectors) and the per-user capability projection (`@renkei/capability-registry`, see [`knowledge-and-security.md`](./knowledge-and-security.md)).
4. `registerRenkeiTools` (`lib/mcp-tools/registry.ts`) registers only the tools that survive that projection — the tool list returned to a given MCP client is a genuine per-user, per-org filter, never a static catalog.
5. Wrap the whole thing with usage tracking (`lib/mcp-tools/usage-tracking.ts`) and, optionally, redaction (`lib/mcp-tools/redaction-gate.ts`, using `@renkei/redaction`).

Handlers are cached per `tenantId:subject:agentId:surfaceVersion` (`lib/mcp-tools/handler-cache.ts`) so rebuilding the tool set isn't paid on every call.

`lib/mcp-tools/` has one subdirectory per tool family — `agents`, `bitbucket`, `cards`, `confluence`, `fileshares`, `graph`, `jira`, `jira-service-management`, `knowledge`, `onbase`, `onedrive`, `outlook`, `sharepoint`, `summary`, `webex`, `zoom` — roughly 190 files total. Tool name prefixes: `jira_*`, `jsm_*`/`jsm_ops_*`, `webex_*`, `outlook_*`, `sharepoint_*`, `onedrive_*`, `confluence_*`, `zoom_*`, `fileshare_*`, `onbase_*`, plus the cross-cutting `search_knowledge`, `analyze_transcript`, and `whoami`. MCP Apps widget UI resources (interactive cards rendered inline in a client) are registered separately via `lib/mcp-tools/widgets.ts`, with widget source under `lib/mcp-widgets/`.

## Auth: two independent OAuth/OIDC layers

**Layer 1 — Renkei as an OAuth 2.1 authorization server toward MCP clients.** Per-tenant `authorize`/`register`/`token` endpoints under `app/api/mcp/[tenantId]/oauth/`, with PKCE and RFC 8414/9728 discovery (`.well-known/oauth-authorization-server`, `.well-known/oauth-protected-resource`, both at the tenant-scoped and top-level paths). Top-level client registration/callback: `app/api/oauth/{register,callback}`. Code: `lib/oauth-client-auth.ts`.

**Layer 1.5 — tenant sign-in.** Each tenant configures its own OIDC provider (`tenant_oidc`); users authenticate through it at `app/api/auth/oidc/{login,callback}` (`lib/oidc-discovery.ts`, `lib/oidc-id-token.ts`, `lib/oidc-roles.ts`). The OIDC `subject` is the identity key that binds sessions, MCP tokens, and provider grants together.

**Layer 2 — per-user provider OAuth.** Each user separately links their own Atlassian, Microsoft, WebEx, Zoom, Bitbucket, or (for OnBase) tenant-IdP account. Grants are bound to the OIDC subject and encrypted at rest (`@renkei/provider-grants`, `@renkei/crypto`). Per-connector auth code lives alongside each tool family, e.g. `lib/mcp-tools/jira/jira-auth.ts`, `lib/mcp-tools/graph/*-auth.ts`. Because every action and every read happens with the calling user's own token, permissions are inherited from the provider rather than reimplemented by Renkei.

OnBase is the one exception to "Renkei-registered SaaS OAuth app": the IdP itself is tenant-supplied (an on-prem Hyland IdP), so it's Authorization Code + PKCE against config, not a fixed provider.

## Admin UI

Under `app/[slug]/admin/`, reached as **Organization** from the account menu (the landing page at `admin/page.tsx` lists every area; the app menu does not), an org-admin can configure: connector enable/disable (`connectors/`), agent oversight and run history (`agents/`, `agents/[agentId]/runs`), the user roster (`people/`), provider grants (`grants/`), SharePoint sites and calendars (`sites/`, `calendars/`), fileshare registration (`file-shares/`), redaction policy (`redaction/`), outbound email cleaning rules (`email-sanitizer/`), agent LLM model configuration (`llm-models/`), the organization's file storage for chat uploads and produced files (`storage/`), and org-wide policy such as read-only mode and capability flags (`settings/`). Audit/event visibility lives at `audit/`, `events/`, and a top-level `logs` page.

This is the concrete implementation of `RENKEI.md`'s "org-admins own the platform's policy surface" — org defaults, connector limits, and capability flags are all admin-console-editable rows, not code.

## Cards / actionable items

The daily-briefing/curated-card feed: component `app/[slug]/cards.tsx` (rendered from `app/[slug]/home/page.tsx`), with `card-actions.tsx`, `approval-actions.tsx`, `question-actions.tsx`, `archive-action.tsx` alongside it. API: `app/api/tenant/[tenantId]/actionable-items/` (list/create, `[itemId]/decision`, `[itemId]/archive`).

Backing table: `actionable_items`. Notable columns: `owner_subject` (`NULL` = tenant-wide feed item, otherwise scoped to one user), `kind` (`'action'` needs a `suggested_action`; `'info'` doesn't), and `created_by`/`created_by_agent_id` for provenance (`NULL` means the ambient event pipeline produced it — an MCP tool call can never forge that). Lifecycle: created as `suggested`, then either a decision is recorded (approve/dismiss) or `archived_at` is set directly. Agents can create `info` cards for their own owner via the `cards` MCP tool family, but action cards remain pipeline-only — an agent cannot self-approve its own suggested action by writing the card that proposes it.

For the newer per-step approval/question mechanism (distinct from this card-level approve/dismiss), see [`agents.md`](./agents.md).
