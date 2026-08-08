# UI shell brief — app nav, routing, and connector self-service

Working brief, captured so the conversation can be picked up from another
device. Now built: the `/[slug]/*` tree, the app shell, the connector config
UI, and the redirect rewiring all landed on this branch — see the commit that
touched this line. What remains open is at the bottom.

## Why now

The deploy was rebuilt on a fresh database to get pgvector, so
`connector_configs` is empty and the Atlassian OAuth app has to be re-registered
from scratch. There is no UI for that — only `PUT /api/admin/[slug]/connectors/atlassian`,
which needs an operator cookie and a devtools console. That gap is what kicked
this off.

## What to build

### 1. Connector configuration UI

An org-admin screen for the Jira/Atlassian connector: client id, client secret,
scopes, optional redirect override, enabled toggle. Backed by the routes that
already exist under `apps/web/app/api/admin/[slug]/connectors/` (`atlassian`,
`webex`, `embeddings`). GET reports presence only — the secret never comes back
over the wire, so the form has to handle "already set, leave alone" as a state.

### 2. Home page shows only the connectors available to that user

`apps/web/app/page.tsx` is currently the email/home-realm sign-in form. Post
sign-in, the home page should list the connectors the org has enabled and the
user's own grant state for each — not every connector that exists in the code.

### 3. Application nav in the layout

- App-level nav lives on the layout, not per page.
- User avatar and sign-out in the nav bar.
- Hamburger menu that slides in from the left edge, with stacked (nested) menus.
- Dark mode throughout.
- Mobile friendly throughout.

### 4. Sign-in flow

    enter email on login page
      -> home-realm discovery: does an OIDC config exist for this domain?
         - if not, create it (then prove login)
      -> land on the home page

The OAuth callback should land on the home page rather than
`apps/web/app/mcp/[tenantId]/page.tsx`. That page can go away: a user only needs
to sign in, connect their accounts, and copy the MCP URL into their LLM app —
that does not warrant a dedicated page. Fold the MCP endpoint URL into the home
page or the connectors page.

### 5. Routing — move to `/[slug]/*`

Keep the tenant model, drop the `/tenant/` and `/mcp/` prefixes.

**Pages are keyed by slug, not tenantId** — a slug is memorable, a UUID is not,
and `admin/[slug]` already works this way. Each page segment resolves slug →
tenantId server-side (`tenantIdForSlug` in
`apps/web/app/api/admin/[slug]/connectors/atlassian/route.ts` is the existing
one; lift it into a shared helper) and 404s on an unknown slug.

**`/api/mcp/*` keeps the tenantId.** Moving it to slug was considered and
dropped. `{base}/api/mcp/{tenantId}` is the OAuth issuer — it lives in the
discovery documents, the `next.config.ts` rewrites, and every MCP client that
has registered — so putting the org's mutable name inside it means a rename
invalidates that org's registrations, and a freed slug re-claimed by another
tenant would route an old issuer at somebody else's data. Keeping the UUID
costs nothing in practice: nobody types this URL, they copy it from a button on
the connectors page, where a UUID reads no worse than a slug.

So: readable identifier for humans, stable identifier for machines. Renaming an
org never touches a live connector, and slug allocation stays a display concern
rather than a security one.

| now                                             | proposed                                                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/app/tenant/[tenantId]/cards/page.tsx` | `/[slug]/home` — cards are a _component_ on the home page, not a page of their own                                         |
| `apps/web/app/tenant/[tenantId]/logs/page.tsx`  | `/[slug]/logs` — a real page, just needs the path updated                                                                  |
| —                                               | `/[slug]/connectors` — the user manages their own grants and their connectors' capabilities                                |
| `apps/web/app/admin/[slug]/*`                   | `/[slug]/admin/*` — org-level setup: what employees may connect, org logs, etc. Roughly what `admin/` has today, relocated |
| `apps/web/app/mcp/[tenantId]/page.tsx`          | delete                                                                                                                     |

Home page is where the summary cards and their actions live. From home, surface
the other sections according to the signed-in user's role.

A top-level `/[slug]` catch-all sits next to real routes like
`/create-organization`, so reserve those words — a tenant must not be able to
claim the slug `api`, `admin`, or `create-organization`.

## Open questions

- Role model: what distinguishes a user who sees `/[slug]/connectors` from an
  operator who sees `/[slug]/admin`? `getOperatorSession` vs
  `getSessionFromCookies` is the current split.
- Existing pages are a mix of Tailwind classes and inline `style` objects with
  hardcoded light-mode colors (`#666`, `#ddd`, `#f7f7f7`). The dark-mode pass
  means converting those.

## WebEx: two integrations, deliberately

Built after the shell work. WebEx participation comes in two shapes that share
nothing but the brand:

1. **The org bot** (`webex` connector) — ambient ingestion. Invited to spaces,
   fires webhooks on @mentions (all messages in 1:1), classifier turns issue
   reports into cards. Forward a message to the bot's DM to capture it by hand.
2. **The user grant** (`webex-user` connector) — "Renkei reads WebEx as me."
   An Integration from developer.webex.com (client id/secret in admin
   connectors), each user connects on the Connectors page, grant rows live in
   provider_grants like Jira. MCP tools register per-user when the grant
   exists: webex_list_rooms, webex_list_messages, webex_get_message,
   webex_capture_message (→ card feed, human decides). Read-only scopes;
   nothing posts to WebEx as the user.

The shared OAuth callback dispatches on a provider column added to
pending_oidc_signin (migration 020); null means Atlassian.
