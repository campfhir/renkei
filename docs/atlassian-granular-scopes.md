# Granular scopes for the full Renkei tool surface

Derived from the vendored OpenAPI specs — every endpoint the MCP tools call,
matched to its operation — then **curated to the primary scopes**: the scope
naming the thing each tool actually operates on. Lines marked `# trimmed:`
are the rest of the spec-derived union: response-facet scopes (vote counts,
avatars, changelogs, entity properties, field configuration metadata) that
no tool operates on. Requesting all of them made the authorize URL long
enough that Atlassian's CDN answered 414 once the login/consent redirect
chain re-encoded it, so they are not requested — but they may stay
registered on the app harmlessly. If a specific tool answers 401 "scope
does not match", the `tokenClaims` log line names what the token carries,
and the one missing scope moves back into its bundle (a catalog + doc
change only).

In the developer console (Permissions tab), each block below is added under
its own API — all four APIs must be present. The authorize URL then carries
the union of the checked bundles, plus `offline_access` (not a
Permissions-page scope — request-time only, it yields the refresh token).
Full requested union: 66 scopes, ~2.0k chars raw — sized to survive the
redirect chain.

## Jira API

```
# trimmed: read:application-role:jira
read:attachment:jira
# trimmed: read:audit-log:jira
# trimmed: read:avatar:jira
# trimmed: read:comment.property:jira
read:comment:jira
read:field-configuration:jira
read:field.default-value:jira
read:field.option:jira
read:field:jira
read:filter:jira
read:group:jira
read:issue-details:jira
read:issue-link-type:jira
read:issue-meta:jira
# trimmed: read:issue-security-level:jira
# trimmed: read:issue-type-hierarchy:jira
read:issue-type:jira
# trimmed: read:issue-worklog.property:jira
read:issue-worklog:jira
# trimmed: read:issue.changelog:jira
read:issue.transition:jira
# trimmed: read:issue.vote:jira
read:issue:jira
read:jql:jira
# trimmed: read:project-category:jira
# trimmed: read:project-role:jira
read:project-version:jira
read:project.component:jira
read:project:jira
read:status:jira
# trimmed: read:user.property:jira
read:user:jira
write:attachment:jira
# trimmed: write:comment.property:jira
write:comment:jira
write:filter:jira
write:issue-link:jira
# trimmed: write:issue-worklog.property:jira
write:issue-worklog:jira
# trimmed: write:issue.property:jira
write:issue.time-tracking:jira
write:issue:jira
write:project-version:jira
write:project.component:jira
# trimmed: delete:comment.property:jira
delete:comment:jira
delete:filter:jira
delete:issue-link:jira
# trimmed: delete:issue-worklog.property:jira
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
# trimmed: read:request.attachment:jira-service-management
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

## Dropped from the old classic set

- `read:me`, `read:account` (User Identity API) — nothing calls
  `api.atlassian.com/me`; user identity comes from `/rest/api/3/myself`
  (covered by `read:user:jira`) and token claims.
- `read:jira-work`, `write:jira-work`, `read:jira-user`,
  `read:servicedesk-request`, `write:servicedesk-request` — the classic
  scopes this list replaces.
