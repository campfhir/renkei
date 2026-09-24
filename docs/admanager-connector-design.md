# ADManager Plus connector — decision log

Shipped alongside the code; this records the decisions and their reasons,
the way `mirth-connector-design.md` and `fileshares-connector-design.md`
do. The as-built reference is the `connector-admanager` section of
[`connectors.md`](./connectors.md). Source material:
[`admanager-plus-rest-api-reference.md`](./admanager-plus-rest-api-reference.md),
[`admanager-plus-filtering-and-columns.md`](./admanager-plus-filtering-and-columns.md)
and the vendor's own Postman export,
[`admanager-plus-rest-api-v2-postman-collection.json`](./admanager-plus-rest-api-v2-postman-collection.json).

## What it is

A connector for ManageEngine ADManager Plus (on-prem Active Directory
management) scoped to **desktop/service-desk technician actions**, not
the whole product: account unlock, password reset, create/edit a user
account (optionally from an ADManager Plus template), and security-group
membership changes (add, remove, or copy another user's groups onto a
target). Left out on purpose, per the request that started this: computer,
contact and OU management, orchestrations, admin settings, domain
management, and bulk/workflow requests. Any of those is a later addition
to the same package, not a different shape.

## The model: N instances, each person their own ADManager Plus authtoken

Same shape as `connector-mirth`, for the same reasons (see that design
doc's "N instances" section) — an org may run more than one ADManager
Plus instance (per domain, per site, or a separate test instance), it is
on-prem, and it has a real per-technician auth model already:

- `admanager_instances` — what an operator registers: name, an
  environment label, the server's base URL, TLS policy (verify / pinned
  CA / explicit allow-insecure-http, the OnBase/Mirth discipline).
- `admanager_instance_connections` — one row per (instance, person): that
  person's own ADManager Plus **authtoken** (see "Auth: a bearer
  authtoken, not a session" below), sealed under `TOKEN_ENCRYPTION_KEY`,
  a **self-reported technician name** for display (ADManager Plus's REST
  API has no verified "who am I" endpoint the way Mirth's login response
  echoes the username, so the person types their own technician name when
  connecting — `test-connection` still validates the authtoken itself
  live, against the real server, before anything is stored), and their
  **named permissions** for the LLM tools on that instance —
  the same `permissions text[]` shape `connector-mirth` settled on after
  its own read/write/destructive ladder proved too coarse (migration
  107's reasoning applies here from the start, so this connector never
  carries the ladder at all).

ADManager Plus's own authtoken already carries a **scope** (`user:read`,
`user:modify`, `group:modify`, …, see the reference doc's "Scopes"
table) that a technician's authtoken can be limited to when it is
generated. Renkei's permissions narrow what the *tools* may attempt with
a credential the person already holds; ADManager Plus's own scope on that
authtoken, and the technician's own delegated rights inside ADManager
Plus, are the actual authority on every request — RENKEI.md Decision #2
again. A permission ticked here that the authtoken's scope does not cover
simply gets a 401/403 back from ADManager Plus, phrased for the model the
same way an unconfigured Mirth permission is.

## Auth: a bearer authtoken, not a session

Unlike Mirth (a username/password login that establishes a server-side
session), ADManager Plus's REST API takes the authtoken directly as the
`Authorization` header on every request — no login call, no cookie, no
session to hold or expire. This is simpler than Mirth in one real way:
**the worker is stateless** — there is no `sessions.ts`, no cookie jar, no
login-retry-on-401 dance. Every `api` call just decrypts the stored
authtoken and forwards it as the `Authorization` header.

`AdManagerCredentials` is therefore `{ authToken: string }`, not a
username/password pair; `credentials.ts` mirrors Mirth's shape (parse /
encrypt / decrypt, fail closed on a malformed stored value) with one
field instead of two.

## Permissions: named, matching the four requested capabilities plus read

