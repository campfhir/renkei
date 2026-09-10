# Connector catalog, connector definitions, and audiences — design

Written alongside the change that built it. Supersedes the "Groups" section of
[`connector-access-control-design.md`](./connector-access-control-design.md);
that document's load-bearing rules — enforce in the projection, fail closed,
the test that matters — are kept and referenced below.

## The problem

Eighteen connectors and two screens that had not kept up:

- `/[slug]/connectors` rendered every org-enabled connector for every
  person. Somebody in insurance saw Bitbucket; nobody could search.
- `/[slug]/admin/connectors` was one 2 500-line scroll of twelve forms.
  Reaching one meant scrolling past eleven; adding a connector meant a dozen
  hand-edited touchpoints with nothing to say which had been forgotten.
- There was no way to say "this connector is for the service desk".

Three things, in order, on one branch: a personal catalog, an admin catalog
with one definition per connector, and audience rules keyed on IdP group
claims.

## 1. The personal catalog

**Entries are products, not suites.** People search for "Confluence", not
"Atlassian". `CONNECTOR_CATALOG` (`apps/web/lib/connector-catalog.ts`) gained
a category, search synonyms (`keywords`: what somebody types when they do not
know the product name — "email", "tickets"), the suite card that hosts the
product, the grant providers that mean "connected", and whether a person adds
it themselves. Renkei's own surfaces (cards, agents, logs, memory, knowledge,
web search, the sandbox, batch jobs) are `userConnectable: false`: they are
provisioned org-wide, and offering them in a personal catalog would be a
choice with nothing behind it.

**"Added" is a preference in `user_preferences`, not a table.** Key
`connectors`, value `{ added: string[] }` of capability keys, through
`@renkei/user-prefs` with the same cache and `fresh` discipline as the
notification preferences. Nothing new is stored and nothing new is migrated.

**Shown = added ∪ connected.** A connection made before the catalog existed
keeps its card without anyone pressing "add" — that is the whole migration
story for existing users. `lib/connectors/user-catalog.ts` answers the page's
three questions separately: what this person MAY add (org-enabled, not
switched off, in their audience), what they HAVE connected, and what to SHOW.

**"Added" never touches tool registration.** Whether a tool registers is
provisioning plus org policy, in the capability projection. A page
preference must not be able to widen or narrow that, in either direction: a
person who connected Jira without ever pressing "add" keeps `jira_*`, and a
person who added Zoom without connecting it gets nothing. Adding a fourth
signal to the projection would also have meant a fourth table in the
tool-surface version and a state where a live grant registers nothing
because a preference row is missing.

**Remove is offered only under a product with nothing connected.** A
connected card has Disconnect. Hiding a card over a live grant is precisely
the "looks off, isn't" trap the access-control design warns about — the page
must never show less than the MCP endpoint can do. Disconnecting does not
un-add: the card stays, not connected, with Remove now available.

## 2. Connector definitions and the admin catalog

`lib/connectors/definitions.tsx` binds each `connector_configs` key to the
form that edits it. The catalog stays pure data (chat, agents and usage
import it anywhere); the definitions import the forms and are what the admin
pages read. The forms are client components; the definitions are server
data, so the module carries no `'use client'` — that directive would turn
the array into a client reference the page could not iterate.

The admin page is a list — searchable, grouped, one row per config key with
status pills and org-wide switches — and each connector has a page of its
own at `/admin/connectors/<configKey>`, an address somebody can be sent. The
switches stay on the list row because they answer a different question from
the form: the form is provisioning, the switch is "stop offering this now,
touching nobody's connection".

**What the tests enforce**, because this is what a person forgets:

- every capability key the registry can mount is in the catalog
  (`REGISTERED_CONNECTOR_KEYS` in `registry.ts`, read by
  `registry-keys.test.ts`) — this is the test that caught WebEx gated under
  its CONFIG key (`webex-user`) while the catalog and the off switch said
  `webex`, so disabling WebEx had silently done nothing;
- every catalog tool prefix maps back to its key through `connectorKeyForTool`;
- every admin API route has a catalog entry and a bound form, and every form
  file is referenced;
- every catalog mark exists on disk.

Moving tool registration itself into definitions (a true plugin) is out of
scope; the definition layer is the seam for it.

## 3. Audiences by IdP group claims

The earlier design recommended Renkei-local groups because the OIDC config
read one claim and mapped it to two values. The org chose IdP claims: groups
already exist at the IdP, and a second membership list in Renkei would drift.

**Recording.** `tenant_oidc.groups_claim` names the id_token claim (NULL is
the conventional `groups`; separate from `role_claim` because Entra puts app
roles and directory groups in different claims). `identities.idp_groups`
holds the raw values the claim carried at the person's LAST sign-in,
replaced wholesale each time, so a group the IdP took away is gone with the
next session. On `identities` rather than in its own table because the
audience question is asked per subject on every MCP connection and
`identities.updated_at` already feeds the tool-surface version. No extra
OAuth scope is requested: `groups` is not a standard scope, and IdPs emit the
claim per app registration (Entra) or claim mapping (Okta, Keycloak).

**Rules.** `OrgSettings.connectorAudiences`: capability key → the group
values a person must carry, any one of them. Absent or empty means everyone.
In `tenant_settings` rather than a table of its own so it rides the same
cache, invalidation and tool-surface version as `disabledConnectors`.

**Enforcement is the fifth gate of the capability projection.**
`OrgCapabilityPolicy.restrictedConnectors` (required, so a policy cannot be
built without knowing the gate exists) and
`UserCapabilitySelection.allowedConnectors` (optional; omitted means outside
every audience). `lib/connectors/audience.ts` resolves a subject's share
from recorded identity — never from a token, because agent-run tokens carry
no roles and a stale token must not widen anything. Both projection sites go
through one `buildProjection` (`lib/mcp-tools/projection.ts`), and the
connectors page reads the same resolution, so what it offers and what
`tools/list` serves cannot disagree. Fixing that drift is also where the tool
catalog started honouring roles.

**Fail closed.** Unreadable rules or identity close every restricted
connector (unreadable rules close every connector, since none can be assumed
unrestricted). Entra's groups overage — the claim omitted past ~200 groups,
`_claim_names` pointing at Graph — is logged by subject at sign-in; that
person has no groups on record and audience-scoped connectors are closed to
them. The admin hint and the person page (People → subject → Groups) make it
visible; the fix is at the IdP (app roles, or a group filter on the claim).

**Cache story.** Rules change → `tenant_settings.updated_at` moves the
tool-surface version tenant-wide, and the audience route invalidates the
tool catalog. A person's groups change → their next sign-in bumps
`identities.updated_at`, which moves their own version. The 60-second
settings cache bounds cross-replica lag, as it does for every other org
setting.

**The test that matters** is in `capability-gate.test.ts`: a caller outside a
restricted connector's audience gets none of its tools registered; one
inside gets all of them.
