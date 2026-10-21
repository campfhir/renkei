# Salesforce connectors — design

A point-in-time design doc (see [`README.md`](./README.md)). Nothing here is built yet; when it
is, the as-built description belongs in a `salesforce` and a `salesforce-admin` section of
[`connectors.md`](./connectors.md), and this file stays as the record of why.

Two connectors, one vendor — the `jira`/`jira-admin`, `onbase`/`onbase-admin` and
`microsoft`/`entra-developer` arrangement:

| Connector          | Who it is for                                                         | What it does                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `salesforce`       | Everyone who works in Salesforce as a CRM — sales, service, nonprofit | Find, read, create, update and delete records of standard and custom objects; log activity; find and run reports (sync and async) and read dashboards to tell the story behind the numbers           |
| `salesforce-admin` | Salesforce administrators and app builders                            | Build applications: define custom objects and fields, picklists, validation rules, record types, layouts, apps and tabs, permission sets; build report folders, reports and dashboards for CRM users |

## What they are for

**The CRM connector** answers the questions people otherwise click through Salesforce for — "what
did we last hear from Acme?", "which of my opportunities close this month?", "how much has this
donor given since 2023?" — and does the routine data work that follows: log the call, move the
stage, fix the address, create the follow-up task. Reports are the other half of everyday
Salesforce, and the half that tells the story: the org's reports already encode what its people
care about, so "how did this quarter go?" is best answered by running them — this period and last,
one region and another — and explaining what moved, with a chart.

**The admin connector** is for the people who change the shape of the org rather than the rows in
it. An administrator building an application does the same dozen things in Setup: create an
object, add its fields, add picklist values, write validation rules, put the fields on a layout,
give it a tab and an app, and grant a permission set — usually in a sandbox first, then again in
production. The connector does that work from a sentence, shows exactly what it will deploy, and
deploys it only when the admin applies it. Admins also build the **reports** CRM users run: a
report drafted from a sentence, checked against real data, then published to a folder the right
people can see.

## Decisions

### Two connectors, not one with an admin toggle

Salesforce OAuth scopes are coarse. `api` is the whole REST/SOAP/Metadata/Tooling surface; nothing
narrower exists that separates "update a contact" from "create a custom object". What actually
separates the two is the **Salesforce user's own permissions** — _Customize Application_, _Modify
Metadata Through Metadata API Functions_, _Author Apex_, _Manage Users_ — which Salesforce checks on
every call. So the split is not about scopes, and the case for two connectors rests on the rest of
what a connector is here:

- **Two client apps in Salesforce, two policies.** Each connector is its own External Client App
  (ECA) in the customer's org. The admin ECA is set to _Admin approved users are pre-authorized_ and
  assigned only through a permission set the Salesforce admins hold, can require a high-assurance
  session, and can carry a short refresh-token lifetime (say, 24 hours) — none of which an org
  wants imposed on every fundraiser's CRM connection.
- **Two switches and two audiences in Renkei.** `disabledConnectors` names `salesforce-admin` on
  its own, and an org admin limits its audience to the Salesforce-admins IdP group
  ([`connector-catalog-design.md`](./connector-catalog-design.md), "Audiences") without touching
  anyone's CRM access.
- **Two tool surfaces with different blast radius.** A CRM write changes a row a person can see and
  fix. An admin write changes what every user of the org sees, and some of it (a deleted field's
  data, a master-detail conversion) cannot be undone. They get different confirm rules
  (below), and keeping them in different modules keeps the stricter rule from being forgotten on a
  new tool.
- **Different org shapes.** The CRM connector talks to one production org. The admin connector
  talks to production **and its sandboxes**, since that is where application building happens.

Connecting one never connects the other. The one thing shared is a package (below) and the OAuth
plumbing: the callback, the token exchange, and the grant adapter (`SalesforceAdapter` with a
provider parameter, the `AtlassianAdapter`/`MicrosoftAdapter` shape).

| What                 | CRM                         | Admin                              |
| -------------------- | --------------------------- | ---------------------------------- |
| Config key           | `salesforce`                | `salesforce-admin`                 |
| Grant provider       | `salesforce`                | `salesforce-admin`                 |
| Capability key       | `salesforce`                | `salesforce-admin`                 |
| Tool prefix          | `salesforce_*`              | `salesforce_admin_*`               |
| Tool module          | `lib/mcp-tools/salesforce/` | `lib/mcp-tools/salesforce-admin/`  |
| Orgs                 | one (production)            | production + registered sandboxes  |
| Confirm rule (below) | preview + confirm on a card | change request, applied in browser |

### Auth: Web Server flow with PKCE, against the org's own My Domain

Each organization registers the ECAs in **its own** Salesforce org — Renkei does not publish a
packaged app — and pastes the consumer key and secret into the admin form, the way OnBase and
Entra Developer are configured. (Salesforce steers new integrations to External Client Apps rather
than connected apps; a connected app works the same way over the wire, and the form does not care
which one issued the key.)

- **Flow:** OAuth 2.0 Web Server flow with PKCE (`S256`) and the client secret. Authorize, token
  and revoke at the org's My Domain: `https://<mydomain>.my.salesforce.com/services/oauth2/…`.
  The form takes the My Domain URL rather than offering `login.salesforce.com`, because the org's
  SSO policy usually lives on My Domain and because the domain is what pins the host (below).
- **Scopes:** `api refresh_token id`. Nothing else: `full` and `web` would add browser-session and
  Visualforce reach nothing here uses, and the reports API rides `api`. CRM Analytics (`wave_api`)
  and Data Cloud (`cdp_*`) are out of scope.
