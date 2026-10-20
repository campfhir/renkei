# Salesforce connectors — design

A point-in-time design doc (see [`README.md`](./README.md)). Nothing here is built yet; when it
is, the as-built description belongs in a `salesforce` and a `salesforce-admin` section of
[`connectors.md`](./connectors.md), and this file stays as the record of why.

Two connectors, one vendor — the `jira`/`jira-admin`, `onbase`/`onbase-admin` and
`microsoft`/`entra-developer` arrangement:

| Connector          | Who it is for                                                         | What it does                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `salesforce`       | Everyone who works in Salesforce as a CRM — sales, service, nonprofit | Find, read, create, update and delete records of standard and custom objects; log activity; read, run, author and share reports; read dashboards |
| `salesforce-admin` | Salesforce administrators and app builders                            | Build applications: define custom objects and fields, picklists, validation rules, record types, layouts, apps and tabs, permission sets         |

## What they are for

**The CRM connector** answers the questions people otherwise click through Salesforce for — "what
did we last hear from Acme?", "which of my opportunities close this month?", "how much has this
donor given since 2023?" — and does the routine data work that follows: log the call, move the
stage, fix the address, create the follow-up task. Reports are the other half of everyday
Salesforce: people want an existing report run with a different filter, a new report built from a
sentence ("open cases by owner, this quarter, as a summary by priority"), and that report handed to
a colleague.

**The admin connector** is for the people who change the shape of the org rather than the rows in
it. An administrator building an application does the same dozen things in Setup: create an
object, add its fields, add picklist values, write validation rules, put the fields on a layout,
give it a tab and an app, and grant a permission set — usually in a sandbox first, then again in
production. The connector does that work from a sentence, shows exactly what it will deploy, and
deploys it only when the admin applies it.

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

- the pinned API version (one constant; bumped deliberately, never "latest");
- id helpers (15 ↔ 18-character conversion, key-prefix to object via a describe cache);
- **SOQL safety**: a builder that escapes string literals (`\'`, `\\`, `\n`…) and validates
  identifiers against the describe, used by every tool that composes a query from arguments;
  `salesforce_query` takes the model's own SOQL but parses it far enough to refuse anything that is
  not a single `SELECT` and to add `LIMIT` when absent;
- report metadata builders and validators (formats, groupings, filters, boolean filter logic);
- metadata XML builders (`package.xml`, `CustomObject`, `CustomField`, `ValidationRule`,
  `RecordType`, `Layout` merges, `PermissionSet`, `CustomApplication`, `CustomTab`) and the deploy
  result parser;
- the nonprofit model detector and field maps (below).

Salesforce is internet SaaS, so there is no dedicated worker: HTTP runs in `apps/web` through the
delegate's authenticated fetch, the Entra Developer arrangement. The admin connector's deploy
needs a zip builder — the one new dependency, and it lives in the package so it is tested without
a network.

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

| Action                                                       | Confirm                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Create one record, update one record, log an activity        | Direct; the result shows each field's old and new value and links the record          |
| Update or create more than one record                        | Preview + confirm — the card lists every record and every field change                |
| Delete (any number)                                          | Preview + confirm — the card names each record and its child records that go too      |
| Change a record's owner                                      | Preview + confirm — it changes who can see it                                         |
| Share a report (folder share), subscribe someone else to one | Preview + confirm — the card lists everything else in the folder that becomes visible |
| Create, update or delete a report                            | Direct for the person's own private folder; preview + confirm in a shared folder      |

Single-record writes are direct because that is how people use a CRM — the result is the receipt,
and the record's own history (where field history is tracked) and the person's own eyes on the
link are the undo. Deleted records go to the Recycle Bin for 15 days; the delete result says so
and links it. Agents follow the same table through their staged actions: a direct write is a step,
a preview + confirm write is a step with `needsApproval` ([`agents.md`](./agents.md)).

