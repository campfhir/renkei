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

## LLM exposure: read / act / destructive

The connection row carries the person's choice of what the model may
attempt with a credential they already hold — a narrowing, never a
widening, and read by the tools, never by the worker's request path:

- **read** — the floor; every connection mounts the read tools.
- **act** (`tool_access = 'read_write'`) — deploy, undeploy, start / stop /
  pause / resume / halt, enable, initial state, import a channel, send and
  reprocess messages, edit the configuration map and global scripts, toggle
  alerts, and the generic POST/PUT tool.
- **destructive** (`allow_destructive`) — separate consent, because these
  are permanent: deleting a channel (with its message store), removing
  messages, and the generic destructive pair. What counts as destructive is
  decided by one function (`isDestructiveRequest`): every `DELETE`, plus
  the `POST`/`PUT` routes that remove data, purge stores, replace the whole
  server configuration, install or uninstall an extension, run a database
  task, change a password, or clear statistics. Deploying, undeploying and
  stopping are reversible and stay ordinary writes.

Destructive operations are **preview + confirm only**, on the shared
issue-preview card, so a human click sits between the model and the
irreversible act — the fileshare-delete discipline. The generic write tool
refuses a destructive route and points at the preview, so the
classification cannot be bypassed by choosing the "other" tool.

## "All the REST API functions"

Mirth's API is ~200 routes. Hand-writing a tool per route would be a
maintenance liability and a worse experience for a model than a handful of
well-phrased tools plus an escape hatch, so the surface is two layers:

- **Curated tools** for the everyday work, phrased in Mirth's own terms
  and unwrapping Mirth's XStream-flavoured JSON — a list arrives as
  `{"list":{"channel":[…]}}`, a map as `{"map":{"entry":[…]}}`, and a
  single element as a bare object rather than a one-item array — into
  readable lines.
- **Generic tools** for everything else: `mirth_api_get` (any GET),
  `mirth_api_request` (any non-destructive POST/PUT), and the destructive
  preview/confirm pair (any DELETE or destructive write). `mirth_describe_api`
  reads the server's **own** OpenAPI document (`/api/openapi.json`, falling
  back to `/api/swagger.json`) and filters it by keyword, so the model can
  find the exact path and parameters without Renkei carrying a copy of the
  spec that would drift from the server it talks to.

Every route on the server is reachable through one of those, and every
one of them passes the same path validation, the same exposure gate, and
the same worker — nothing is out of reach and nothing is unguarded.

Mirth objects (channels, alerts, code templates…) travel as the **XML the
Administrator exports** where a tool hands one to the server:
`mirth_get_channel` with `format: "xml"` returns exactly what
`mirth_import_channel` accepts, so an assistant can round-trip an edit; the
generic write tool defaults to `application/xml` for the same reason. JSON
is what the tools read, because it is easier to unwrap than to parse XML
without a dependency; XML is what they write, because it is Mirth's
canonical form and round-trips without the JSON dialect's quirks.

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
- **A vendored copy of Mirth's OpenAPI spec** — the server's own document
  is read instead, so the tools never claim a route the running version
  does not have.
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