| Permission             | What it lets the tools attempt                                             |
| ----------------------- | ---------------------------------------------------------------------- |
| `accounts.read`         | Look up a user's attributes, account status and group membership; search users by name/department/etc. Needed before every write below, to resolve who is being acted on and preview it. |
| `accounts.unlock`       | Unlock a locked-out account.                                            |
| `accounts.reset_password` | Reset a user's password (with an optional "must change at next logon" flag). |
| `accounts.create`       | Create a new user account, optionally from an ADManager Plus template. |
| `accounts.edit`         | Update an existing user's attributes (department, title, phone, manager, description, …), optionally reapplying a template. |
| `groups.modify`         | Add or remove security-group membership, or copy another user's group memberships onto a target. |

Presets on the connect card: **Read only** (`accounts.read`),
**Helpdesk** (read + unlock + reset password — the two highest-volume
service-desk asks), **Provisioning** (read + create + edit +
groups.modify), **Everything** (all six). Default for a new connection is
read-only, the same conservative default `connector-mirth` chose.

There is no separate "destructive" tier the way Mirth has one for
permanent operations (delete a channel, restore the server…) — nothing
this connector exposes is a delete. Every write is instead **always**
preview + confirm regardless of which permission gates it (see next
section), so the extra tier would add a second gate over the same ground
without changing what it protects.

## Every write is preview + confirm, not just the permanent ones

`connector-mirth` reserves the shared issue-preview card for operations
that are *permanent* (a DELETE, a purge, a server restore). Everything
this connector does is nominally reversible in AD terms — a password can
be reset again, a lockout re-triggers, a group can be re-added — so
strictly following that rule would make every write here an ordinary
tool call with no human checkpoint.

That was deliberately widened for this connector: **every** write tool
(unlock, reset password, create, edit, add/remove groups, copy group
membership) previews on the card before it runs, whatever permission
gates it. Reasoning:

- These are identity and access actions against a real employee's
  account, sourced from a chat turn a model composed. A wrong target
  (`jdoe` vs `jdoe2`), a wrong group (`Finance-ReadOnly` vs
  `Finance-Admin`), or a generated password that never reaches the right
  person are exactly the kind of mistake a model makes with total
  fluency and no signal that anything is wrong.
- Unlike a Mirth channel edit, there is no version history or audit diff
  in ADManager Plus's UI that makes an AI-driven change easy for a human
  to notice and roll back after the fact — the service desk finds out
  when the wrong person calls in confused.
- The action volume here is inherently low (a technician handling one
  ticket at a time), so the friction cost of a confirm click is small
  compared to Mirth's channel/message operations, where requiring
  confirmation on every reversible write would make the bulk tooling
  unusable.

The card itself is purpose-built rather than the reused issue-preview
card (`apps/web/lib/mcp-widgets/src/directory-action-preview.ts`, bound
via `_meta.ui.resourceUri`): an AD account action centers on a person's
identity, not a work item, so the card leads with a named avatar row,
shows a generated password or new-hire credential plainly with a Copy
button rather than hiding it, and renders group membership as add/remove
pill lists instead of a diff string.

## Group membership: two dedicated attribute keys, not a replace-the-list PATCH

Group changes go through `PATCH /api/v2/users`, targeting the account
with the same `domain`/`filter` query pair `admanager_update_user` uses
(`filterClause('SAM_ACCOUNT_NAME', 'eq', samAccountName)`), and a
**required** `template.template_name` in the body — confirmed directly
by an operator running this connector against a live server: ADManager
Plus's real `PATCH /api/v2/users` rejects a create or modify without one,
so `templateName` is a mandatory argument on `admanager_create_user`,
`admanager_update_user`, `admanager_add_user_to_groups`, and
`admanager_remove_user_from_groups` — never optional, unlike this doc's
earlier guess. What resolves the original ambiguity here — does a
`memberOf` PATCH replace the list or add to it? — is a confirmed-working
reference implementation seen running the same API against a real
ADManager Plus server: `data.attributes.memberOf` (a semicolon-joined
group-name list) is **additive**, and the vendor's **dedicated key**
`data.attributes.removememberOf` is how a targeted removal is done
safely — never by re-PATCHing `memberOf` with a shorter list. Renkei's
`admanager_add_user_to_groups`/`admanager_remove_user_from_groups` send
exactly those two keys and nothing else touches `memberOf`;
`admanager_update_user` (attribute edits) explicitly never sets it.
Group membership only ever moves through `admanager_add_user_to_groups`,
`admanager_remove_user_from_groups`, and
`admanager_copy_group_membership` (below).

