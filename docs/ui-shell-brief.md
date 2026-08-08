# UI shell brief — app nav, routing, and connector self-service

Working brief, captured so the conversation can be picked up from another
device. Nothing here is built yet. The one thing already done is the SWC fix in
`docker/Dockerfile` (see the commit this file arrived in).

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

**`/api/mcp/*` moves to slug as well.** That URL is the artifact a user copies
into their LLM app, so `…/api/mcp/acme/http` beats `…/api/mcp/9f3c1e70-…/http`
for every user, every time — against a rename cost paid rarely by one org. The
fresh database makes the switch free: `oauth_clients` is empty, so no
registration is invalidated by moving it now.

`{base}/api/mcp/{slug}` therefore becomes the OAuth issuer, in the discovery
documents and the `next.config.ts` rewrites. Each route resolves the segment to
`tenants.id` once at the top and uses the UUID for every query below that — the
segment is a lookup key, not the internal identity.

**The rule that has to come with it: retired slugs are tombstoned, never
re-claimable.** Without that, an org renaming `acme` → `acme-corp` frees `acme`
for someone else, and an MCP client still holding the old issuer resolves to a
_different tenant_. That is cross-tenant access, not mere breakage. Enforce it
in whatever creates and renames a tenant, alongside the reserved-word check
below. Renaming still invalidates that org's own registrations — clients must
re-register — so the rename UI should say so.

Routes affected (each currently does `where('id', '=', tenantId)` on the raw
segment): `.well-known/oauth-authorization-server`,
`.well-known/oauth-protected-resource`, `[transport]`, `authorize`, `grant`,
`oauth/authorize`, `oauth/register`, `oauth/token`, `status`.

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
claim the slug `api`, `admin`, or `create-organization`. Same list, same place
in the code as the tombstone check above.

## Open questions

- Role model: what distinguishes a user who sees `/[slug]/connectors` from an
  operator who sees `/[slug]/admin`? `getOperatorSession` vs
  `getSessionFromCookies` is the current split.
- Existing pages are a mix of Tailwind classes and inline `style` objects with
  hardcoded light-mode colors (`#666`, `#ddd`, `#f7f7f7`). The dark-mode pass
  means converting those.
