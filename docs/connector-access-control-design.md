# Scoping connectors to people — design

No code yet.

## The problem

`connector_configs` is a per-tenant on/off switch. Enable Zoom and every user
in the org sees a Zoom card, gets Zoom tools on their MCP endpoint, and can be
offered Zoom steps in the agent builder — whether or not Zoom is anything to do
with their job. With seven connectors that is already noise; the list is
growing, and the connectors page has no way to say "this one is for the
service desk".

Wanted: an admin scopes a connector to named people or a group, and the
connectors page, the MCP tool registry and the capability gates all agree.

## The insertion point already exists

`packages/capability-registry` composes three gates by AND, each able only to
narrow:

```
org.readOnly           → no 'act' capability for anyone
org.disabledConnectors → connector off org-wide
org.disabledCapabilities
user.provisionedConnectors → the user linked an account
user.hiddenCapabilities    → the user chose to hide it
```

Connector audience is a **fourth narrowing gate**, and it belongs in
`OrgCapabilityPolicy` because it is the admin's envelope:

```ts
/** Connectors restricted to an audience; absent means "everyone". */
restrictedConnectors: readonly string[];
```

with the caller's allowed set resolved before the projection is built and
passed in `UserCapabilitySelection`. The `allows()` body gains one line, and
the existing invariant — _each gate can only narrow, never widen_ — is exactly
the property that makes this safe to add.

**This is the load-bearing detail: enforcement is in the projection, not in
the page.** A connector a user may not see must also not register its tools on
their MCP endpoint. Hiding the card while `registerRenkeiTools` still mounts
`zoom_*` gives an admin a restriction that a chat client walks straight
through — and it would look like it was working.

## Groups

There is no group concept in this codebase. Roles come from a single OIDC
claim mapped to exactly two values (`apps/web/app/api/auth/oidc/callback/route.ts`,
`roleClaim` → `renkei-operator` / `renkei-user`); there is no groups table and
no other claim is read.

**Recommendation: Renkei-local groups.** A migration adding

```
groups         (id, tenant_id, name, created_at)
group_members  (tenant_id, group_id, subject)
```

managed on the existing People page (`app/[slug]/admin/people`), which already
unions everyone in the org from identities, grant owners and agent owners.

Why local rather than IdP claims: the OIDC config carries exactly one claim
name today and maps it to two fixed values, so group claims would mean a
config change, an IdP change, and a mapping UI before the first group exists.
Local groups need none of that and are visible in the product. The IdP path
stays open — capture the raw claim values at sign-in as an import source
later, when someone actually wants it.

**Grant scoping**: `connector_grants (tenant_id, connector, subject | group_id)`,
where an empty set means everyone. Resolved per request, cached like
`readConnectorConfigCached` (60s), because it is read on every MCP connection.

## Surfaces

- `app/[slug]/admin/connectors` — each connector card gains an audience
  control: Everyone / these people / these groups. Management tabs group the
  cards, which is what makes a long list navigable.
- `app/[slug]/connectors` — a restricted connector simply does not render.
  The grid from the last change needs no work.
- `lib/mcp-tools/registry.ts` — already gated through `withCapabilityGate`;
  the projection change is enough.
- Agent builder tool picker — reads the same projection, so it follows.

## Failure direction to get right

Fail **closed**. An unreadable `connector_grants` row must mean "not allowed",
never "allowed" — a restriction that silently lapses when a query fails is
worse than no restriction, because nobody is watching for it. Note that this
is the opposite default from `readConnectorConfigCached`, whose failure
degrades to the connector being unavailable; here both directions happen to
land on "less access", which is the point.

## Test that matters most

Not the UI. A test that builds a projection for a user outside a restricted
connector's audience and asserts `registerRenkeiTools` mounts none of that
connector's tools — because that is the assertion which distinguishes a real
restriction from a hidden card.