A `PATCH /api/v2/users` (group or attribute) answers HTTP 200 even on a
logical rejection — the body carries either a request-level
`{IAM_ERROR_STATUS: true, eSTATUS}` envelope or a per-item array whose
`status.status_code` must be `1`; `interpretV2PatchResponse` in the tool
layer is what actually decides success, not the HTTP status.

**Copying group membership** ("give this new hire the same access as
their teammate") reads the source user's `MEMBER_OF` (a list of group
DNs), extracts each group's CN, diffs out any the target already holds,
and calls `addUsersToGroups` with the remainder — a pure merge. It never
removes a group the target already had that the source user doesn't
have; "copy" here means "grant what they're missing," matching how this
request is actually used at a service desk (clone access, don't
narrow it).

`packages/connector-admanager/src/groups.ts` holds the pure, dependency-
free list diffing (`parseGroupDns`, `groupsToAdd`) so it is unit-tested
without a server.

## Two API generations, and which endpoints actually carry each write

The vendor doc ingested into this repo
([`admanager-plus-rest-api-reference.md`](./admanager-plus-rest-api-reference.md))
describes a single, uniformly `/api/v2/*`-shaped REST API — including
`/api/v1/user/unlockUserAccount`, `/api/v1/user/resetPassword`,
`/api/v1/user/addUsersToGroups` and `/api/v1/user/removeUsersFromGroups`
paths for the "v1" operations. **Those paths do not exist on real,
currently-deployed ADManager Plus servers.** This was discovered by
diffing Renkei's connector against a separate, unrelated codebase
confirmed to be driving ADManager Plus successfully in production today:
the real server exposes two distinct, older generations —

- **`/api/v2/*`** — JSON request/response bodies, a bearer `Authorization`
  header, SCIM-style `filter` query params, `PATCH`-based updates
  (`template.template_name` + `data.attributes`). `admanager_get_user`,
  `admanager_search_users`, `admanager_update_user`, and the group tools
  (see above) all live here, and always did.
- **`/RestAPI/*`** (legacy, query-param-driven, no request body) — every
  other write: `POST /RestAPI/UnlockUser`, `POST /RestAPI/ResetPwd`,
  `POST /RestAPI/CreateUser`, `POST /RestAPI/ModifyUser`, `POST
  /RestAPI/DisableUser`/`EnableUser`. Every argument travels as a query
  parameter — an `inputFormat` key holding a JSON-stringified array of
  one object per account acted on — and the response is either that same
  array shape (per-account `status`/`statusMessage`) on success or a
  single `{SEVERITY, STATUS_MESSAGE, ERROR_CODE}` envelope on a
  request-level failure. `apps/web/lib/mcp-tools/admanager/index.ts`'s
  `interpretV1Response` is what actually decides success — like the v2
  PATCH endpoints, these answer HTTP 200 even on a logical rejection.

`/RestAPI/*` authenticates differently, too: `AuthToken` and
`PRODUCT_NAME` (default `'Renkei'`, `ADMANAGER_PRODUCT_NAME` overrides
it) sent as BOTH request headers and query parameters — never the
`Authorization` header `/api/v2/*` uses. `apps/worker-admanager/src/server.ts`'s
`forward()` branches on the path (`isLegacyRestPath`, `/RestAPI/`
prefix) to inject the right shape; the web/tool layer never sees the
decrypted authtoken either way, so this branching has to live in the
worker.

