# Granular scopes for the full Renkei tool surface — TWO Atlassian apps

Derived from the vendored OpenAPI specs — every endpoint the MCP tools call,
matched to its operation. Atlassian enforces the COMPLETE documented
granular list per endpoint (proven empirically: working endpoints had zero
missing scopes, 401ing endpoints had at least one), while its CDN answers
414 for consent URLs past ~3.1k chars once the login/consent redirect chain
re-encodes them. The full union cannot satisfy both on one app, so the
surface is split across **two OAuth 2.0 (3LO) app registrations**:

- **App 1 — "Renkei" (Jira)**: the Jira API and Jira Software API blocks.
  Backs the `atlassian` connector.
- **App 2 — "Renkei JSM"**: the Jira Service Management API and JSM Ops API
  blocks. Backs the `atlassian-jsm` connector — its own client id/secret,
  its own consent, its own grant. Both apps register the SAME callback URL
  (`<origin>/api/oauth/callback`); the pending-state row routes each code
  exchange to the right app.

Lines marked `# trimmed:` are spec-listed scopes excluded on purpose (only
`read:audit-log:jira` remains: listed by GET /search/jql while the code uses
POST). `offline_access` is request-time only, never a Permissions-page
scope, and rides both apps' authorize URLs.

## Jira API — app 1 ("Renkei")

```
read:application-role:jira
read:attachment:jira
# trimmed: read:audit-log:jira
read:avatar:jira
read:comment.property:jira
read:comment:jira
read:field-configuration:jira
read:field.default-value:jira
read:field.option:jira
read:field:jira
read:filter.default-share-scope:jira
read:filter:jira
read:group:jira
read:issue-details:jira
read:issue-link-type:jira
read:issue-meta:jira
read:issue-security-level:jira
read:issue-type-hierarchy:jira
read:issue-type:jira
read:issue-worklog.property:jira
read:issue-worklog:jira
read:issue.changelog:jira
read:issue.transition:jira
read:issue.vote:jira
read:issue:jira
read:jql:jira
read:project-category:jira
read:project-role:jira
read:project-version:jira
read:project.component:jira
read:project.property:jira
read:project:jira
read:status:jira
read:user.property:jira
read:user:jira
write:attachment:jira
write:comment.property:jira
write:comment:jira
write:filter:jira
write:issue-link:jira
write:issue-worklog.property:jira
write:issue-worklog:jira
write:issue.property:jira
write:issue.time-tracking:jira
write:issue:jira
write:project-version:jira
write:project.component:jira
delete:comment.property:jira
delete:comment:jira
delete:filter:jira
delete:issue-link:jira
delete:issue-worklog.property:jira
delete:issue-worklog:jira
delete:issue:jira
delete:project.component:jira
```

## Jira Software API — app 1 ("Renkei")

```
read:board-scope:jira-software
read:issue:jira-software
read:sprint:jira-software
write:board-scope:jira-software
write:sprint:jira-software
```

## Jira Service Management API — app 2 ("Renkei JSM")

`read:user:jira` is deliberately on BOTH apps: JSM request payloads embed
user objects and Atlassian's all-of enforcement demands it on most
servicedeskapi endpoints — in the console, add the **Jira API** product to
the JSM app carrying just that one scope.

```
read:customer:jira-service-management
read:request.approval:jira-service-management
read:request.attachment:jira-service-management
read:request.comment:jira-service-management
read:request.participant:jira-service-management
read:request.sla:jira-service-management
read:request.status:jira-service-management
read:request:jira-service-management
read:requesttype:jira-service-management
read:servicedesk.customer:jira-service-management
read:servicedesk:jira-service-management
read:user:jira
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

## Jira Service Management Ops API — app 2 ("Renkei JSM")

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
