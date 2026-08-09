# Granular scopes for the full Renkei tool surface

Derived from the vendored OpenAPI specs — every endpoint the MCP tools call,
matched to its operation — then **curated to the primary scopes**: the scope
naming the thing each tool actually operates on. The specs' per-operation
lists also carry a long tail of response-facet scopes (vote counts, avatars,
changelogs, entity properties, field configuration metadata); requesting all
of them made the authorize URL long enough that Atlassian's CDN answered
414 once the login/consent redirect chain re-encoded it. The trimmed scopes
are listed at the bottom — if a specific tool answers 401 "scope does not
match", the `tokenClaims` log line names what the token carries, and the one
missing scope gets added back to its bundle.

In the developer console (Permissions tab), each block below is added under
its own API. The authorize URL then carries the union of the checked
bundles, plus `offline_access` (not a Permissions-page scope — request-time
only, it yields the refresh token). Full union: 63 scopes, ~1.9k chars raw —
sized to survive the redirect chain.

## Jira API

```
read:attachment:jira
read:comment:jira
read:field:jira
read:filter:jira
read:group:jira
read:issue-details:jira
read:issue-link-type:jira
read:issue-meta:jira
read:issue-type:jira
read:issue-worklog:jira
read:issue.transition:jira
read:issue:jira
read:jql:jira
read:project-version:jira
read:project.component:jira
read:project:jira
read:status:jira
read:user:jira
write:attachment:jira
write:comment:jira
write:filter:jira
write:issue-link:jira
write:issue-worklog:jira
write:issue.time-tracking:jira
write:issue:jira
write:project-version:jira
write:project.component:jira
delete:comment:jira
delete:filter:jira
delete:issue-link:jira
delete:issue-worklog:jira
delete:issue:jira
delete:project.component:jira
```

## Jira Software API

```
read:board-scope:jira-software
read:issue:jira-software
read:sprint:jira-software
write:board-scope:jira-software
write:sprint:jira-software
```

## Jira Service Management API

```
read:customer:jira-service-management
read:request.approval:jira-service-management
read:request.comment:jira-service-management
read:request.participant:jira-service-management
read:request.sla:jira-service-management
read:request.status:jira-service-management
read:request:jira-service-management
read:requesttype:jira-service-management
read:servicedesk.customer:jira-service-management
read:servicedesk:jira-service-management
write:customer:jira-service-management
write:request.attachment:jira-service-management
write:request.comment:jira-service-management
write:request.participant:jira-service-management
write:request.status:jira-service-management
write:request:jira-service-management
write:servicedesk.customer:jira-service-management
delete:request.participant:jira-service-management
delete:servicedesk.customer:jira-service-management
```

## Jira Service Management Ops API

```
read:ops-alert:jira-service-management
write:ops-alert:jira-service-management
read:ops-config:jira-service-management
write:ops-config:jira-service-management
delete:ops-config:jira-service-management
```

## Request-time only (not on the Permissions page)

```
offline_access
```

## Trimmed response-facet scopes (re-add one if a tool 401s)

Dropped from the spec-derived union to keep the authorize URL under the CDN's
nested-redirect limit — each names a response facet, not anything a tool
operates on: `read:application-role:jira`, `read:audit-log:jira`,
`read:avatar:jira`, `read:comment.property:jira`,
`read:field-configuration:jira`, `read:field.default-value:jira`,
`read:field.option:jira`, `read:issue-security-level:jira`,
`read:issue-type-hierarchy:jira`, `read:issue-worklog.property:jira`,
`read:issue.changelog:jira`, `read:issue.vote:jira`,
`read:project-category:jira`, `read:project-role:jira`,
`read:user.property:jira`, `write:comment.property:jira`,
`write:issue-worklog.property:jira`, `write:issue.property:jira`,
`delete:comment.property:jira`, `delete:issue-worklog.property:jira`,
`read:request.attachment:jira-service-management`.

## Dropped from the old classic set

- `read:me`, `read:account` (User Identity API) — nothing calls
  `api.atlassian.com/me`; user identity comes from `/rest/api/3/myself`
  (covered by `read:user:jira`) and token claims.
- `read:jira-work`, `write:jira-work`, `read:jira-user`,
  `read:servicedesk-request`, `write:servicedesk-request` — the classic
  scopes this list replaces.