The card is the existing issue-preview widget for record changes, and `directory_action_preview`
for shares (its `person` slot shows the recipient, its group lists the folder's reports).

### Tools

**Orientation**

| Tool                         | Does                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `salesforce_check_access`    | Who the connection is (user, profile, role, org, edition, sandbox or not), which nonprofit model is installed, API usage today                         |
| `salesforce_list_objects`    | The objects the person can see (describeGlobal, filtered to queryable and not system plumbing), label and API name                                     |
| `salesforce_describe_object` | Fields (type, required, updateable, picklist values per record type, relationships), record types, child relationships — trimmed to what a model needs |

**Records**

| Tool                                             | Does                                                                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `salesforce_search`                              | SOSL across objects by text ("everything about Acme"), or one object with filters (parameterized search)                      |
| `salesforce_query`                               | SOQL `SELECT`, one page at a time with a cursor, relationship and aggregate queries allowed                                   |
| `salesforce_get_record`                          | One record with display values and labels (UI API), optionally named related lists                                            |
| `salesforce_list_related`                        | A related list of a record (a contact's opportunities, an account's cases), paged                                             |
| `salesforce_create_record`                       | Create one record; record type by name; picklist values checked against the record type before sending                        |
| `salesforce_update_record`                       | Update one record's fields; reads first so the result shows old → new                                                         |
| `salesforce_upsert_record`                       | Create-or-update by an external id field                                                                                      |
| `salesforce_update_records_preview` / `_confirm` | Many records, one change set (Composite sObject collections, all-or-none by default)                                          |
| `salesforce_delete_records_preview` / `_confirm` | Delete; the preview names cascade-deleted children (master-detail) from the describe                                          |
| `salesforce_change_owner_preview` / `_confirm`   | Reassign records; the preview names the new owner and what sharing changes                                                    |
| `salesforce_log_activity`                        | A completed Task (call, email, meeting note) or an Event, related to the record(s) named                                      |
| `salesforce_create_task`                         | An open follow-up Task assigned to the person or a named user, with a due date                                                |
| `salesforce_add_note`                            | A Note (ContentNote) attached to a record                                                                                     |
| `salesforce_list_actions`                        | The quick actions the org built for an object or record ("Log a Call", "Close Case"), with their fields and predefined values |
| `salesforce_run_action`                          | Run one of those quick actions on a record — the org's own sanctioned verb, same confirm rule as an update                    |
| `salesforce_record_history`                      | Field history of a record (the object's `__History` table): who changed which tracked field, from what, to what, when         |

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
  compact layout (UI API), which is how Salesforce itself identifies a record in a lookup — "the
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
    the controlling field's value (UI API `picklist-values` carries `controllerValues`);
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
- **Reports on custom objects** need no extra tools: custom report types appear in
  `salesforce_list_report_types` like standard ones.
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
change, before-save flows that stamp dates, quick actions that are the sanctioned way to do a step.
The record tools work with that rather than around it:

- **The result is re-read after the write.** The old → new list on a create or update includes the
  fields automation changed, not only the ones sent — "Stage → Site Visit; also set by the org:
  Stage Last Changed 2026-10-20 14:02" — so nobody is surprised by a stamped date later.
- **A blocked save names the missing field.** Salesforce's error carries the rule's message and the
  field it is attached to (`fields` on the error). The tool returns both, and the model asks the
  person for exactly that value ("When is the site visit scheduled?") instead of guessing a date
  to get past the rule. It never writes a placeholder to satisfy a validation rule.
- **The org's quick actions come first.** When an object has a quick action for what the person
  asked ("log a call attempt"), the model is steered to `salesforce_run_action`, which sends only
  that action's fields with its predefined values — the admin's definition of the step — rather
  than a free-form update.
- **Read-modify-write is conditional.** Updates computed from the current value (a call-attempt
  counter plus one) send `If-Unmodified-Since` with the record's `LastModifiedDate`, so a colleague's
  save in between is a conflict to re-read, not a lost update.
- **Page visibility is not access.** Dynamic Forms hide fields on the record page by stage; the API
  does not. The connector can write any field field-level security allows, at any stage, so the
  org's validation rules — not the page layout — are what keep a stage's data in order. The
  describe marks which fields the person can edit; it does not pretend to know the page's
  visibility rules.

Files (ContentVersion download and upload) use the sandbox scratch space the way OnBase and Jira
attachments do ([`sandbox-connector-design.md`](./sandbox-connector-design.md)) and come in a
later stage.

**Reports and dashboards**

The Reports and Dashboards REST API (`/analytics/…` under the pinned version).

| Tool                                                      | Does                                                                                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `salesforce_find_reports`                                 | By name, folder or owner — a SOQL query on `Report`, since `GET /analytics/reports` only lists the recently viewed                                                                           |
| `salesforce_describe_report`                              | Its type, format, columns, groupings, filters and folder                                                                                                                                     |
| `salesforce_run_report`                                   | Run it, optionally with filters changed for this run only (nothing saved); summary rows and aggregates by default, detail rows on request (Salesforce caps synchronous detail at 2,000 rows) |
| `salesforce_run_report_async`                             | The same as an async instance, for reports too slow to run inline; results read back by instance id                                                                                          |
| `salesforce_export_report`                                | Run and stage the result as a spreadsheet in the sandbox scratch space, for a person to download or another connector to send                                                                |
| `salesforce_list_report_types`                            | Report types the person can build on, and a type's available columns and filters                                                                                                             |
| `salesforce_create_report`                                | Build one from a report type: format (tabular, summary, matrix), columns, groupings, filters, boolean filter logic, chart; saved to a named folder or the person's private one               |
| `salesforce_update_report`                                | Change columns, groupings, filters, name, description                                                                                                                                        |
| `salesforce_clone_report`                                 | Save a copy, optionally into another folder — the usual first step before sharing a private report                                                                                           |
| `salesforce_delete_report_preview` / `_confirm`           | Delete one (it goes to the Recycle Bin)                                                                                                                                                      |
| `salesforce_list_report_folders`                          | Folders the person can see, with their access to each (view, edit, manage)                                                                                                                   |
| `salesforce_share_report_preview` / `_confirm`            | Share — see below                                                                                                                                                                            |
| `salesforce_subscribe_report`                             | Subscribe the person to a report on a schedule, with optional conditions; subscribing others is preview + confirm and needs Salesforce's own permission to add recipients                    |
| `salesforce_list_dashboards` / `salesforce_get_dashboard` | A dashboard's components and their current values; `refresh` re-runs it                                                                                                                      |

**Building a report from a sentence** goes: pick the report type (`salesforce_list_report_types`
with the object named), describe it for the column and filter names, build the metadata in the
package's validator (which refuses an unknown column, a grouping on a non-groupable field, a
filter operator the column's type does not take), create it in the person's private folder, run
it once, and show the first rows — so the person sees the report work before anyone else does.
The builder covers what operational reports on a custom object actually use: groupings down (and
across for a matrix), relative date filters ("rolling 90 days", "this quarter"), filter logic,
**row-level formulas** (days between two milestone dates), **summary formulas** (enrolled ÷ total
as a percentage), bucket fields, and sort order. Row-level and summary formulas are checked by
Salesforce when the report is saved; the tool returns its error verbatim. (The exact
`reportMetadata` keys for row-level formulas are to be confirmed against the pinned API version.)

### Sharing a report

Salesforce does not share a report; it shares the **folder** the report is in. That is the one
design point here that is easy to get wrong:

- A report in the person's private folder ("My Personal Custom Reports") cannot be shared at all.
  The preview says so and proposes the fix: clone it into a folder the person can manage (named
  or new), then share that folder.
- Sharing a folder shares **everything in it**, now and later. The preview lists every report and
  dashboard already in the folder, so "share the pipeline report with Pat" cannot quietly also
  hand Pat the compensation report sitting beside it. When the folder holds anything else, the
  preview offers "a new folder with just this report" as the default.
- Recipients resolve by name or address to a user, public group or role (with or without
  subordinates) — the share types Salesforce's folder shares accept — and access is _view_ unless
  the person asks for _edit_ or _manage_. People who can already see the folder are named as
  such and skipped.
- The share is the Folders resource's `shares` collection; the person needs _manage_ on the
  folder, and Salesforce checks it. Recipients must also hold access to the report type's objects
  to see any rows — the preview says that sharing a report does not share the records behind it.

"Send Pat a link" is a separate, cheaper ask: the tool returns the report's Lightning URL, and the
chat can send it through WebEx or Outlook if those connectors are on.

### Nonprofit orgs

There are two nonprofit data models in the wild, and the connector must work on both without the
model having to know which it is talking to:

|                    | NPSP (Nonprofit Success Pack, a managed package)           | Nonprofit Cloud (Salesforce's newer industry model)                        |
| ------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| Detected by        | `npsp__` / `npe01__` / `npe03__` objects in describeGlobal | `GiftTransaction` in describeGlobal                                        |
| Donor              | Contact, in a Household Account                            | Person Account                                                             |
| Household          | Account (household record type)                            | Party Relationship Group                                                   |
| A gift             | Opportunity (+ `npe01__OppPayment__c` payments)            | `GiftTransaction`                                                          |
| Recurring          | `npe03__Recurring_Donation__c`                             | `GiftCommitment` + schedule                                                |
| Fund / designation | `npsp__General_Accounting_Unit__c` + `npsp__Allocation__c` | `GiftDesignation` + `GiftTransactionDesignation`                           |
| Programs           | Program Management Module (`pmdm__`), when installed       | `Program`, `ProgramEnrollment`, `BenefitAssignment`, `BenefitDisbursement` |

Everything above works on either model unchanged — they are just objects. On top, a few
model-aware tools whose field maps live in the package:

- `salesforce_find_constituent` — a person by name, address or email, with their household and
  its members.
- `salesforce_giving_summary` — lifetime, this year, last gift, largest gift, recurring status, by
  designation. NPSP reads its rollup fields on Contact and Account; Nonprofit Cloud aggregates
  `GiftTransaction`. Both say which they used.
- `salesforce_record_gift_preview` / `_confirm` — a one-off gift for a constituent, with
  designation and campaign. Always preview + confirm (money, receipts and acknowledgement
  letters hang off it). On NPSP it creates the Opportunity with its primary contact so NPSP's own
  triggers create the payment and roll the totals; on Nonprofit Cloud it creates the
  `GiftTransaction` and its designations.
- `salesforce_list_program_enrollments` / `salesforce_record_service` — program participation and
  service delivery, where PMM or Nonprofit Cloud Programs is present.

Gift entry through NPSP's Data Import batches or Nonprofit Cloud's Gift Entry (which add donor
matching and batch totals) is the better path for anything beyond one gift at a time; that is a
later stage, and the exact processing calls must be confirmed against a live org of each model
before it is built.

### Scope picker

The CRM card's checkboxes narrow what registers, the Mirth permissions shape — Salesforce's own
permissions still decide every call:

| Option                              | Tools                                                                                                  | Default |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ | ------- |
| Read records                        | orientation, search, query, get, related                                                               | on      |
| Create and update records           | create, update, upsert, log activity, task, note, bulk update                                          | on      |
| Delete records                      | delete pair                                                                                            | off     |
| Change record owners                | change owner pair                                                                                      | off     |
| Read and run reports and dashboards | find, describe, run, export, folders, dashboards                                                       | on      |
| Author and share reports            | create, update, clone, delete, share, subscribe                                                        | on      |
| Nonprofit tools                     | constituent, giving summary, record gift, programs — registers only when a nonprofit model is detected | on      |

## The admin connector (`salesforce-admin`)

### Orgs: production and its sandboxes

An admin builds in a sandbox and promotes to production, so the admin connector holds more than
one org. A `salesforce_admin_orgs` table (the `mirth_instances` shape, but OAuth rather than
password): name, My Domain URL, whether it is production, and optionally its own consumer key and
secret (a sandbox refreshed from production usually carries production's ECA, so the default is
"same as production"). The org admin registers sandboxes on the admin form; each person connects
each org separately on the card, and each connection is its own grant (account id
`<orgId>/<userId>`, see Auth). Every `salesforce_admin_*` tool takes the `org` that
`salesforce_admin_list_orgs` reports, by name or id.

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
session.

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

| Option                          | Tools                                                                              | Default |
| ------------------------------- | ---------------------------------------------------------------------------------- | ------- |
| Read org configuration          | all reads                                                                          | on      |
| Propose objects and fields      | object, fields, field changes, picklists, validation rules, record types           | on      |
| Propose layouts, apps and tabs  | layout changes, record page, path, quick actions, compact layout, app, report type | on      |
| Propose field-update automation | stamp rules                                                                        | on      |
| Propose permission sets         | permission set                                                                     | on      |
| Propose user access             | assignments                                                                        | off     |
| Propose whole applications      | application, promote                                                               | on      |

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
- **Indexing** (and with it `verifyAccess` on `UserRecordAccess`).
- **Files** on the CRM connector (ContentVersion through the scratch space).
- **Gift entry batches** on NPSP and Nonprofit Cloud.
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
   bulk update and delete pairs, change owner, API budget — exercised against the org's own custom
   objects (auto-number names, custom lookups, dependent picklists) as much as standard ones.
3. **Reports.** Find, describe, run (sync and async), export, report types, create, update, clone,
   delete, folders, share, subscribe, dashboards.
4. **Nonprofit.** Model detection, constituent, giving summary, record gift, programs — built and
   tested against one NPSP and one Nonprofit Cloud org.
5. **Admin reads and the change-request machinery.** Org registry, admin reads, the
   change-request table, validation on propose, the review page, apply with quick deploy.
6. **Admin proposals.** Fields and picklists first (the most frequent chore), then objects,
   validation rules, record types, layouts, permission sets, apps, assignments; then Path, quick
   actions, compact layouts, report types, stamp rules and record pages.
7. **Whole applications and promotion.** Acceptance test: rebuilding a stage-driven custom
   object end to end — fields, Path, record page, quick actions, stamp rules, validation rules,
   report type and reports — in a sandbox, then promoted.

Each stage adds tools and no new OAuth scopes — Salesforce's scopes are settled in stage 1 — so
nobody reconnects between stages.

## Open questions

1. **Single-record writes direct, or preview + confirm?** This doc says direct (receipt in the
   result), with bulk, delete, owner change and sharing behind a card. An organization that
   wants every CRM write confirmed could get an org setting for it.
2. **Production writes default.** This doc defaults the admin connector to sandboxes only. An org
   without sandboxes (Essentials, some nonprofit editions) would have to turn production on to
   use it at all.
3. **The SOAP fallback for metadata reads** — which types the Tooling API cannot read in a
   deployable form, settled against a live org in stage 5.
4. **API version.** Pin to the release current when stage 1 starts, and verify the Folders
   (report sharing) resource paths and the report spreadsheet export against that version.
5. **Gift entry processing calls** on NPSP and Nonprofit Cloud, before the batch stage.
