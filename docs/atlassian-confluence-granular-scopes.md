# Granular scopes for the Confluence connector — a THIRD Atlassian app

Backs the `atlassian-confluence` connector, its own OAuth 2.0 (3LO) app
registration (dedicated client id/secret, own consent, own grant) —
separate from the `atlassian` (Jira) and `atlassian-jsm` apps. Confluence
is a different product with its own gateway path
(`api.atlassian.com/ex/confluence/{cloudId}/wiki/...`), not the same
site's API the way JSM is, so there's no cross-family scope sharing here
the way `read:user:jira` rides both existing apps.

**Provenance differs from the other two apps' docs.** `atlassian-granular-
scopes.md` was derived from vendored OpenAPI specs, endpoint by endpoint —
the gold standard, because Atlassian enforces the _complete_ documented
scope list per endpoint and a missing one 401s. This list was instead
compiled from Atlassian's public developer documentation (no Confluence
OpenAPI spec was vendored for this pass), and a handful of scope names
below are flagged `# UNVERIFIED` where two different doc pages disagreed
or a page didn't state the scope explicitly. Since this is a brand-new app
registration, the Atlassian developer console's own scope picker is the
authoritative source at setup time — cross-check every flagged line
against it before granting consent, the same way a wrong guess here
degrades safely (the connector falls back to its default scope set rather
than breaking) but shouldn't ship uncorrected if the console disagrees.

Only scopes an actual tool calls are listed — no speculative coverage
(the "authored-blind API surface" lesson: a scope nothing calls just
inflates the consent screen for no benefit).

## Confluence API — granular scopes

```
read:space:confluence
read:space.permission:confluence
read:page:confluence
read:blogpost:confluence
write:page:confluence
write:blogpost:confluence
delete:page:confluence
delete:blogpost:confluence
# UNVERIFIED: also seen documented as read:content.metadata:confluence — cross-check the console.
# Backs CQL search (v1 /wiki/rest/api/search) and user lookup (v1 /wiki/rest/api/search/user).
read:content-details:confluence
read:comment:confluence
write:comment:confluence
delete:comment:confluence
read:label:confluence
# UNVERIFIED: covers both add and remove — no separate delete:label scope was found documented.
write:label:confluence
read:attachment:confluence
# Covers the v1-only multipart upload endpoint too — granular scopes apply
# per-operation, not per-API-version.
write:attachment:confluence
delete:attachment:confluence
read:task:confluence
write:task:confluence
read:database:confluence
write:database:confluence
delete:database:confluence
read:whiteboard:confluence
write:whiteboard:confluence
delete:whiteboard:confluence
read:content.property:confluence
write:content.property:confluence
# UNVERIFIED whether this requires a Premium/Enterprise plan — the endpoint
# itself doesn't document a plan gate.
read:analytics.content:confluence
```

## Request-time only (not on the Permissions page)

```
offline_access
```

## Known API limitations these scopes back (see the connector's tool

descriptions for the user-facing version of each)

- `read:content-details:confluence` is the ONLY way to search — there is
  no v2 search endpoint at all, so `confluence_search` and
  `confluence_search_users` both call v1.
- `write:attachment:confluence` backs upload even though upload only
  exists on v1 (`POST /wiki/rest/api/content/{id}/child/attachment`) — v2
  attachments are read/delete only.
- `write:page:confluence` covers page `status` changes, but Confluence's
  v2 API silently no-ops on `status: 'archived'` (open bug,
  CONFCLOUD-72078) — the connector never offers `archived` as a settable
  value.
- `read:database:confluence`/`read:whiteboard:confluence` (and their
  write/delete counterparts) only ever reach metadata (title, space,
  parent, version) — there is no API for database rows/columns or
  whiteboard canvas content, full stop, not a scope gap.
- No scope here backs a "space analytics" capability, because no
  space-level analytics API exists — `read:analytics.content:confluence`
  only reaches per-page view/viewer counts (v1).

## Not requested, by choice

- `read:custom-content` / `write:custom-content`, `read:folder` /
  `write:folder`, `read:template` / `write:template`,
  `read:space-details:confluence` — no tool in this connector calls a
  custom-content, folder, or template endpoint.
- `write:space:confluence` — the connector only reads spaces
  (`confluence_list_spaces`, `confluence_get_space`); nothing creates or
  edits a space itself.