Password reset is a two-step flow because `ResetPwd` cannot itself force
"must change password at next logon" — `admanager_reset_password` calls
`POST /RestAPI/ResetPwd` to set the password, then, when
`mustChangePassword` is true, calls `POST /RestAPI/ModifyUser` applying a
caller-supplied `resetPasswordTemplateName` template, which is what
actually toggles `pwdLastSet`. There is no way to force that flag without
a template, so the tool refuses up front rather than silently resetting
the password without forcing a change.

`ModifyUser` targets the account by whatever identifying field the
instance's template is keyed on — it is not hardcoded to any one AD
attribute. The confirmed-working reference this connector was diffed
against keys on `EMPLOYEE_ID` specifically because that org shares that
identifier between AD and its HRIS (Paycom) and uses it as the join key
across both systems — an organization-specific choice, not an API
requirement (an operator running this connector confirmed `sAMAccountName`
works too, as would email). Renkei has no such cross-system identifier to
share, so `admanager_reset_password` targets `ModifyUser` by
`sAMAccountName`, the identifier every tool here already keys on.

`admanager_create_user`'s `createUserBody` sends a flat object (no
`template`/`data.attributes` v2 wrapper — the legacy `CreateUser` input
format doesn't have one) as one `inputFormat` array entry, always
including `templateName`; success is a JSONArray whose first entry has
`status: "SUCCESS"`, matching the confirmed reference exactly. What
remains unconfirmed is the exact set of extra attribute keys `CreateUser`
accepts beyond the ones sent here — and there is no ADManager Plus API to
introspect which fields a given template supports, so extending
`admanager_create_user`/`admanager_update_user` to cover more fields can
only be done by trial against a real instance and that instance's own
template configuration, field by field, not by reading a spec.

**The `GET /api/v2/users` `fields` column vocabulary is narrower than
guessed, too.** A real deployment answered `admanager_get_user` with
`400 {"CODE":"00000100","DETAIL":"SOME COLUMNS SPECIFIED IN THE FIELDS
PARAMETER ARE INVALID."}`. Renkei's original `USER_FIELDS` included
`TELEPHONE_NUMBER` and `DESCRIPTION`; neither appears in the
confirmed-working reference's `V2UserRecord` type (the real server's own
full default response shape), while every other requested column does —
so both were dropped from `USER_FIELDS` and from
`admanager_update_user_preview`'s existing-value lookup. This is the read
side only: `EDITABLE_FIELDS`' `telephoneNumber`/`description` PATCH
attribute keys are a different vocabulary (lowercase LDAP attribute
names, not `fields`/`filter` column names) and were left alone — a
technician can still set phone/description, the preview card's "old
value" for those two just shows `(none)` since it can no longer be looked
up. If an instance turns out to accept these as `fields` values after
all, this is safe to revert; there was no way to confirm short of trying
it against a live server.

`EMPLOYEE_ID` was added to `USER_FIELDS` alongside this — it's in the
confirmed reference's column vocabulary, and useful on `admanager_get_user`
precisely because it's populated only on accounts AD tracks as an actual
employee record: a service account or shared mailbox won't have one, and
`formatUser`'s blank-value filter already omits the line when it's empty,
so the distinction shows up for free.

**Query values with a space need `%20`, not `+`.** The worker's
`withQuery()` originally built query strings with `URLSearchParams`
alone, which serializes as `application/x-www-form-urlencoded` — spaces
become `+`. A confirmed production caller of this same API instead builds
its query strings with the `qs` library, whose default (RFC 3986)
percent-encodes spaces as `%20`, and that caller's convention is the one
ADManager Plus's own parser actually expects. `withQuery()` now runs a
`+` → `%20` replace over `URLSearchParams`' output as a final step — safe
because URLSearchParams itself escapes any literal `+` in a value to
`%2B` first, so every bare `+` left in the encoded string is one it put
there to mean a space, never a real plus sign. Left as `+`, any value
with a space in it — a template name (`AD Update Template`), a filter
clause on a display name, a group name (`Finance ReadOnly`) — would have
reached ADManager Plus with literal plus signs instead of spaces.

