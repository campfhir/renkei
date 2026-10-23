# Classic scopes for the Jira Administration connector — a FIFTH Atlassian app

Backs the `atlassian-admin` connector (capability key `jira-admin`, tools
`jira_admin_*`): its own OAuth 2.0 (3LO) app registration, with its own
client id/secret, consent and grant, separate from the `atlassian` (Jira),
`atlassian-jsm`, `atlassian-confluence` and `atlassian-bitbucket` apps. The
plan it serves is `docs/project-management-design.md`.

**This app is CLASSIC, not granular** — the only one of the five. One
Atlassian app cannot mix classic and granular scopes, and administration
cannot be granular:

- The Plans API (`/rest/api/3/plans/...`) documents only `read:jira-work` /
  `write:jira-work`, with no granular equivalent at all.
- The Forms API creates templates under `manage:jira-project`.
- The configuration endpoints — field contexts and options, schemes,
  workflows, statuses, creating spaces — list classic
  `manage:jira-configuration` / `manage:jira-project` as their current
  scopes; their granular equivalents are still Beta.

Derived from `docs/jira-cloud-rest-api-open-api-spec.json`, endpoint by
endpoint (each operation's `security` block). Classic scopes are coarse:
reading a field's contexts or a space's schemes already takes
`manage:jira-configuration`, the same scope that allows changing them.
Renkei's own rule — every admin change is a proposal a person applies from a
signed-in Renkei session — is what keeps that power from being used on a
model's say-so: no MCP tool writes to Jira. The `jira_admin_propose_*` tools
store a change request, and only the apply route
(`app/api/tenant/[tenantId]/jira-admin/changes/[changeId]/apply`), on the
owner's browser session, sends the writes — and it refuses a grant without
every scope that change's writes need up front (`changeScopes` in
`lib/jira-admin/apply.ts`) rather than failing mid-way.

Only scopes a tool calls are listed; a scope nothing calls only widens the
consent screen. Later stages add theirs with the tools that need them (see
"Coming with later stages" below).

## Jira API — classic scopes

In the developer console: the app's **Permissions** → **Jira API** →
**Configure** → the **Classic scopes** tab. `lib/atlassian-scopes.test.ts`
holds this block and `ATLASSIAN_ADMIN_SCOPE_OPTIONS` to each other.

```
read:jira-user
read:jira-work
manage:jira-configuration
manage:jira-project
```

