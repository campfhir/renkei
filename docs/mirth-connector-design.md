# Mirth Connect connector — decision log

Shipped alongside the code; this records the decisions and their reasons,
the way `fileshares-connector-design.md` did. The as-built reference is the
`connector-mirth` section of [`connectors.md`](./connectors.md).

## What it is

A connector for Mirth Connect — NextGen Connect **4.5.2**, the last
open-source release, which is what the organization runs — exposing the
whole of its REST API over MCP, for **N instances**: an org keeps several
Mirth servers (dev, test, prod, sometimes one per site), and a person needs
to say "on prod" or "on dev" and have the assistant act on that one.

## The model: N instances, each person their own Mirth account

Two shapes were on the table:

1. **One `connector_configs` row per environment** with a service account,
   the OnBase shape. Rejected: `connector_configs` is one row per connector
   key, so N instances would mean N connector keys (`mirth-dev`,
   `mirth-prod`…) minted in code for something an operator should add at
   runtime; and a service account is a super-credential reachable through
   any web-app bug, with every channel on every server in its blast radius.
2. **A registry of instances plus per-user credentials**, the file-share
   shape (migration 062's reasoning). Chosen. `mirth_instances` is what an
   operator maintains — name, an environment label, the server URL, the
   TLS policy; `mirth_instance_connections` is one row per (instance,
   person) holding that person's own Mirth username and password, sealed
   under `TOKEN_ENCRYPTION_KEY`. Mirth has a real user directory with
   roles and channel-level permissions (and, in many orgs, an LDAP
   authentication plugin), so delegating authorization to it is exactly
   RENKEI.md Decision #2: the provider decides what the account may do.
   If a compromise happens, it is bounded by one person's own Mirth
   account, which the Mirth admins already audit.

A shared "renkei" Mirth account is still possible — an org can hand the
same credentials to several people — but that is the org's choice, not a
Renkei super-credential.

## Permissions: named, per area, per instance

The first cut recorded the person's choice as a ladder — read, act,
destructive. It shipped and was replaced (migration 107) at the
organization's request: the words meant little to the person ticking
them, and one switch covered too much — "may deploy a channel" had to
mean "may edit its definition" as well.

The choice is now a set of **named permissions a person recognises**,
grouped by area (`packages/connector-mirth/src/permissions.ts`):

| Area           | Permissions                |
| -------------- | -------------------------- |
| Channels       | read, edit, deploy, delete |
| Messages       | read, send, delete         |
| Alerts         | read, edit, delete         |
| Code templates | read, edit, delete         |
| Users          | read, edit, delete         |
| Events         | read                       |
| Server         | read, configure, restore   |

Every `mirth_*` tool names exactly one — in the curated module by hand,
in the operation table as a field the tests check (a read-kind operation
must carry a read permission; a permanent one a delete, restore or edit
one). A tool registers for a caller when **some** connected instance
grants its permission, so the tool list tells the truth; the handler
re-checks the permission on the instance the call names, so holding
"deploy" on dev never deploys on prod. The card offers presets (Read
only, Operate, Develop, Everything) as starting points over a grid a
person can adjust tick by tick. "Read messages" is its own permission
because message content is PHI, and "delete" is separate from "edit"
everywhere because deletion is permanent.

Permanent operations (delete a channel, purge messages, delete an alert,
restore the server…) are **also** preview + confirm on the shared
issue-preview card, whatever the permission says — the fileshare-delete
discipline — so a human click sits between the model and the act.

These narrow what the tools may attempt with a credential the person
already holds. They never widen anything: the Mirth server's roles still
judge every request by the connected account, and the worker never reads
them.

## "All the REST API functions"

Mirth's API is ~200 routes. The first cut phrased ~40 of them as curated
tools and reached the rest through generic `mirth_api_get` /
`mirth_api_request` tools plus a lookup over the server's OpenAPI
document. That was replaced before it shipped, at the organization's
request: a generic tool has no schema of its own, so a model gets no
validation on the arguments that matter (which path parameter, which
query type, which body), and the tool list stops being a catalog of what
the server can do. Every route is now a **named tool with its own
schema**, in two layers:

- **Curated tools** for the everyday work, phrased in Mirth's own terms
  and unwrapping Mirth's XStream-flavoured JSON — a list arrives as
  `{"list":{"channel":[…]}}`, a map as `{"map":{"entry":[…]}}`, and a
  single element as a bare object rather than a one-item array — into
  readable lines.
- **Generated tools** for everything else, from a declarative operation
  table in the package (`operations.ts`, transcribed from the 4.5.2
  servlet interfaces): each entry names the route's path parameters,
  query parameters (typed: string, int, boolean, list, ISO date, enum)
  and body (an XML document, plain text, form fields, or multipart XML
  parts), and the web app turns it into a `mirth_<operation>` tool whose
  zod schema IS that specification. The table is tested for internal
  consistency (every `{param}` declared, unique names, GETs have no body)
  and for agreement with `isDestructiveRequest` on what is destructive,
  so the exposure gate and the table cannot drift apart.

Every route on the server is one of those, and every one passes the same
exposure gate and the same worker — nothing is out of reach and nothing
is unguarded. Left out of the table on purpose: the `POST … _getX` body
variants of GET routes (the same operation, already named once), login /
logout (the worker owns the session), and `POST /extensions/_install`
(a zip upload; file bytes never travel through tool arguments here).

Mirth objects (channels, alerts, code templates…) travel as the **XML the
Administrator exports** where a tool hands one to the server:
`mirth_get_channel` with `format: "xml"` returns exactly what
`mirth_import_channel` accepts, so an assistant can round-trip an edit,
and the generated write tools take the same documents. JSON is what the
tools read, because it is easier to unwrap than to parse XML without a
dependency; XML is what they write, because it is Mirth's canonical form
and round-trips without the JSON dialect's quirks.

## Names, not just ids

Mirth's API speaks ids everywhere — UUIDs for channels, alerts, code
templates, libraries, groups, tags and resources, integers for users and
connectors — and a person speaks names. Making every tool take both, and
answer with both, was a requirement rather than a nicety:

- **Inbound**, one wrapper (`withReferenceResolution`) around every tool
  registration resolves `instanceId` (id, name or a unique environment
  label — "prod") and every reference argument by name, using one naming
  convention shared by the curated and generated tools (`REF_ARGS`: an
  argument called `channelId` is a channel wherever it appears,
  `metaDataId` a connector of the channel the same call names, and so
  on). Handlers only ever see ids, so no tool has to know a name was
  given. The rules are conservative: an exact id first, then an exact
  name, then a case-folded name; a miss re-reads the listing once (a
  channel created a moment ago must resolve); a UUID that matches nothing
  passes through; a name that matches nothing or several things is
  refused with the candidates — never a guess.
- **Outbound**, a successful answer that mentions UUIDs gets a legend of
  the ones the directory knows, minus those whose name is already in the
  text, so a raw document from a generated tool still reads and the
  curated tools (which print names beside ids) are not repeated.
- **Explicitly**, `mirth_resolve_ids` / `mirth_resolve_names` for a list
  in either direction, for the cases where the id itself is the point
  (an XML document to hand back, a report).

The directory behind it is the same listing routes the tools use, cached
sixty seconds per caller, instance and kind — a burst of calls costs one
listing — and it is injectable, so the tool tests run against a fixed
table rather than a worker.

## The dedicated worker process

Mirth servers live on private networks, which the web app's SSRF guard
refuses to dial by design, so all HTTP happens in `apps/worker-mirth` — the
OnBase and fileshare arrangement — behind a bearer key
(`MIRTH_WORKER_API_KEY`), on its own image (`renkei-mirth`). The worker:

- resolves the instance and the **caller's own** credential per call from
  the store (a request can name a tenant, an instance and a subject, never
  a host), and is the only process that decrypts one;
- logs in with `POST /api/users/_login` and keeps **one session-cookie
  jar per (instance, person)**. Mirth writes a login event to its own
  audit log per login, and an org may cap sessions per account, so a
  fresh login per tool call would be both noisy and fragile; the jar is
  keyed on the person so one caller's session can never act as another,
  and on the instance so dev and prod never share one. A 401 drops the
  jar and the call retries exactly once after a fresh login; a second 401
  is Mirth's answer and is forwarded. An idle jar lapses on its own — no
  heartbeat, agent traffic is bursty;
- dials with `node:https` directly, because TLS policy is **per
  instance**: Mirth ships with a self-signed certificate and most on-prem
  installs keep one. An operator can pin an internal CA (`ca_pem`) — the
  preferred answer — or, as an explicit recorded decision, switch
  verification off for that instance (`tls_verify = false`). Global
  `fetch` cannot express either per request without pulling in undici as
  a dependency. Plaintext `http://` is refused unless
  `allow_insecure_http` is recorded, the OnBase discipline;
- envelopes the upstream status and body back verbatim (a 403 is Mirth's
  authorization verdict on the account, not the worker's), and buffers
  bodies up to a cap so a runaway response fails loudly.

The connect flow validates a credential against the live server through
the worker's `test-connection` op **before** anything is stored (a wrong
password is an immediate 4xx), and the admin form has an unauthenticated
`probe` — a 401 from the server is the healthy answer, it proves a Mirth
REST API is listening. Disconnecting asks the worker to `logout` first,
then deletes the sealed credential.

## What deliberately did not ship

- **Knowledge indexing** — retrieval-only. Message content is PHI-adjacent
  by nature (HL7, FHIR), and indexing it under per-user credentials would
  mean indexing as somebody; this waits for a deliberate design, as it
  does for file shares.
- **Renkei-side ACLs** — none. Mirth's roles are the authority; if an org
  needs an assistant to see less than a person's account can, the Mirth
  admin narrows the account.
- **A generic "issue any request" tool** — replaced by the generated
  named tools (above); a route the table does not know is a table entry
  to add, not an escape hatch to reach for.
- **Extension-specific routes as curated tools** (server log, global map
  viewer, data pruner…) — reachable through the generic tools; the set
  installed varies per server.

## Operational notes

- Availability = the caller's exposure aggregate over connected enabled
  instances, resolved per MCP connection: any connection mounts the read
  tools; act and destructive each mount their families only when opted
  into somewhere, and every act handler re-checks the per-instance choice
  fresh on each call.
- Bulk channel operations run one request per channel id (Mirth's
  bulk routes take form-encoded or XStream-typed bodies that a model gets
  wrong more often than a list of ids), capped at 50 per call, with
  `returnErrors=true` so a failure names the channel.
- Bounds: 20s login / 60s call timeouts in the worker, 16 MiB response
  cap, and every tool clips what it hands the model (60 000 characters by
  default, per-part caps for message content).
- Audit: admin instance CRUD writes `mirth.instance.created/updated/deleted`;
  connects and disconnects write `mirth.connected/disconnected` (exposure
  choice and the server version seen at connect time, never a credential).