- **The grant's account id is `<orgId>/<userId>`, not the user id alone.** A sandbox is a copy of
  production and keeps production's user ids; only the org id differs. `provider_grants`' key is
  `(provider, provider_account_id)`, so a bare user id would make a person's sandbox grant
  overwrite their production one. `metadata` keeps `{orgId, userId, instanceUrl, isSandbox,
orgName, username}` from the token response's `id` URL and `instance_url`.
- **Token lifetime is not in the response.** Salesforce's token response carries `issued_at` and
  no `expires_in`; the session lasts as long as the org's session timeout for that ECA. The adapter
  records `expiresAt = issued_at + sessionTimeout`, where `sessionTimeout` is a setting on the admin
  form (default 2 hours, matching Salesforce's default), and the delegate's existing
  retry-once-on-401 covers an org whose timeout is shorter. Refresh: `grant_type=refresh_token`
  at the same token URL; `invalid_grant` is `GRANT_REVOKED`, everything else `REFRESH_FAILED`
  ([`provider-grants` types](../packages/provider-grants/src/types.ts)). If the org turns on
  refresh-token rotation, the adapter stores the new refresh token the response carries.
- **Disconnect revokes.** `POST /services/oauth2/revoke` with the refresh token, so a removed
  connection is gone in Salesforce too, not only in Renkei.

### Host pinning is per grant

The delegate allows a provider's token only to that provider's hosts
(`apps/worker-delegate/src/providers.ts`, `hostAllowed`), and today those lists are static.
Salesforce's API host is per org — `acme.my.salesforce.com`, a sandbox
`acme--uat.sandbox.my.salesforce.com` — so a static list would have to be `.my.salesforce.com`,
which is every Salesforce customer on earth. Instead `ProviderSpec` gains an optional
`hostsForGrant(grant)` and the Salesforce specs return exactly the host of the grant's
`instanceUrl` (plus the My Domain login host for refresh). At connect time the callback refuses an
`instance_url` that is not `https`, not under `my.salesforce.com` (or the configured government
cloud suffix), or not the configured org's domain. This is the one change to shared
infrastructure the connectors need, and it is worth doing first and on its own.

### Salesforce decides who can see and do what

Retrieval-only, nothing indexed, no `verifyAccess` — the Entra Developer and Mirth model. Every
call runs on the person's own token, so object permissions, field-level security, sharing rules,
record types, validation rules and duplicate rules are all Salesforce's, applied by Salesforce, on
every request. Renkei does not cache records, re-implement sharing, or read with anyone's token but
the caller's.

Two consequences worth stating:

- **A user with _View All Data_ sees everything through the connector, too.** That is correct (it
  is what Salesforce says they may see), but it is the reason an org may want the CRM connector's
  audience to be narrower than "everyone with a Salesforce licence".
- **Error text is Salesforce's.** A field-level-security miss, a validation rule's message, a
  duplicate-rule block — the tool returns Salesforce's `errorCode` and `message` verbatim, the
  `entraRequest` rule, because the admin who wrote the validation rule wrote that message for
  exactly this person.

If records are ever indexed (Knowledge articles and closed Cases are the plausible first), the
verifier is ready-made: `SELECT RecordId, HasReadAccess FROM UserRecordAccess WHERE UserId = :me
AND RecordId IN (…)` answers up to 200 refs per query with the reader's own token — the
Atlassian "re-query as the reader" shape. Not in this version.

### API limits are the org's, and shared

Salesforce counts API calls per org per rolling 24 hours, and every integration the customer runs
draws on the same pool. A model that pages through 50,000 contacts can starve the org's
marketing sync. So:

- Every response's `Sforce-Limit-Info: api-usage=used/max` header is read by the client and kept
  per org (in memory, short-lived); `salesforce_check_access` reports it.
- An org setting, **API budget** (default 80%), above which read tools refuse with "the org has
  used N of M API calls today" rather than spend more. Writes still go through — a person
  finishing a task should not be blocked by their own colleagues' sync job.
- Queries are bounded: one page (≤ 2,000 rows) per call by default, an explicit `cursor` to
  continue, and a hard per-call cap (10,000 rows) after which the tool says to build a report or
  narrow the query. Large data movement belongs to Bulk API 2.0 on the admin connector, not to
  chat.

### Health and other sensitive records

Some of what organizations keep in Salesforce is regulated — health and care programs, case
management, donor financials — often on custom objects with free-text notes beside them.
Anything a tool returns goes into a model's context and through the organization's LLM provider.
The connector cannot make that decision for the organization, so it makes it explicit:

- the object and field exclusion list and the _Restricted_ data-classification switch (see "Custom
  objects and custom fields are first-class") are on the admin form from stage 1, not a later
  nicety;
- the admin form says, beside the CRM connector's switch, that record contents are sent to the
  configured LLM provider, so turning it on for health data is a decision someone signs off on
  (provider agreements such as a BAA are the organization's to have in place);
- long free-text fields (notes on custom objects) are returned only when a tool asks for that
  field by name, not in a record's default view, since that is where unstructured sensitive detail
  ends up.

### No generic request tool, no anonymous Apex

As with Mirth: there is no "call this REST path" tool on either connector. And `executeAnonymous`
is deliberately absent from the admin connector — it runs arbitrary Apex as the admin, with
_Modify All Data_ reach, in one call, with nothing to preview. The curated tools below are the
surface.

### One package, HTTP in the web app

`packages/connector-salesforce`, dependency-light and I/O-free (the `connector-onbase` shape):

- the pinned API version — **v68.0** (Winter '27, generally available October 2026) — one
  constant, every request built as `/services/data/v68.0/…`; bumped deliberately once a year or so
  after reading that release's notes, never the REST `latest` alias. Salesforce ships three
  releases a year (Spring '27 is expected to be v69.0) and supports old versions for years, so a
  pin is safe; preview sandboxes running the next release still answer v68.0. The one place that
  needs the newest version is the sObjects OpenAPI generation, which answers only on the latest —
  it is a build-time reference, so it does not move the pin;
- id helpers (15 ↔ 18-character conversion, key-prefix to object via a describe cache);
- **SOQL safety**: a builder that escapes string literals (`\'`, `\\`, `\n`…) and validates
  identifiers against the describe, used by every tool that composes a query from arguments;
  `salesforce_query` takes the model's own SOQL but parses it far enough to refuse anything that is
  not a single `SELECT` and to add `LIMIT` when absent;
- report metadata builders and validators (formats, groupings, filters, boolean filter logic);
- metadata XML builders (`package.xml`, `CustomObject`, `CustomField`, `ValidationRule`,
  `RecordType`, `Layout` merges, `PermissionSet`, `CustomApplication`, `CustomTab`) and the deploy
  result parser;
- the describe helpers: the per-org relationship graph and path finding (below).

Salesforce is internet SaaS, so there is no dedicated worker: HTTP runs in `apps/web` through the
delegate's authenticated fetch, the Entra Developer arrangement. The admin connector's deploy
needs a zip builder — the one new dependency, and it lives in the package so it is tested without
a network.

### Built on the core REST resources

The CRM connector's record work runs on a small, stable part of Salesforce's REST API — the
sObject, Query and Search resources and the two composite resources that batch sObject writes —
rather than on a spread of API families. These exist in every org with API access, behave the same
for standard and custom objects, and are the resources Salesforce's own sObjects OpenAPI document
describes. Reports are the one other API: listing, describing and running them (and, on the admin
connector, building them) goes through the Reports and Dashboards REST API (`/analytics/…`).

| Resource                                                              | Used for                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /sobjects` (describe global)                                     | `salesforce_list_objects`; key prefix → object for any id                                                                                                                                                                                                                              |
| `GET /sobjects/{sObject}/describe`                                    | `salesforce_describe_object`, and typing every write: fields, types, required, updateable, picklist values, dependent picklists (`controllerName` + each value's `validFor`), relationships both ways, record types; the relationship graph behind `salesforce_find_relationship_path` |
| `GET /sobjects/{sObject}/describe/layouts/{recordTypeId}`             | Which picklist values a record type allows (`recordTypeMappings`)                                                                                                                                                                                                                      |
| `GET /sobjects/{sObject}/describe/compactLayouts`                     | The fields that identify a record of the object (auto-number names, see below)                                                                                                                                                                                                         |
| `GET /sobjects/{sObject}/{id}`                                        | Reading a record by id where no relationships are wanted                                                                                                                                                                                                                               |
| `POST /sobjects/{sObject}`, `PATCH`/`DELETE /sobjects/{sObject}/{id}` | Create, update, delete one record; `PATCH` with `If-Unmodified-Since` for read-modify-write                                                                                                                                                                                            |
| `PATCH /sobjects/{sObject}/{externalIdField}/{value}`                 | `salesforce_upsert_record`, and naming a record by external id                                                                                                                                                                                                                         |
| `GET /sobjects/{sObject}/updated`, `/deleted`                         | `salesforce_list_changes` — which records of an object changed or were deleted in a window ("what changed on site visits since Monday")                                                                                                                                                |
| `GET /sobjects/{sObject}/{id}/{blobField}`                            | File download (`ContentVersion.VersionData`)                                                                                                                                                                                                                                           |
| `GET /query`, `/queryAll`, `nextRecordsUrl`                           | `salesforce_query`; `salesforce_get_record` with `include` (one SOQL: the fields, parent paths, and child subqueries, with `toLabel()` and `FORMAT()` for display values); related lists; field history (`…__History`); deleted records                                                |
| `GET /search` (SOSL)                                                  | `salesforce_search`, and the name fallback when resolving a record                                                                                                                                                                                                                     |
| `/composite/sobjects` (sObject Collections)                           | Up to 200 records created, updated or deleted in one all-or-none call                                                                                                                                                                                                                  |
| `/composite/tree/{sObject}` (sObject Tree)                            | `salesforce_create_record_tree` — a parent and its children together                                                                                                                                                                                                                   |
| `GET /limits`                                                         | API usage in `salesforce_check_access`, beside the `Sforce-Limit-Info` header every response carries                                                                                                                                                                                   |

Activities, notes, files, owners and history need no other API: Tasks, Events, ContentNote,
ContentVersion and ContentDocumentLink are sObjects like any other, history tables are queried, and
an owner change is an update. The tools are generic — an `object` argument and a `fields` map —
and the describe types them at call time: unknown fields, wrong types, read-only fields, invalid
picklist values and missing required fields are refused before anything is sent, with the valid
choices named.

Salesforce's **sObjects OpenAPI 3.0 document** (`POST /async/specifications/oas3`, beta) describes
exactly these resources with the org's own objects in them. It is the build reference: generate it
from a developer org and commit it beside the other vendor specs in this folder
(`salesforce-sobjects-open-api-spec.json`), and the package's request and response types follow
it. At run time the describe stays the source, since the document needs an admin to turn the beta
on, answers only on the latest API version, and is generated asynchronously. For developers working
against a particular org, `salesforce_admin_export_openapi` generates and stages that org's
document (when the org has the beta on).

### References resolve; ambiguity refuses

Every tool takes a record as an id, or as an object plus a name ("Contact Jane Doe", "Account
Acme"), resolved through `Name` (or the object's name field) with SOSL as the fallback. An object
or field takes its API name or its label. A name matching more than one record is refused with the
candidates and their ids — never guessed — and a 15-character id is accepted and answered as 18.
Answers that mention record ids carry the record's name alongside, so a raw result still reads
(the Mirth legend rule).

## The CRM connector (`salesforce`)

### Confirm rule: preview + confirm for what is hard to take back

The everyday-record rule, between Mirth's "only permanent operations" and ADManager Plus's "every
write":

| Action                                                | Confirm                                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| Create one record, update one record, log an activity | Direct; the result shows each field's old and new value and links the record     |
| Update or create more than one record                 | Preview + confirm — the card lists every record and every field change           |
| Delete (any number)                                   | Preview + confirm — the card names each record and its child records that go too |
| Change a record's owner                               | Preview + confirm — it changes who can see it                                    |

Single-record writes are direct because that is how people use a CRM — the result is the receipt,
and the record's own history (where field history is tracked) and the person's own eyes on the
link are the undo. Deleted records go to the Recycle Bin for 15 days; the delete result says so
and links it. Agents follow the same table through their staged actions: a direct write is a step,
a preview + confirm write is a step with `needsApproval` ([`agents.md`](./agents.md)).

The card is the existing issue-preview widget for record changes. Running reports is read-only
and needs no card.

### Tools

**Orientation**

| Tool                         | Does                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `salesforce_check_access`    | Who the connection is (user, profile, role, org, edition, sandbox or not), API usage today                                                             |
| `salesforce_list_objects`    | The objects the person can see (describeGlobal, filtered to queryable and not system plumbing), label and API name                                     |
| `salesforce_describe_object` | Fields (type, required, updateable, picklist values per record type, relationships), record types, child relationships — trimmed to what a model needs |

**Records**

| Tool                                                  | Does                                                                                                                                                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `salesforce_search`                                   | SOSL across objects by text ("everything about Acme"), or within named objects                                                                                                                                                     |
| `salesforce_query`                                    | SOQL `SELECT`, one page at a time with a cursor, relationship and aggregate queries allowed                                                                                                                                        |
| `salesforce_get_record`                               | One record with labels and display values; `include` takes parent paths (`Account.Owner`) and child relationships (`Contacts`, `Site_Visits__r`) to fetch in the same call                                                         |
| `salesforce_list_related`                             | Any child relationship of a record, standard or custom, paged, with filters and sort                                                                                                                                               |
| `salesforce_find_relationship_path`                   | How two objects connect — direct lookup, master-detail, through a junction object, or via a shared parent — from the describe graph, so "this account's site visits" finds the path the org actually built                         |
| `salesforce_create_record`                            | Create one record; record type by name; picklist values checked against the record type; `parent` links it to a record by choosing the relationship field (refused, naming the fields, when there is more than one to that object) |
| `salesforce_create_record_tree`                       | A parent with its children in one all-or-none call (sObject Tree), e.g. a record and its line items — preview + confirm, as a multi-record write                                                                                   |
| `salesforce_relate_records`                           | Relate two records many-to-many by creating the junction record between them; the junction object is found from the describe, and refused naming the candidates when more than one connects them                                   |
| `salesforce_update_record`                            | Update one record's fields; reads first so the result shows old → new                                                                                                                                                              |
| `salesforce_upsert_record`                            | Create-or-update by an external id field                                                                                                                                                                                           |
| `salesforce_update_records_preview` / `_confirm`      | Many records, one change set (Composite sObject collections, all-or-none by default)                                                                                                                                               |
| `salesforce_delete_records_preview` / `_confirm`      | Delete; the preview names cascade-deleted children (master-detail) from the describe                                                                                                                                               |
| `salesforce_change_owner_preview` / `_confirm`        | Reassign records; the preview names the new owner and what sharing changes                                                                                                                                                         |
| `salesforce_log_activity`                             | A completed Task (call, email, meeting note) or an Event, related to the record(s) named                                                                                                                                           |
| `salesforce_create_task`                              | An open follow-up Task assigned to the person or a named user, with a due date                                                                                                                                                     |
| `salesforce_add_note`                                 | A Note (ContentNote) attached to a record                                                                                                                                                                                          |
| `salesforce_record_history`                           | Field history of a record (the object's `__History` table): who changed which tracked field, from what, to what, when                                                                                                              |
| `salesforce_list_changes`                             | Records of an object updated or deleted in a time window (the sObject `updated`/`deleted` resources), with names                                                                                                                   |
| `salesforce_download_file` / `salesforce_attach_file` | A record's files to and from the scratch space (below)                                                                                                                                                                             |

### Instance-agnostic: the platform, not one org

The connector knows **Salesforce**, not any one organization's Salesforce. It has no built-in
knowledge of a particular org's objects, packages, processes or field meanings, and no tool that
only makes sense in one org or one industry. Everything specific to an org — which objects exist,
how they relate, which picklist values are valid, which fields are required, what a field means —
is read from that org at run time (describe, the org's own validation errors), so the same
tools work in a sales org, a service org, a nonprofit on NPSP or Nonprofit Cloud, or an org that is
nearly all custom objects.

An organization's **process** — "log a call attempt and bump the counter", "record a gift the way
our development team does", "move a referral to its next stage" — belongs in a **prompt library**
or an **agent's instructions** ([`chat.md`](./chat.md), [`agents.md`](./agents.md)), written by the
people who own that process and built on the generic tools below. That keeps the connector small
and universal, and lets each organization change its procedures without a Renkei release.

### Salesforce fundamentals the tools encode

What the tools do know is the platform's model, the same in every org:

- **Objects, fields, records.** Standard objects, custom objects (`__c`), managed-package objects
  (`ns__Obj__c`), and the system tables that hang off them — `__History`/`…History` (field
  history), `__Share` (manual sharing), `__Feed`. Custom metadata types (`__mdt`) and external
  objects (`__x`) are readable, not writable here; platform events (`__e`) are out of scope.
- **Ids.** 15- and 18-character ids; the first three characters are the object's key prefix, so any
  id resolves to its object through the describe without being told.
- **Relationships.**
  - _Lookup_ — optional, the child keeps its own owner and sharing.
  - _Master-detail_ — the child's sharing and owner come from the parent, deleting the parent
    deletes the children, and the parent can carry roll-up summaries.
  - _Junction objects_ — two master-details make a many-to-many.
  - _Polymorphic_ fields — an activity's `WhoId` (Lead or Contact) and `WhatId` (almost anything),
    `OwnerId` (User or Queue) — resolved by the id's prefix.
  - _Hierarchical_ (User to User) and self-relationships.
  - Traversal both ways: child to parent by dotted path (`Account.Owner.Name`, up to five
    levels), parent to child by relationship name (`Contacts`, `Site_Visits__r`), both read from
    the describe rather than guessed from labels.
- **Record types, picklists and dependent picklists** — which values are valid depends on the
  record type and, for a dependent picklist, on the controlling field.
- **Ownership and sharing.** An owner is a user or a queue; who else can see a record follows the
  org's sharing model, which Salesforce enforces and the connector only reports.
- **Activities.** Tasks and Events relate to any activity-enabled object, custom ones included,
  through `WhatId`, and to people through `WhoId`.
- **Notes and files** relate to records through `ContentDocumentLink`.
- **Computed and protected fields.** Formula, roll-up summary and auto-number fields are
  read-only; required, unique and external-id fields are marked in the describe.
- **Deleted records** sit in the Recycle Bin for 15 days and are visible through `queryAll`.

These are the concepts the tool descriptions use and the package's describe helpers model (a
relationship graph per org and person, built from the describe and cached with it), so the model
can say "the contacts on this account's open opportunities" without anyone teaching it that org.

### Custom objects and custom fields are first-class

Most of the work in an org that has been built out is on its own custom objects — a
`Volunteer_Shift__c`, a `Grant_Application__c`, a `Site_Visit__c` — and on custom fields added
to the standard ones. None of the tools above has a list of "supported" objects: every record tool
takes any object the person can access, standard or custom, the org's own or a managed package's
(`npsp__…`, `pmdm__…`), and every field on it, custom fields included. Nothing about a custom
object needs the admin connector except changing its _definition_ (below). What that takes in
practice:

- **Discovery.** `salesforce_list_objects` marks each object custom or standard and lists the
  org's own unnamespaced custom objects first, with a `customOnly` filter, so "what objects do we
  have?" answers with the org's own vocabulary rather than 400 standard objects.
  `salesforce_describe_object` returns each custom field's **description and help text**: that is
  where the admin who built `Stage_Gate__c` wrote what it means, and the model needs it to choose
  the right field.
- **Names both ways.** An object resolves by API name, label or plural label ("site visits" →
  `Site_Visit__c`); a field by API name or label, on the object named; a relationship by its
  `__r` name for queries and related lists (`salesforce_list_related` on `Grant__c`'s
  `Applications__r`). A label that matches two objects or fields (an unmanaged `Program__c` and a
  managed `pmdm__Program__c`) is refused naming both.
- **Records without a useful name.** Custom objects often have an auto-number name (`SV-000412`).
  A record still resolves by name when one is given, and otherwise by the fields of the object's
  compact layout (`describe/compactLayouts`), which is how Salesforce itself identifies a record in a lookup — "the
  site visit for Acme on 3 March" searches those fields. SOSL is used where the object allows
  search; an object with search turned off falls back to a SOQL `LIKE` on its name and
  compact-layout text fields. Results show the compact-layout fields beside the auto-number so
  they read.
- **Field types on write.** Values are checked against the describe before anything is sent, with
  the reason refused named:
  - lookup and master-detail by the target record's name or id, custom to custom included; a
    master-detail parent is required on create, and changeable afterwards only when the field
    allows reparenting;
  - picklists and multi-selects against the record type's values, **dependent picklists** against
    the controlling field's value (the describe's `controllerName` and each value's `validFor`);
  - formula, roll-up summary and auto-number fields are read-only — the tool says which field
    computes it rather than letting Salesforce's error do it;
  - currency with `CurrencyIsoCode` in multi-currency orgs, date and date-time in the person's
    time zone, geolocation compound fields, long and rich text (rich text is sent as the HTML
    Salesforce stores, sanitized the way `email-sanitizer` does it), encrypted fields as
    Salesforce masks them;
  - external id fields (common on custom objects loaded from another system) for
    `salesforce_upsert_record` and as a way to name a record.
- **A fresh describe.** Descriptions are cached per org and person for ten minutes. The cache is
  dropped for an object when a write fails with `INVALID_FIELD` or a picklist error, and when the
  admin connector applies a change request touching that object, so a field an admin just built
  is usable in CRM tools on the next call, not ten minutes later.
- **Reports on custom objects** need no extra tools: a report on a custom report type lists and
  runs like any other.
- **Keeping some objects away from the model** (optional org setting). Salesforce's permissions
  decide what a person can reach, but an org may want, say, `Case_Note__c` or a payroll object out
  of chat even for people who can see it in Salesforce. An **object and field exclusion list** on
  the admin form hides those from every CRM tool, and fields Salesforce data classification marks
  _Restricted_ can be hidden with one switch. These only take things away; they never grant
  anything Salesforce would refuse.

The boundary with the admin connector: the CRM connector creates, updates and deletes **records**
of custom objects and **values** of custom fields. It never adds a field, changes a picklist's
values, or edits a validation rule — those change the object for everyone and go through the admin
connector's change requests.

### Writes meet the org's own automation

An org that has been built out puts its process in the object: validation rules that gate a stage
change, before-save flows that stamp dates, duplicate rules, required fields. The record tools work
with that rather than around it:

- **The result is re-read after the write.** The old → new list on a create or update includes the
  fields automation changed, not only the ones sent — "Stage → Site Visit; also set by the org:
  Stage Last Changed 2026-10-20 14:02" — so nobody is surprised by a stamped date later.
- **A blocked save names the missing field.** Salesforce's error carries the rule's message and the
  field it is attached to (`fields` on the error). The tool returns both, and the model asks the
  person for exactly that value ("When is the site visit scheduled?") instead of guessing a date
  to get past the rule. It never writes a placeholder to satisfy a validation rule.
- **Read-modify-write is conditional.** Updates computed from the current value (a call-attempt
  counter plus one) send `If-Unmodified-Since` with the record's `LastModifiedDate`, so a colleague's
  save in between is a conflict to re-read, not a lost update.
- **Page visibility is not access.** Dynamic Forms hide fields on the record page by stage; the API
  does not. The connector can write any field field-level security allows, at any stage, so the
  org's validation rules — not the page layout — are what keep a stage's data in order. The
  describe marks which fields the person can edit; it does not pretend to know the page's
  visibility rules.

Files move through the sandbox scratch space the way OnBase and Jira attachments do
([`sandbox-connector-design.md`](./sandbox-connector-design.md)): `salesforce_download_file` reads
`ContentVersion.VersionData` through the blob resource into a scratch file, and
`salesforce_attach_file` inserts a `ContentVersion` (multipart) from a scratch file and links it to
the records named with `ContentDocumentLink`.

### Reports and dashboards: find, run, tell the story

The CRM connector reads and runs reports and dashboards; it does not build or share them — that is the admin
connector's job (below), so the reports people rely on are made deliberately and kept in one
place.

| Tool                            | Resource                                                                    | Does                                                                                                                                                                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `salesforce_find_reports`       | `GET /query` on `Report` and `Folder`; `GET /analytics/reports` for recent  | By name, folder, report type, owner, or last run — a SOQL query, since `GET /analytics/reports` lists only the person's recently viewed (offered as "recent")                                                                                                |
| `salesforce_describe_report`    | `GET /analytics/reports/{id}/describe`                                      | What the report measures, in words: its report type, format, groupings, aggregates, columns and filters — so the model knows what a number means before quoting it                                                                                           |
| `salesforce_run_report`         | `GET`/`POST /analytics/reports/{id}`                                        | Run it now. Optional run-time changes — filters, a date range, a grouping's sort — apply to this run only and nothing is saved. Groupings and aggregates by default, detail rows on request                                                                  |
| `salesforce_run_report_async`   | `POST /analytics/reports/{id}/instances`                                    | Start a run in the background for a slow report or more detail rows than a synchronous run returns; answers with an instance id                                                                                                                              |
| `salesforce_get_report_results` | `GET /analytics/reports/{id}/instances/{instanceId}`, `…/instances`         | An async run's status and, when complete, its results; or the report's recent runs                                                                                                                                                                           |
| `salesforce_find_dashboards`    | `GET /query` on `Dashboard`; `GET /analytics/dashboards` for recent         | By name, folder or owner                                                                                                                                                                                                                                     |
| `salesforce_get_dashboard`      | `GET /analytics/dashboards/{id}/describe`, `GET /analytics/dashboards/{id}` | Its components with their latest values — each component's source report, grouping and aggregate, so a number can be traced to the report behind it — the running user, dashboard filters (optionally applied for this read), and when it was last refreshed |
| `salesforce_refresh_dashboard`  | `PUT /analytics/dashboards/{id}`, `GET …/status`                            | Refresh it and read it back when done; Salesforce limits how often a dashboard can refresh, and the tool says when it last did instead of failing                                                                                                            |

**Sync or async.** A synchronous run answers in the call and is capped by Salesforce (2,000
detail rows, and a time limit); it is the default for a summary. Async is for a heavy report or a
full detail run, and suits agents well: start it, do other work, read it back. Salesforce keeps
async results only for a limited time and caps report runs per org per hour (separately for sync
and async), so the tools reuse a recent instance of the same run rather than starting another, and
say how fresh it is.

**Telling the story.** A report run returns numbers; the person wants to know what they mean. The
run result is shaped for that, and the tool descriptions steer the model to use it:

- **Scope first.** Every result states what was run — the report's name, its filters as applied
  (including any run-time change), the date range, and when it ran — so a narrative never quotes a
  number without saying what it counts.
- **Groupings as structure.** Results come back as the report's groupings with labels, subtotals
  and the grand total (the fact map turned into readable rows), which is the outline of a story:
  "pipeline grew 12%; most of it is the West region; two deals account for half".
- **Comparison by re-running, not by building.** "This quarter against last" is the same report
  run twice with a different date filter; "West against East" is a filter change. The result marks
  each run's variation so the comparison stays honest. Nothing is saved to Salesforce.
- **Drill-down.** A surprising subtotal can be explained by asking for that grouping's detail rows
  (a filter on the grouping value), or by moving to the records themselves with the record tools —
  the ids in detail rows are record ids.
- **Charts.** Groupings hand straight to the chat's `chat_write_chart` (a bar, line or pie in
  Mermaid) where the organization has charts on, so a story arrives with its picture.
- **Honest limits.** A truncated run (synchronous row cap), a stale async instance, or a report
  whose filter depends on the running user ("my opportunities") is said plainly, beside the numbers.

When nobody has built the report a question needs, the CRM connector can still answer it with an
aggregate SOQL query (`GROUP BY`, `COUNT`, `SUM`) through `salesforce_query`, and says that a
report for it is something an admin can publish.

### Scope picker

The CRM card's checkboxes narrow what registers, the Mirth permissions shape — Salesforce's own
permissions still decide every call:

| Option                              | Tools                                                                                           | Default |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- | ------- |
| Read records                        | orientation, search, query, get, related, relationship path, history, changes, file download    |
| Create and update records           | create, record tree, relate, update, upsert, log activity, task, note, attach file, bulk update |
| Delete records                      | delete pair                                                                                     | off     |
| Change record owners                | change owner pair                                                                               | off     |
| Find and run reports and dashboards | find, describe, run, run async, results; find, get and refresh dashboards                       | on      |

## The admin connector (`salesforce-admin`)

### Orgs: production and its sandboxes

An admin builds in a sandbox and promotes to production, so the admin connector covers more than
one org — the same way the CRM connector does (as built, below): **one connector per org, all of
the same type**, each self-contained — its own name, My Domain, consumer key and secret, switch and
capability ceiling, nothing inherited from production (a refreshed sandbox that carries
production's ECA is registered with the same key and secret, typed in again). Each person connects
each org separately on its own card, and each connection is its own grant (account id
`<orgId>/<userId>`, see Auth). Every `salesforce_admin_*` tool takes the `org` that
`salesforce_admin_list_orgs` reports, by name or key.

**Production writes are an org setting**: _off_ (sandboxes only — the safe default),
_change requests_ (the rule below), with no third option. Sandbox writes always use change
requests too; the setting exists because some organizations want production changed only by
their release process, never by Renkei.

### Confirm rule: change requests, applied in the browser

The Jira Admin rule, for the same reason
([`project-management-design.md`](./project-management-design.md), "The confirm rule, enforced on
the server"): in an external MCP host the confirm tool and the model hold the same token, and for
changes to the org's schema a host's promise to keep app-only tools from the model is not enough.
Every admin write is a **proposal** stored as a change request; nothing on the MCP surface applies
one; the person applies it from `/[slug]/salesforce-admin/changes/[id]` in their own browser
session. The exceptions are things only the admin can see — a report or
dashboard **draft** in their own private folder, and a new folder not yet shared with anyone;
publishing or sharing them is a change request like any other (see "Building report folders,
reports and dashboards for CRM users").

Salesforce gives this pattern something Jira does not — a dry run:

1. **Propose.** A `salesforce_admin_propose_*` tool reads the live metadata it is about to change,
   builds the exact package (XML files plus `package.xml`), and stores it in
   `salesforce_admin_change_requests`: owner, agent when an agent proposed it, org, kind, title,
   reason, the package, a human-readable list of changes, status, expiry (24 hours).
2. **Validate.** The proposal immediately runs a **check-only deploy** (`checkOnly: true`) against
   the org. Salesforce compiles everything, checks every reference, runs the tests the target
   requires, and changes nothing. The validation result — success, or every component error with
   Salesforce's message — is stored on the request and returned to the model, which can fix and
   re-propose before a person ever looks.
3. **Review.** The review page lists every component: a new field's full definition; for a changed
   one, old against new; for a layout, the sections and the fields moving in them; the validation
   result; and what else depends on what is changing (Tooling API `MetadataComponentDependency`).
4. **Apply.** Apply re-reads the live metadata, stops if anything the package was built on has
   changed since, and deploys — a **quick deploy** of the validated request where Salesforce
   allows one (tests ran and passed within the last 10 days), otherwise a full deploy with the same
   options. The result — each component's status, the deploy id, a link to Setup's Deployment
   Status — is stored on the request.
5. **Promote.** A request applied in a sandbox offers "propose for production" (or another
   sandbox): the same package, re-read and re-validated against the target, as a new change
   request. This is the admin's sandbox-to-production loop without change sets.

Deploys are transactional (`rollbackOnError`, which production requires anyway), so a request
applies entirely or not at all. Test level: `NoTestRun` when the package holds no Apex (allowed in
production), otherwise `RunLocalTests`.

### Writes go through the Metadata API, as deploys

One mechanism for every kind: generate the metadata files and deploy them through the Metadata
API's REST deploy (`/metadata/deployRequest`). Not the Tooling API's sObject writes, which cover
some types and not others, and not the SOAP CRUD calls (`createMetadata`, `updateMetadata`), which
cannot be validated without applying. One mechanism means one validation path, one review page,
one audit record, and promotion for free.

Reading current metadata is the other half, and here the APIs are uneven: the Tooling API answers
most reads in JSON (`EntityDefinition`, `FieldDefinition`, `CustomField` with its `Metadata`,
`ValidationRule`, `Layout`, `PermissionSet`, `FlexiPage`, `CustomApplication`), one record at a
time for the `Metadata` field; anything it does not expose falls back to the Metadata API's SOAP
`readMetadata`. Types whose deploy replaces the whole component (layouts above all) are always
read, merged and sent back whole, and the review page shows the merge. **Which types need the
SOAP fallback is the open seam to settle against a live org first.**

### Tools

**Orientation and reads** (no change request)

| Tool                                     | Does                                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `salesforce_admin_list_orgs`             | Registered orgs, which the person has connected, production or sandbox                                                                                                               |
| `salesforce_admin_check_access`          | Per org: the person's admin permissions (_Customize Application_, _Modify Metadata_, _Manage Users_…), edition, limits, API usage                                                    |
| `salesforce_admin_describe_object`       | An object's full schema for building: fields with types, formulas, defaults, help text, field history tracking, record types, validation rules, layouts and Lightning pages assigned |
| `salesforce_admin_get_field`             | One field's whole definition and where it is used (layouts, reports, flows, Apex — via dependencies)                                                                                 |
| `salesforce_admin_list_validation_rules` | With formulas and messages, active or not                                                                                                                                            |
| `salesforce_admin_get_layout`            | A page layout's sections and fields, and which profiles and record types use it                                                                                                      |
| `salesforce_admin_list_permission_sets`  | With object and field permissions for a named object, and who holds each                                                                                                             |
| `salesforce_admin_list_apps`             | Lightning apps, their tabs, who sees them                                                                                                                                            |
| `salesforce_admin_list_flows`            | Flows on an object, trigger type, active version — read-only in this version                                                                                                         |
| `salesforce_admin_audit_trail`           | Setup Audit Trail, filtered by section, person or date — "who changed this field?"                                                                                                   |
| `salesforce_admin_compare_orgs`          | One object's metadata in two orgs, side by side — "what's in UAT that isn't in production?"                                                                                          |
| `salesforce_admin_export_openapi`        | The org's OpenAPI 3.0 document for named objects (Salesforce's beta, when the org has it on), staged in the scratch space for a developer or a code project                          |
| `salesforce_admin_list_change_requests`  | The person's requests, their validation and apply status                                                                                                                             |

**Proposals** (each creates a validated change request and returns its review link)

| Tool                                        | Proposes                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `salesforce_admin_propose_object`           | A custom object: label, plural, API name, name field (text or auto-number), sharing model, features (activities, history, reports, search), with its first fields, a tab and a default layout                                                                                                                                                       |
| `salesforce_admin_propose_fields`           | New fields on an object — text, number, currency, percent, date/time, checkbox, email, phone, URL, long text, picklist (local or a global value set), multi-select, lookup, master-detail, formula, roll-up summary — with field history tracking, their placement on named layouts and their access in named permission sets                       |
| `salesforce_admin_propose_field_changes`    | Label, help text, description, required, default, length; type changes only where Salesforce allows them without data loss, otherwise refused with the reason                                                                                                                                                                                       |
| `salesforce_admin_propose_picklist_changes` | Add, rename, deactivate, reorder values; per record type availability; global value sets                                                                                                                                                                                                                                                            |
| `salesforce_admin_propose_validation_rule`  | New or changed rule: formula, error message, error location, active. The formula is checked by the validation deploy, not by Renkei                                                                                                                                                                                                                 |
| `salesforce_admin_propose_record_type`      | A record type with its picklist value subsets, its layout per profile, and which permission sets get it                                                                                                                                                                                                                                             |
| `salesforce_admin_propose_layout_changes`   | Fields, sections and related lists added, moved or removed on a page layout                                                                                                                                                                                                                                                                         |
| `salesforce_admin_propose_path`             | A Path on a picklist field (`PathAssistant`): per stage, key fields and guidance text, per record type                                                                                                                                                                                                                                              |
| `salesforce_admin_propose_quick_actions`    | Object-specific quick actions — _Update a Record_ and _Create a Record_ — with their fields, layout and predefined values, placed on the record page's action bar                                                                                                                                                                                   |
| `salesforce_admin_propose_compact_layout`   | The highlights panel's fields and their order, and making it the object's primary compact layout                                                                                                                                                                                                                                                    |
| `salesforce_admin_propose_record_page`      | A Lightning record page (`FlexiPage`) built from a structured description, not raw XML: Dynamic Forms field sections with visibility rules on field values, plus Highlights, Path, related lists and the activity timeline; cloned from the active page by default; activation per app, record type and profile on apply                            |
| `salesforce_admin_propose_stamp_rules`      | Field-update automation of one narrow, reviewable shape — "when field X changes (to V, while condition C), set fields to now / a value, only if blank" — generated as one before-save record-triggered Flow (_Fast Field Updates_). The review page shows the rules as a table, not Flow XML. Checked against the object's validation rules (below) |
| `salesforce_admin_propose_report_type`      | A custom report type: primary object, related objects (with or without), and its field layout — what reports on a new object are built on                                                                                                                                                                                                           |
| `salesforce_admin_propose_app`              | A Lightning app with its tabs, navigation, and utility items, visible to named permission sets                                                                                                                                                                                                                                                      |
| `salesforce_admin_propose_permission_set`   | A new permission set or changes to one: object CRUD, field read/edit, tab, app and record type visibility                                                                                                                                                                                                                                           |
| `salesforce_admin_propose_assignments`      | Assign or remove permission sets (and permission set groups) for named users — data, not metadata, so it applies as one DML transaction rather than a deploy, but through the same review page                                                                                                                                                      |
| `salesforce_admin_propose_application`      | The whole of a small application in one request — objects, fields, relationships, validation rules, layouts, tabs, an app and a permission set — from a description, so "build me a volunteer-hours tracker" is one review page rather than nine                                                                                                    |
| `salesforce_admin_promote_change_request`   | An applied request re-proposed against another org (see Promote)                                                                                                                                                                                                                                                                                    |

Field deletion is deliberately absent: a deleted custom field's data goes to Salesforce's
deleted-fields list for 15 days and then for good, and dependent reports break silently. The tool
answers "where is this field used" and links Setup; the deletion is the admin's, in Setup.

### Building report folders, reports and dashboards for CRM users

Admins build what CRM users run: the folders that organize and share them, the reports, and the
dashboards on top. None of it is schema — no object changes, and a draft or an empty folder nobody
else can see harms nothing — so it takes a lighter path than metadata, with the change-request rule
at the moment something reaches other people.

**The rule.** Direct: anything only the admin can see — a draft in their private folder, a new
folder not yet shared with anyone. A change request: anything other people can see or will gain —
publishing into a shared folder, sharing a folder, changing or deleting a published report or
dashboard, moving or renaming a shared folder.

Reports and dashboards are built where the CRM users are, usually **production**, so this work is
allowed in production under its own org setting (**Reports and dashboards in production**, on by
default), separately from the metadata **production writes** setting. Anything built in a sandbox
can be promoted like any other change request (as `ReportFolder`, `DashboardFolder`, `Report` and
`Dashboard` metadata).

#### Folders

Report folders and dashboard folders are separate in Salesforce, and both are what is shared — a
report or dashboard is visible to whoever its folder is shared with. With enhanced folder sharing,
folders nest (a subfolder inherits its parent's sharing), and sharing is _view_, _edit_ or
_manage_ for users, public groups and roles (with or without subordinates). All of it is the
**Analytics Folders API**, a top-level REST resource (`/services/data/v68.0/folders`, listed in the
REST API's resource list and documented in the Reports and Dashboards guide): `POST /folders`
creates a folder (`label`, `name`, `type` of `report` or `dashboard`, and `parentId` for a
subfolder; creating needs _Create Report Folders_ or _Create Dashboard Folders_); `GET
/folders/{id}` and `/children` read it; `PATCH /folders/{id}` renames it (the label, or the unique
name for admins; the type cannot change); `DELETE` removes it; `/shares` lists (`GET`), adds
(`POST`) or replaces (`PUT`) its shares, `/shares/{shareId}` changes one's access (`PATCH`) or
removes it (`DELETE`), and `/share-recipients?shareType=…` finds who can be shared with. Changing
or deleting a folder and its shares needs _manage_ access on it.

- **Create** a report or dashboard folder, at the top level or inside one the admin manages —
  direct while it is shared with nobody. A subfolder inherits its parent's sharing from the start,
  so creating one inside a shared folder is a change request that names who will see it.
- **Share** a folder, or change or remove its shares — a change request. The review page lists
  everything in the folder and its subfolders, now and later, and who gains or loses access, with
  those who already have it named and skipped.
- **Rename or delete** — direct for a folder shared with nobody, a change request otherwise.
  Salesforce deletes only empty folders, and the tool says what is still in one. The Folders API
  has no move: a folder's parent is set when it is created.

#### Reports

1. **Draft directly.** The admin describes the report in a sentence. The tools pick the report
   type, read its columns and filters, build the report metadata in the package's validator (which
   refuses an unknown column, a grouping on a field that cannot group, a filter operator the
   column's type does not take), create it in the admin's **private folder** (`POST
/analytics/reports` with the `reportMetadata`, or `?cloneId=` to start from an existing report),
   run it once, and show the first rows. Row-level formulas are `customDetailFormula` and summary
   formulas `customSummaryFormula` in that metadata; the report type's describe says which fields a
   row-level formula may use (`allowedInCustomDetailFormula`). Changing and re-running a draft is
   direct (`PATCH /analytics/reports/{id}`), as often as needed.
2. **Publish as a change request** into a folder (existing, or a new one the same request creates
   and shares) — on apply, a `PATCH` of the report's `folderId`. The review page shows the reports with a fresh sample run, everything already in
   the folder, and who can see it, and says that a folder share does not share the records behind
   the report: a viewer sees only rows their own access allows.
3. **Change a published report** the same way: old against new columns, groupings and filters, and
   a sample run of both — with every dashboard that uses the report named, since its components
   change too.

#### Dashboards

A dashboard is components (charts, metrics, gauges, tables) laid out in a grid, each fed by a
**summary or matrix report**, with optional dashboard filters and a **running user**. The
Dashboards API has no create-from-nothing: a new dashboard is a **clone** (`POST
/analytics/dashboards?cloneId=…`) that is then **saved** with `PATCH /analytics/dashboards/{id}`
and a `dashboardMetadata` body — its name, `folderId`, `components`, `layout`, `filters` and
`runningUser`. So the admin connector clones an existing dashboard when the admin names one to
start from, and otherwise clones a **starter dashboard**: a near-empty dashboard in a folder only
admins can see, deployed once per org as `Dashboard` metadata through an ordinary change request
the first time an admin drafts a dashboard there.

1. **Draft directly** in the admin's private dashboard folder: the components — each with its
   source report, the grouping and aggregate it shows, the chart type, title, sort and limit — the
   layout, and up to three dashboard filters. The validator refuses a component on a tabular
   report or a grouping the report does not have, and checks each filter against the source
   reports with the Dashboard Filter Options Analysis resource (`POST
…/dashboards/{id}/filteroptionsanalysis`). Saved, refreshed once (`PUT`, then `…/status`), and
   read back with each component's values, so the admin sees it work.
2. **Publish as a change request** into a dashboard folder, the way reports are published (a
   `PATCH` of `folderId` in `dashboardMetadata`). The
   review page shows each component's latest values, the source reports — and whether they sit in
   folders the dashboard's viewers can open, since a viewer who cannot open the source report cannot
   drill into the component — and above all **who the dashboard runs as**:
   - _Run as a specified user_: every viewer sees that user's data. The review page names the user
     and says plainly that viewers will see numbers drawn from that user's access, which may be
     more than their own.
   - _Run as the viewer_ (a dynamic dashboard): each viewer sees their own data. Salesforce limits
     how many dynamic dashboards an org may have, and the review page says how many are in use.

   The default is to run as the viewer when the org has room, and the admin chooses otherwise
   explicitly.

3. **Change or retire a published dashboard** as a change request, showing old against new
   components and filters.

#### Tools

| Tool                                         | Resource                                                                                                                                                 | Does                                                                                                                                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `salesforce_admin_list_report_types`         | `GET /analytics/reportTypes`, `/analytics/reportTypes/{type}`                                                                                            | Report types, standard and custom, and a type's columns, groupable fields and filters                                                                                                                              |
| `salesforce_admin_list_folders`              | `GET /folders`, `/folders/{id}/children`, `/folders/{id}/shares`                                                                                         | Report and dashboard folders as a tree, what is in each (a `Report`/`Dashboard` query by folder), and who each is shared with                                                                                      |
| `salesforce_admin_create_folder`             | `POST /folders` (`label`, `name`, `type`, `parentId`)                                                                                                    | A new report or dashboard folder or subfolder; direct while unshared, a change request inside a shared parent                                                                                                      |
| `salesforce_admin_propose_folder_changes`    | apply: `/folders/{id}/shares` (`POST`/`PUT`), `/shares/{shareId}` (`PATCH`/`DELETE`), `PATCH`/`DELETE /folders/{id}`; `/share-recipients` to resolve who | Share or unshare, change access, rename, or delete an empty folder                                                                                                                                                 |
| `salesforce_admin_draft_report`              | `POST /analytics/reports` (or `?cloneId=` from an existing report)                                                                                       | A new draft in the admin's private folder: format (tabular, summary, matrix), columns, groupings, filters and filter logic, relative dates, row-level and summary formulas, buckets, sort, chart; run once on save |
| `salesforce_admin_update_draft_report`       | `PATCH /analytics/reports/{id}`                                                                                                                          | Change a draft (refused for a report in a shared folder — that is a proposal)                                                                                                                                      |
| `salesforce_admin_delete_draft_report`       | `DELETE /analytics/reports/{id}`                                                                                                                         | Discard a draft                                                                                                                                                                                                    |
| `salesforce_admin_propose_report_publish`    | apply: `POST /folders` when new, `PATCH /analytics/reports/{id}` (`folderId`), folder `shares`                                                           | Publish drafts to a folder (and share it)                                                                                                                                                                          |
| `salesforce_admin_propose_report_changes`    | apply: `PATCH`/`DELETE /analytics/reports/{id}`                                                                                                          | Change or retire a published report                                                                                                                                                                                |
| `salesforce_admin_draft_dashboard`           | `POST /analytics/dashboards?cloneId=` (a named dashboard or the starter), then `PATCH` with `dashboardMetadata`, `PUT` to refresh                        | A new draft dashboard in the admin's private dashboard folder: components, layout, filters, running user                                                                                                           |
| `salesforce_admin_update_draft_dashboard`    | `GET …/describe`, `PATCH /analytics/dashboards/{id}`, `POST …/filteroptionsanalysis`                                                                     | Add, change, move or remove components and filters on a draft                                                                                                                                                      |
| `salesforce_admin_delete_draft_dashboard`    | `DELETE /analytics/dashboards/{id}`                                                                                                                      | Discard a draft                                                                                                                                                                                                    |
| `salesforce_admin_propose_dashboard_publish` | apply: `PATCH /analytics/dashboards/{id}` (`folderId`), folder `shares`                                                                                  | Publish drafts to a dashboard folder (and share it)                                                                                                                                                                |
| `salesforce_admin_propose_dashboard_changes` | apply: `PATCH`/`DELETE /analytics/dashboards/{id}`                                                                                                       | Change or retire a published dashboard                                                                                                                                                                             |

Formulas are checked by Salesforce when a report is saved, and its error is returned verbatim. A
report on a new custom object needs a report type first: `salesforce_admin_propose_report_type`
(metadata) comes before the draft. Everything above is checked against the v68.0 guides in this
folder (see "Reference documents").

### Checks Salesforce's dry run does not do

A check-only deploy proves the metadata compiles and references resolve. It does not notice that
two correct components contradict each other once Salesforce's order of execution runs them, and
on a stage-driven object that is the most likely mistake. So proposals that add or change
validation rules or stamp rules also run a small static check over the object's **active**
validation rules and before-save stamp rules (read through the Tooling API), and the review page
shows what it finds:

- **A stamp that defeats a rule.** Before-save flows run before validation rules. A stamp rule
  that sets field F when the stage becomes S, next to a validation rule requiring F when the stage
  is S, means the rule can never fire — and F holds "the moment the stage changed", not the value
  the rule was meant to make someone enter.
- **A rule nothing can satisfy, or a stage nothing can reach,** where the formulas are simple
  enough to read (`ISPICKVAL`, `ISBLANK`, `ISCHANGED`, `PRIORVALUE` over picklists and blanks):
  a forward-only rule plus a required field that only a later stage makes visible, for instance.
- **A terminal value without its rule,** when sibling values each have one (every outcome but one
  requires a reason).

These are warnings, not refusals: the admin may intend them. Anything the check cannot parse is
reported as "not checked", never as clean.

### Admin scope picker

| Option                                | Tools                                                                                | Default |
| ------------------------------------- | ------------------------------------------------------------------------------------ | ------- |
| Read org configuration                | all reads                                                                            | on      |
| Propose objects and fields            | object, fields, field changes, picklists, validation rules, record types             | on      |
| Propose layouts, apps and tabs        | layout changes, record page, path, quick actions, compact layout, app, report type   | on      |
| Build folders, reports and dashboards | report types, folders, report and dashboard drafts, publish, changes, folder sharing | on      |
| Propose field-update automation       | stamp rules                                                                          | on      |
| Propose permission sets               | permission set                                                                       | on      |
| Propose user access                   | assignments                                                                          | off     |
| Propose whole applications            | application, promote                                                                 | on      |

## Reference documents

Salesforce's official developer guides for the pinned version, **v68.0 (Winter '27, last updated
October 9, 2026)**, downloaded from `resources.docs.salesforce.com` and kept beside the other
vendor references in this folder:

| File                                                                                                                         | Covers                                                                                                                                                                                           | Used by |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| [`salesforce-rest-api-developer-guide.pdf`](./salesforce-rest-api-developer-guide.pdf)                                       | sObject resources (describe, rows, upsert, updated/deleted, blob), query, search, composite collections and tree, limits, the resource list (including `/folders`), OAuth                        | both    |
| [`salesforce-soql-sosl-reference.pdf`](./salesforce-soql-sosl-reference.pdf)                                                 | SOQL (relationship queries, aggregates, `toLabel()`, `FORMAT()`, date literals) and SOSL                                                                                                         | both    |
| [`salesforce-reports-dashboards-rest-api-developer-guide.pdf`](./salesforce-reports-dashboards-rest-api-developer-guide.pdf) | Reports (list, describe, run sync and async, create, clone, save, delete, report types), Dashboards (list, results, describe, refresh, clone, save, delete, filter options), and the Folders API | both    |
| [`salesforce-metadata-api-developer-guide.pdf`](./salesforce-metadata-api-developer-guide.pdf)                               | Metadata types and the REST `deployRequest` (check-only, quick deploy of a validated request)                                                                                                    | admin   |
| [`salesforce-tooling-api-developer-guide.pdf`](./salesforce-tooling-api-developer-guide.pdf)                                 | Reading metadata in JSON (`EntityDefinition`, `FieldDefinition`, `ValidationRule`, `Layout`, `FlexiPage`…) and `MetadataComponentDependency`                                                     | admin   |

They are point-in-time copies: when the pin moves, replace them with that version's guides in the
same change.

## Not in this version

- **Apex, triggers, Lightning Web Components, and free-form Flow authoring.** Generating code
  and Flow XML is possible but the review page cannot honestly show a non-developer what a
  300-line Flow does, and production Apex needs tests that would themselves be generated. The one
  exception is `salesforce_admin_propose_stamp_rules`' fixed shape, which reads as a table. Other
  Flows are readable; activating or deactivating an existing version is a small change request.
- **User management** — creating users, freezing, resetting passwords, licences. The ADManager
  Plus connector's territory in spirit; a stage of its own if wanted.
- **Bulk data loads** (Bulk API 2.0) — imports and mass updates beyond Composite's 200 records,
  on the admin connector, as change requests with a staged CSV; the next stage after this version,
  since data migration is part of most rebuilds of an object. When old records
  will not pass new rules, the load should run under a **bypass custom permission** the rules and
  flows check (assigned to the loading admin for the load only), not with the rules switched off
  org-wide while everyone else keeps working.
- **Report and dashboard subscriptions** (scheduled delivery to people) — the next report stage.
- **Indexing** (and with it `verifyAccess` on `UserRecordAccess`).
- **CRM Analytics, Data Cloud, Marketing Cloud, Experience Cloud** — separate products and APIs.
- **Platform Events / Change Data Capture triggers** ("an opportunity closes" as an agent trigger).
  Attractive, and the trigger framework is ready for it, but it needs a subscriber process holding
  a long-lived streaming connection per org; designed separately.

## Stages

1. **Foundation.** `hostsForGrant` in the delegate, `SalesforceAdapter`, both config forms, both
   catalog entries and cards, the connect flow (My Domain, PKCE, revoke on disconnect), the
   package's API version and SOQL builder, `salesforce_check_access` and
   `salesforce_admin_check_access`.
2. **CRM records.** Orientation, search, query, get, related, create, update, upsert, activities,
   record trees, relating records, relationship paths, history, changes, files, bulk update and delete pairs, change
   owner, API budget — tested against more than one org shape (a standard sales org and one that is
   mostly custom objects, with a managed package installed), so nothing org-specific creeps in.
3. **CRM reports and dashboards.** Find, describe, run (sync and async), results; find,
   read and refresh dashboards; results shaped for storytelling (scope, groupings, comparison runs,
   charts).
4. **Admin reads and the change-request machinery.** Org registry, admin reads, the
   change-request table, validation on propose, the review page, apply with quick deploy.
   Folder, report and dashboard building rides the same machinery: report types, folders, drafts,
   publish, changes and folder sharing — early, because it needs no metadata deploys and CRM users benefit at once.
5. **Admin proposals.** Fields and picklists first (the most frequent chore), then objects,
   validation rules, record types, layouts, permission sets, apps, assignments; then Path, quick
   actions, compact layouts, report types, stamp rules and record pages.
6. **Whole applications and promotion.** Acceptance test: rebuilding a stage-driven custom
   object end to end — fields, Path, record page, quick actions, stamp rules, validation rules,
   report type and reports — in a sandbox, then promoted.

Each stage adds tools and no new OAuth scopes — Salesforce's scopes are settled in stage 1 — so
nobody reconnects between stages.

## As built (first part)

Stage 1 and the CRM connector's records and reports (stages 2 and 3) are built; the as-built
description is the `salesforce` section of [`connectors.md`](./connectors.md). Where the build
differs from the text above:

- **Session length is not a setting.** The adapter records an hour per access token
  (`SALESFORCE_SESSION_SECONDS`), shorter than Salesforce's two-hour default, and the delegate's
  refresh-and-retry on a 401 covers an org whose timeout is shorter still. No form field.
- **The API budget is a fixed 80%** for read tools, not an org setting yet. `check_access`
  answers over budget, since it is how a person sees the usage.
- **One connector per org, of the same type.** An organization adds a Salesforce connector for
  each org people work in — production and each sandbox — on `/admin/connectors/salesforce`, a
  list kept as `settings.orgs` on the `salesforce` config row (`orgsFromSettings`,
  `validateOrg` in `packages/connector-salesforce/src/orgs.ts`, at most 20). Each is
  self-contained: a name (its key is derived from it and kept on rename), its My Domain, its own
  consumer key and secret (sealed as `clientSecret:<key>`), its own switch and ceiling. No two
  share a name or a host. The connectors page shows one card per connector (a Sandbox badge on
  sandboxes); connect and disconnect are `/api/salesforce/<key>/authorize|grant`, the pending
  row carries `connector_key` (migration 158), and the callback trades the code at that
  connector's token endpoint with its credentials, refuses a token for any other org, stores
  `metadata.connector`, and revokes the person's earlier grant to the same connector as someone
  else. Connections to a connector an admin removed stay revocable from a "removed orgs" card.
- **Host pinning is per grant**, as designed: `ProviderSpec.hostsFor(config, grant, pending)`
  returns the one host of the grant's connector (or, before the commit, of the pending exchange's
  connector) and nothing when that connector is switched off; the delegate checks it after
  resolving the grant, so a sandbox token never reaches production's host or the reverse.
- **One tool family, an `org` argument.** Every `salesforce_*` tool takes an optional `org` (a
  connector's name or key); `salesforce_list_orgs` lists them and the person's connection to
  each. With no `org`, a person connected to one org gets it, connected to several gets the one
  production org, and otherwise the tool refuses and names the orgs — never a guess about where
  a write lands. Registration takes the union of a person's connections' capabilities; each call
  is checked against the capabilities of the connection it runs on. Preview + confirm pairs carry
  the org in the confirm's arguments.
- **`salesforce_create_record_tree` is a preview + confirm pair**, as the confirm table says for
  multi-record writes; the tools table above names it as one tool.
- **Files are not built yet** (`salesforce_download_file` / `salesforce_attach_file`), nor the
  object and field exclusion list, the data-classification switch, or the long-text rule beyond
  `get_record`'s default view. They come before the connector is turned on for sensitive data.
- **The scope gate fails closed.** `withScopeGate` passes every tool through when the capability
  list is undefined; the Salesforce module passes an empty list instead, so a grant without
  recorded capabilities registers nothing.

## Open questions

1. **Single-record writes direct, or preview + confirm?** This doc says direct (receipt in the
   result), with bulk, delete, owner change and sharing behind a card. An organization that
   wants every CRM write confirmed could get an org setting for it.
2. **Production writes default.** This doc defaults the admin connector to sandboxes only. An org
   without sandboxes (Essentials, some nonprofit editions) would have to turn production on to
   use it at all.
3. **The SOAP fallback for metadata reads** — which types the Tooling API cannot read in a
   deployable form, settled against a live org in stage 5.
4. **API version — decided: v68.0** (Winter '27). The folder, report formula and dashboard
   save shapes are now confirmed against its guides; what remains is a live-org check of the
   starter-dashboard clone-and-save flow.
