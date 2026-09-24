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

## Group membership: additive verbs, not a replace-the-list PATCH

The vendor's `PATCH /api/v2/users` accepts a `memberOf` attribute as a
semicolon-separated list in the same `data.attributes` bag used for every
other field, and the sample payloads in the vendor's own Postman
collection don't make it unambiguous whether that list *replaces* the
user's full group membership or *adds* to it. For a security connector,
guessing wrong in the replace direction would silently strip a user out
of every group they were not explicitly re-listed in — the worst failure
mode this connector could have.

So group changes route through the **explicit, unambiguous v1 endpoints**
instead: `POST /api/v1/user/addUsersToGroups` and
`POST /api/v1/user/removeUsersFromGroups`, each taking `userNames` and
`groupNames` arrays. These are additive/subtractive by construction —
there is nothing to misinterpret. `admanager_update_user` (attribute
edits) explicitly never touches `memberOf`; group membership only ever
moves through `admanager_add_user_to_groups`,
`admanager_remove_user_from_groups`, and
`admanager_copy_group_membership` (below).

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

## An open assumption: the create/update attribute payload shape

ManageEngine's own published v2 Postman collection (dropped in verbatim
as
[`admanager-plus-rest-api-v2-postman-collection.json`](./admanager-plus-rest-api-v2-postman-collection.json))
does not include a worked "Create AD Users" example — only List and
Update for the Users group. The wrapper shape used here for
`admanager_create_user` —

```json
{
  "template": { "template_name": "..." },
  "data": [{ "attributes": { "sAMAccountName": "...", "...": "..." } }]
}
```

— is inferred from two confirmed siblings in the same collection: Create
AD Computers (`template` + `data: [{ attributes }]`, an array to support
bulk creation) and Update AD Users (`template` + `data: { attributes }`,
singular). Attribute keys are the LDAP attribute names in camelCase, the
same convention the Update Users and Create Computers samples both use
(`sAMAccountName`, `memberOf`, `co`, `manager`, `employeeID`, `OUName`,
`extensionAttribute1`, `accountNameHistory`, …) rather than the "Column
Name" vocabulary from the filtering/response-columns reference (those
names — `FIRST_NAME`, `SAM_ACCOUNT_NAME` — are for `filter`/`fields`/
`sort` query parameters only, per that doc's own note, never for a
request body). The initial `password` (and `enabled`) stay as fields
alongside `attributes` rather than folded into it, following the older
V1 API reference's explicit `POST /api/v2/users` body — a plain
`password` field is far more plausible for an admin API to expose than
routing a password through `unicodePwd`'s UTF‑16LE/quoted encoding as a
generic AD attribute, and it matches the pattern of `template` also
sitting beside `attributes`, not inside it.

**This is a documented inference, not a confirmed contract.** Whoever
turns this on against a real ADManager Plus instance should verify
`admanager_create_user`/`admanager_update_user` against that instance's
own REST API documentation (Admin → System Settings → Integrations →
REST API → Documentation, per the companion guide) before relying on it,
and fix `packages/connector-admanager/src/api.ts`'s
`buildCreateUserPayload`/`buildUpdateUserPayload` if the real shape
differs. Unlock, reset password, and the group-membership endpoints
carry no such uncertainty — they are documented explicitly, with worked
examples, in the source material.

## The dedicated worker process, and why it's simpler than Mirth's

ADManager Plus is on-prem, so the same SSRF-guard reasoning as OnBase,
Mirth and file shares applies: all HTTP happens in
**`apps/worker-admanager`**, a dedicated egress process on its own image
(`renkei-admanager`), behind a bearer key
(`ADMANAGER_WORKER_API_KEY`). Unlike Mirth's worker, there is:

- **no session/cookie jar** (`sessions.ts`) — the authtoken IS the
  credential on every request, so `forward()` just sets the
  `Authorization` header and dials;
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