## The dedicated worker process, and why it's simpler than Mirth's

ADManager Plus is on-prem, so the same SSRF-guard reasoning as OnBase,
Mirth and file shares applies: all HTTP happens in
**`apps/worker-admanager`**, a dedicated egress process on its own image
(`renkei-admanager`), behind a bearer key
(`ADMANAGER_WORKER_API_KEY`). Unlike Mirth's worker, there is:

- **no session/cookie jar** (`sessions.ts`) — the authtoken IS the
  credential on every request, so `forward()` just sets it and dials (as
  `Authorization` for `/api/v2/*`, or as `AuthToken`/`PRODUCT_NAME` for
  `/RestAPI/*` — see above);
- **no login/logout ops** — nothing to establish or tear down;
- **no retry-on-401-then-relogin loop** — a 401 here means the stored
  authtoken is bad (expired, revoked, wrong scope) and is forwarded to
  the caller as `login_failed`-equivalent (`bad_credentials`), same
  phrasing discipline as Mirth's `bad_credentials`/`login_failed` split,
  just without the retry that only made sense for a session.

Per-instance TLS policy (`tls_verify`, `ca_pem`, `allow_insecure_http`)
and the `node:https` dialer are otherwise a direct copy of Mirth's
`upstream.ts` — same reasoning, ADManager Plus ships behind whatever
certificate (often self-signed) an IT department set up, and `fetch`
still can't express per-request TLS policy.

`test-connection` (the connect flow's live validation, before anything is
stored) and `probe` (the admin form's unauthenticated reachability check)
both call `GET /api/v1/domain/listDomains` — it requires no domain/filter
parameters, and (per the vendor's own error-code table) answers 401 on a
missing/invalid token. `probe` treats 401 as reachable, the same "a 401
IS the healthy answer" logic Mirth's `/server/version` probe uses.

Its answer body is NOT assumed small, though — a large org's `listDomains`
has been observed streaming well past a few megabytes, and neither op
reads the body at all (both decide purely from the status line). Both
calls into `forward()` pass `readBody: false`, which tells the upstream
dialer to resolve as soon as the response headers arrive and abandon the
socket rather than buffer anything — so a big answer from an endpoint
that was expected to be small can never fail a reachability check that
was never going to look past `status`.

## What deliberately did not ship

- **Everything outside the four requested capabilities** — computers,
  contacts, OUs, domains, orchestration, admin settings, workflow
  requests. Nothing here was designed to make adding them hard later
  (the store/worker/credential shape is generic), but none of it is
  wired up.
- **A generic "issue any ADManager Plus request" tool** — same reasoning
  as Mirth: a handful of named, schema-validated tools beat one escape
  hatch.
- **Free-text AD attribute editing beyond the named fields
  `admanager_update_user` exposes** — the tool takes a fixed set of
  common fields (department, title, phone, email, description, manager,
  enabled) rather than an arbitrary attribute bag, so a technician (or a
  model) cannot accidentally set an attribute the UI has no field for.
- **Password generation policy** — when a technician doesn't supply a
  new password on `admanager_reset_password`/`admanager_create_user`,
  the tool generates one (a random 16-character string covering upper/
  lower/digit/symbol) and returns it on the confirmation result so it can
  be relayed to the employee; it does not attempt to read or honor
  ADManager Plus's own configured password policy (length/complexity
  rules an org may have set there), which is a gap worth closing before
  relying on this for orgs with an unusual policy.
