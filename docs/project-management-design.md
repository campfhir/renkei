# Project management on Renkei — plan

Written 2026-09-23. Stage 1a (the Jira Admin connector's foundation) shipped
with this document, and stage 1b (change requests and the first writes)
right after it; everything after that is the agreed direction, not code
yet.

## What this is solving

Five decisions set the shape of this plan:

- **We are on Jira Premium**, so the Plans API (Advanced Roadmaps) is ours
  to use.
- **The heaviest pain is setting up spaces and keeping them in step with
  changing requirements.** Second is getting status out of people.
- **Every Jira admin change needs a person to confirm it.** No model, agent
  or external MCP client applies an admin change on its own.
- **Only Jira admins make changes.** A change request is its proposer's to
  apply, on their own grant; there is no queue for people without admin
  rights to route requests through.
- **Space templates live in a Renkei table.** Not a file in a repository
  and not a Confluence page — nothing new to depend on.

The stance underneath: Renkei does not become a project management tool.
Jira stays the system of record for work, plans and dates (`RENKEI.md`
Decision #1 — Renkei is not storage), and Jira already draws the timelines
(Plans), burndown and velocity. What makes Jira heavy is the work _around_
it: an afternoon of admin clicking to stand a space up, a steady queue of
"can you add an option to this field" as requirements move, and tickets
nobody updates — so the charts are wrong anyway. That legwork is what
Renkei takes on.

## Phase 1 — the Jira Admin connector

### Why its own connector

Jira administration cannot ride on the existing `atlassian` app:

1. **It needs classic scopes, and one Atlassian app cannot mix classic and
   granular.** The existing app is granular-only
   (`apps/web/lib/atlassian-scopes.ts`). The Plans API documents only the
   classic `read:jira-work`/`write:jira-work`; the Forms API creates
   templates under the classic `manage:jira-project`; and the configuration
   endpoints (fields, contexts, options, schemes, workflows, spaces) list
   classic `manage:jira-configuration`/`manage:jira-project` as their current
   scopes, with the granular equivalents still in Beta
   (`docs/jira-cloud-rest-api-open-api-spec.json`).
2. **The existing consent URL is already at Atlassian's length limit** — the
   reason JSM got its own app (`docs/atlassian-granular-scopes.md`).
3. **Least privilege, and a switch of its own.** Only Jira admins should ever
   grant it, and an org admin must be able to turn it off, or limit it to
   the Jira-admins group, without touching anyone's everyday Jira. JSM shares
   Jira's capability key today and so cannot be switched off separately;
   this connector gets its own.

`onbase-admin` is the precedent, line for line
(`docs/onbase-connector-design.md`, "Admin tools"): its own connector config
row, grant provider, connect flow, capability key, and card on the
Connectors page grouped under its vendor.

### Shape

| What                 | Value                                                 |
| -------------------- | ----------------------------------------------------- |
| Connector config key | `atlassian-admin` (a "Renkei Jira Admin" app)         |
| Grant provider       | `atlassian-admin`                                     |
| Capability key       | `jira-admin`                                          |
| Tools                | `jira_admin_*`                                        |
| Site                 | the grant's cloud id, as for the other Atlassian apps |

Scopes are classic, and each arrives with the stage whose tools call it — a
scope nothing calls only widens the consent screen
(`docs/atlassian-admin-scopes.md` holds the derivation):

| Scope                       | Unlocks                                                                                                                                           | Stage  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `read:jira-user`            | who the connected person is                                                                                                                       | 1a     |
| `read:jira-work`            | the access check, custom field search, a space's roles and permission/notification schemes, Plans and Forms reads                                 | 1a     |
| `manage:jira-configuration` | field contexts and options, work types, statuses and workflows, the issue type / screen / field configuration / workflow schemes, creating spaces | 1a     |
| `manage:jira-project`       | screens and tabs, space settings, form templates                                                                                                  | 1c, 1e |
| `write:jira-work`           | Plans writes: create and update plans, teams, capacity                                                                                            | 1d     |
| `offline_access`            | refresh tokens (request-time only)                                                                                                                | 1a     |

Adding a scope later means adding it to the app in the developer console,
to the catalog, and a reconnect for everyone already connected — the usual
cost, paid once per stage rather than asking for everything up front.

**Who connects it:** Jira admins. Jira enforces the real permission on every
call — _Administer Jira_ for site configuration, the schemes a space runs on
and Plans; _Administer Projects_ for a space's roles and its permission and
notification schemes — so Renkei does not reimplement it.
`jira_admin_check_access` says up front what the connected person can
administer, so someone without the rights gets a clear answer instead of a
string of 403s, and the org admin limits the connector's audience to the
Jira-admins IdP group.

### The confirm rule, enforced on the server

Every admin write is a **proposal**, stored as a **change request**: the
exact operations it will run, who proposed it (a person in chat, an
external MCP client, or one of their agents), and when it expires. Anything
on the MCP surface can create one. **Nothing on the MCP surface can apply
one.** Applying happens only from a signed-in person's browser session — a
review page listing every operation, and a session-authenticated route
behind its Apply button.

Why not the existing `*_preview` → `*_confirm` card pattern: in Renkei's own
chat it does guarantee a human click (the confirm route requires the chat
owner's session, `apps/web/lib/chat/widget-tools.ts`), but in an external
MCP Apps host the card and the model call the confirm tool with the same
token. The server cannot tell a click from a model call; keeping app-only
tools away from the model is the host's promise, not ours. For admin
changes that is not enough. Proposal tools return a link to the review page
where a confirm button would be.

Change requests also give:

- **Tamper-proof apply.** The apply route takes an id; the operations come
  from the stored row, never from the browser.
- **Freshness.** A request expires (24 hours by default), and apply re-reads
  the live configuration first, stopping on any precondition that no longer
  holds — the option already exists, the field was renamed.
- **An audit trail.** Who proposed, who applied, what each operation
  returned: a record of every admin change Renkei made.

A request belongs to the person it was proposed for — their chat, their MCP
client, their agent — and only they can apply it, on their own grant. Only
Jira admins make changes, so there is no hand-off to anyone else.

### Stages

**1a — Foundation** (ships with this document). The app registration,
connect flow, capability gate and audience, and read tools:

- `jira_admin_check_access` — the connected person, whether they hold
  _Administer Jira_, and which spaces they administer.
- `jira_admin_list_fields` — custom fields with their type, and how many
  contexts and screens use each.
- `jira_admin_get_field` — one custom field's contexts: the spaces and work
  types each covers, and its options.
- `jira_admin_get_space_configuration` — a space's schemes (work types,
  workflows, screens, field configuration, permissions, notifications) and
  its roles with their members.
- `jira_admin_list_plans`, `jira_admin_get_plan` — Plans (an experimental
  Atlassian API; _Administer Jira_).

Turning 1a on:

1. In the Atlassian developer console, create an OAuth 2.0 (3LO) app
   ("Renkei Jira Admin"), add the Jira API's **classic** scopes
   `read:jira-user`, `read:jira-work` and `manage:jira-configuration`, and set
   its callback to `<origin>/api/oauth/callback` — the same callback as the
   other Atlassian apps.
2. In Renkei, Organization → Connector setup → Jira Administration: paste
   its client id and secret, and limit its audience to the Jira-admins IdP
   group.
3. Each Jira admin adds it from Connectors (it sits inside the Atlassian
   card) and connects; `jira_admin_check_access` confirms what they can
   administer.

**1b — Change requests and the first writes** (shipped; "1b as built"
below). The change-request store, the review page, the apply route, and
proposals for the most frequent maintenance chore: a field's options — add,
rename, disable, enable and reorder them. Creating a custom field and
adding a field to a screen tab moved to 1c: a new field is of no use until
it is on a screen, and screens take `manage:jira-project`, which 1c adds
anyway.

**1c — Spaces.** Create a space from a template or "like space X" (reusing
X's schemes); roles and their members; components and versions; a board
from a filter; a custom field with a space-scoped context, placed on a
screen tab. **Blueprints**: capture a space's configuration as a
declarative document, kept in a Renkei table, plan the difference against
the live site, and apply it as one change request.

**1d — Plans.** Create and update plans from spaces, boards and filters;
scheduling settings; plan-only teams with capacity and members;
cross-project releases.

**1e — Forms.** List, capture and stamp form templates between spaces;
publish a form to issue create or to a request type.

### 1b as built

- **The table.** `jira_admin_change_requests` (migration 120): the owner
  (tenant, subject), the agent when an agent run proposed it, the Jira site
  (cloud id) it was read from, the kind (`field_options` so far), a title,
  the proposer's reason, the exact operations as JSON, the status, and —
  once applied — what each operation returned, who applied it and when.
  Expiry is a timestamp read at apply time, not a sweep. Store:
  `apps/web/lib/jira-admin/change-requests.ts`.
- **Proposing.** `jira_admin_propose_option_changes` (an Act tool, so org
  read-only mode hides it) takes a field by id or exact name, a context by
  id or name — or a space key, meaning that space's own context, or the
  global one when it has none (and it says so) — and changes by option
  value: `add`, `rename`, `disable`, `enable`, `move` or
  `sortAlphabetically`, one level at a time (`parent` for a cascading
  select's children). It reads the live options, resolves names to ids, and
  refuses anything that could not apply ("Vendor already exists — disabled,
  enable it instead") before saving. It writes nothing to Jira. Its result
  links the review page; for an agent run, the act notification carries the
  same link. `replaces` supersedes one of the person's pending requests.
  `jira_admin_list_changes` lists them, and shows one with its results.
- **Reviewing.** `/[slug]/jira-admin/changes` lists a person's requests,
  waiting ones first; the Jira Administration card links there with a count.
  A request's page lists every operation in plain words and where it lands,
  with a global context called out, and — when applying is refused right
  now (read-only mode, the connector switched off, outside its audience,
  not connected, a grant without `manage:jira-configuration`) — says why in
  place of a working Apply button.
- **Applying.** `POST /api/tenant/{id}/jira-admin/changes/{id}/apply`,
  browser session only, owner only (anyone else's request is a 404). It
  re-asks the same org rules the MCP endpoint asks before registering the
  tool, refuses a request proposed for a different Jira site than the
  grant's, and claims the row with a conditional update so a double click
  applies once. Then it reads the field's options fresh and runs each
  operation in order — add, rename, enable, disable, move — re-checking it
  first against what is there now, and stops at the first that no longer
  holds or that Jira refuses. What ran stays (Jira has no transaction);
  the results say which operations were done, failed or not run, and the
  status reads applied, partly applied or failed. Every apply is an audit
  event, `jira_admin.change_applied`. `…/cancel` withdraws a pending one.
- **Nothing deletes.** Disabling keeps an option on the issues that carry
  it; there is no delete operation.

### Guardrails

- **No deletes in phase 1.** Deleting a custom field, an option or a scheme
  destroys data on every issue that used it.
- **Site-wide objects are treated as site-wide.** Custom fields and their
  contexts are global. Planning reuses before it creates ("a Story Points
  field already exists") and puts a space's new options in a context scoped
  to that space unless told otherwise.
- **Shared schemes are called out.** Editing a scheme changes every space
  that uses it; a proposal names those spaces, and a space-specific change
  defaults to copying the scheme first.
- **Access changes are labelled** on the review page (role members,
  permission schemes), since they change who can see what.
- **Experimental endpoints are named as such** (the Plans API, screen
  creation), so an Atlassian change there fails a proposal loudly.
- **Not possible, so not attempted:** board column and estimation settings
  (read-only in the API); Jira Automation rules (Atlassian's Automation API
  refuses OAuth apps); the one-call "create a fully configured space"
  endpoint (Enterprise only — on Premium, a blueprint applies as individual
  calls).

### Keeping spaces in step with changing requirements

Most admin time is not the first setup; it is the trickle of changes after
it. Two pieces go after that:

1. **Propose in plain language, apply in one click.** "Add a Vendor option
   to the Source field in OPS" becomes a change request. (1b)
2. **Drift.** A space stood up from a blueprint is compared to it on a
   schedule; a difference is reported, never auto-corrected. (After 1c.)

## Phase 2 — getting status out of people

Platform gaps come first:

- **Jira events that can start an agent.** Today only mail, WebEx, Zoom and
  batch events can (`packages/agents/src/trigger-catalog.ts`); Jira is only
  polled into the search index (`apps/worker/src/handlers/atlassian-watch.ts`,
  whose header explains why dynamic webhooks were ruled out). That poller
  should publish `jira/*` domain events — created, transitioned, assigned,
  field changed — working out what changed from the bulk changelog endpoint
  (`POST /rest/api/3/changelog/bulkfetch`: up to 1,000 issues a call, on
  scopes the existing app already holds, and unused today).
- **Asking someone other than the agent's owner.** `ask_person` asks only
  the owner. "What's the status of X?" has to reach the assignee, on WebEx
  or by email, with the answer written back to the issue.
- **Richer cards.** Markdown and links, and cards addressed to a team rather
  than only their owner.

Then the agents on top:

- **Status request.** Before a status meeting or report, ask each assignee
  of in-flight work a short structured question (where it stands, blocked?,
  new date) and write the answers back to the issues.
- **Hygiene nudges.** Stale in-progress work, missing estimates or due
  dates, unassigned sprint items — one message per person.
- **Meeting to work items** — buildable today: a finished Zoom transcript →
  `analyze_transcript` → an approval step → create and update issues.
- **Weekly status report.** A Confluence page or an email, rolled up from
  the answers and the issue history.

## Phase 3 — visibility

- A bulk issue-history tool, and small read-only burndown and velocity
  cards computed live from it.
- Timelines come from Plans (phase 1d). We do not build a Gantt.
- Capacity — calendar free/busy against assigned work — once the above
  lands.

## Not building

A Renkei task database, a Gantt editor, time tracking, boards, and Jira
Automation rule management (OAuth apps are refused).

## Decided

- **Blueprints live in a Renkei table** (1c): tenant-scoped rows, no
  repository or Confluence dependency. (Was: a table, a file in a
  repository, or a Confluence page.)
- **No propose-anyone queue.** Only Jira admins make changes, so a request
  is only ever its proposer's to apply. (Was: a queue routed to an IdP group
  or to whoever holds a `jira-admin` grant.)

## Fixed alongside

- `jira_create_version` and `jira_create_component` POSTed to
  `/project/{key}/version` and `/project/{key}/component`, which Jira only
  answers for GET. They now use `POST /version` (with the numeric
  `projectId`) and `POST /component` (with the project key), and the
  component lead resolves to an accountId.
- `sprint_summary` used `assignee != currentUser()`, which JQL never
  matches for an empty field, so unassigned sprint work dropped out of it.