| Scope                       | Endpoints                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Tools                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read:jira-user`            | `GET /myself`, `GET /user`, `GET /user/search`, `GET /group/bulk`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `jira_admin_check_access`, `jira_admin_get_plan`, `jira_admin_propose_space` (the lead and role members)                                                                                                                                                                                                                                                                          |
| `read:jira-work`            | `GET /mypermissions`, `GET /project/search`, `GET /project/{key}`, `GET /project/{key}/role[/{id}]`, `GET /project/{key}/permissionscheme`, `GET /project/{key}/notificationscheme`, `GET /project/{key}/issuesecuritylevelscheme`, `GET /project/{key}/components`, `GET /project/{key}/versions`, `GET /permissionscheme/{id}`, `GET /projectvalidate/key`, `GET /field/search`, `GET /issuetype`, `GET /plans/plan[/{id}[/team]]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | every `jira_admin_*` tool, and applying a new space (the key check, reading its roles, components and versions) and a field for a space (checking no field of its name has appeared)                                                                                                                                                                                              |
| `manage:jira-configuration` | `GET /field/{id}/context`, `…/context/projectmapping`, `…/context/issuetypemapping`, `…/context/{id}/option`, `GET /issuetypescheme[/project]`, `GET /issuetypescheme/mapping`, `GET /issuetypescreenscheme[/project]`, `GET /issuetypescreenscheme/mapping`, `GET /issuetypescreenscheme/{id}/project`, `GET /workflowscheme/project`, `GET /workflowscheme/{id}[/projectUsages]`, `POST /workflowscheme/read`, `GET /workflows/search`, `GET /avatar/issuetype/system`, `GET /fieldconfigurationscheme[/project]`, `GET /notificationscheme/{id}`, `GET /role`; applying a change request: `POST`/`PUT /field/{id}/context/{id}/option`, `PUT …/option/move`, `POST /project`, `POST /project/{key}/role/{id}`, `POST /field`, `POST /field/{id}/context`, `POST /issuetype`, `PUT /issuetype/{id}`, `PUT /issuetypescheme/{id}/issuetype`, `PUT /issuetypescreenscheme/{id}/mapping`, `POST /workflowscheme/update` | `jira_admin_get_field`, `jira_admin_get_space_configuration`, `jira_admin_propose_option_changes`, `jira_admin_list_changes`, the space template tools, `jira_admin_propose_space`, `jira_admin_propose_space_field`, `jira_admin_list_work_type_icons`, `jira_admin_propose_work_type`, `jira_admin_get_space_screens`, `jira_admin_propose_screen_changes`, and the apply route |
| `manage:jira-project`       | `GET /screenscheme`, `GET /screens`, `GET /screens/{id}/tabs`, `GET /screens/{id}/tabs/{tabId}/fields`, `GET /screens/{id}/availableFields`, `GET /field/{id}/screens`; applying a change request: `POST /component`, `POST /version`, `POST /screens/{id}/tabs/{tabId}/fields`, `DELETE …/fields/{fieldId}`, `POST …/fields/{fieldId}/move`, `POST /screens/{id}/tabs`, `PUT /screens/{id}/tabs/{tabId}`, `PUT /screens/{id}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `jira_admin_propose_space_field` (a space's screens and their tabs, and who else shows them), `jira_admin_get_space_screens`, `jira_admin_propose_screen_changes`, and the apply route for a new space's components and versions, a field's screens and a screen's changes                                                                                                        |

## Request types — the one write on another app

Creating a request type (`POST /rest/servicedeskapi/servicedesk/{id}/requesttype`)
is documented under the granular scope `write:requesttype:jira-service-management`
only — no classic scope answers it, and this app is classic. So
`jira_admin_propose_request_type` is a Jira Administration tool that stands on
two grants: it reads the space and its work types here (`read:jira-work`), and
reads the service desk and its request types, and on apply sends the one
create, on the person's **Jira Service Management** grant — the second app,
whose picker gained a **Set up request types** box for it (off by default;
`docs/atlassian-granular-scopes.md`). The tool registers only when both grants
are connected with what each needs (`jira-admin/index.ts`, `jsm-access.ts`),
and the review page refuses to apply, naming the box, when the JSM grant lacks
it (`applyGate`). The apply route resolves the JSM grant by subject, checks it
is on the same site as the proposal, and runs the create through the Jira
Administration client on the same gateway. Jira sets what the API cannot: the
headset icon, no portal group (hidden until an admin groups it in Project
settings), the work type's fields.

Turning it on: add `write:requesttype:jira-service-management` (and the two
reads) to the JSM app in the developer console; Organization → Connector setup
→ Jira Service Management: tick **Set up request types**; each Jira admin
reconnects JSM with the box ticked.

## Automation rules — an API token, not a scope

Atlassian's Automation REST API (`api.atlassian.com/automation/public/jira/{cloudId}/rest/v1/…`)
refuses every OAuth app: each rule-management and manual-rule operation says
"Forge and OAuth2 apps cannot access this REST resource", and the API takes an
API token (HTTP Basic, `email:token`) or a browser session only. So the Jira
Administration card takes the person's own **Atlassian API token** beside the
OAuth grant (`POST`/`DELETE /api/atlassian-admin/token`). The delegate keeps
it as a grant of its own (`ATLASSIAN_ADMIN_TOKEN`, stored by `grant/store`,
never exchanged or refreshed), sends it as Basic with the grant's email, and
lets it reach `api.atlassian.com` only; the web app checks a new token by
making one call through the delegate and drops it on a 401, so a mistyped
token is never kept. The `jira_admin_*_automation_*` tools register only once
a token is saved, and the three automation change kinds (`automation_state`,
`automation_rule`, `automation_run`) apply on it — the confirm rule unchanged
(`lib/mcp-tools/jira-admin/automation-client.ts`, `lib/jira-admin/automation.ts`).
On this app the tools stand on `read:jira-work` alone, to name spaces and
issues by key.

## Request-time only (not on the Permissions page)

```
offline_access
```

## Coming with later stages

Not requested yet — no tool calls them. Each is added to the catalog, this
doc and the console together, with the tools that need it; people who
connected earlier reconnect to pick it up, the way `manage:jira-project`
arrived with the second part of stage 1c (below).

- `write:jira-work` — Plans writes: creating and updating plans, plan-only
  teams and their capacity (stage 1d).

## `manage:jira-project`, added with stage 1c

The picker's **Space components, versions and screens** box. It came with a
new space's components and versions and with putting a field on a space's
screens — even reading a screen's tabs takes it. To turn it on for a site
that connected before:

1. In the developer console, tick `manage:jira-project` among the app's
   classic scopes.
2. Organization → Connector setup → Jira Administration: tick **Space
   components, versions and screens** and save. An org that saved its scopes
   before holds a list without it, and a person can pick only what the org
   allows.
3. Each Jira admin reconnects Jira Administration with the box ticked.
   Until then `jira_admin_propose_space_field` is not offered, and a new
   space with components or versions says, on its review page, that it
   needs the reconnect before it can be applied.

Reading an issue security scheme by id takes it too, but a template's
security scheme is still not checked for existence before a space is
proposed — the check would fail for a grant without the box, and applying
names the problem if there is one.

## Who can use it

Scopes decide what the app may ask Jira; Jira still decides what the
connected PERSON may do, on every call. Custom field contexts and options,
the schemes a space runs on, and every Plans endpoint need the **Administer
Jira** global permission; a space's roles and its permission and
notification schemes need only **Administer Projects** on that space (a
space admin without site rights sees those, and "could not be read" for the
rest). `jira_admin_check_access` reports which the connected account holds. An org admin should also
limit the connector's audience to the Jira-admins IdP group
(Organization → Connector setup → Jira Administration).
