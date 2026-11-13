# Sandbox orchestrator — design

As-built for the first phase; "What is not done yet" at the end is the
honest list of what still runs the old way.

## What changes

Until now the sandbox was one container (or a few replicas of it) that
every caller shared: `apps/worker-sandbox`, with each caller's commands
dropped to a uid of their own inside it, and — for code project services
— a way to the host's Docker engine, kept behind a socket proxy. Callers
were _assigned_ to an instance (`sandbox_instances`, migration 179).

With the orchestrator there is no shared sandbox. Each **scope** gets a
machine of its own, made the first time it is needed:

| Scope          | Key callers route by | Used for                                                      |
| -------------- | -------------------- | ------------------------------------------------------------- |
| a person       | their subject        | their own chats' scratch space, browser, scripts              |
| an agent       | `agent:<id>`         | that agent's runs (acting as its owner)                       |
| a chat project | `chat-project:<id>`  | every chat in the project, whoever in the project is chatting |
| a code project | `code-project:<id>`  | the checkout, and every chat in the project                   |
| nobody         | `system`             | calls made for no caller (image rules, capability asks)       |

A chat that is in a project is served by the **project's** sandbox, not
its person's (`sandboxRouteKey`, packages/sandbox-client routing.ts): a
project shared with others never works inside one member's personal
sandbox. Inside it each member is still their own caller — their own
uid, their own staged files. **Who may work in a project at all is the
web app's check** (`lib/chat/access.ts`, before any call is made), and
nothing but the web app and the queue worker can reach a sandbox; on
Azure a preview port is additionally opened only to the members who
asked for it, by name (below).

A sandbox is a Linux machine running the same sandbox image as before —
the sandbox worker, serving one scope. It is **suspended** when nothing
has called it for 15 minutes, **resumed** by the next call, and
**evicted once it has been idle for 24 hours**: what it holds is
archived, compressed, to the blob store, and its machine is removed. The
next call for the scope makes a new machine and unpacks the archive into
it before anyone is served — checkouts, uncommitted work and staged
files are where they were; what was running (a kernel, a dev server)
starts again.

The isolation boundary moves from "a uid inside a shared container" to
"a machine of your own": in production a hardware-isolated microVM
([Azure Container Apps sandboxes](https://learn.microsoft.com/azure/container-apps/sandboxes-overview)),
locally a container. The per-caller uid drop inside the worker stays —
it now separates the worker's own secrets from the commands it runs, and
the members of a project from each other.

## The pieces

```
web app / queue worker ──ensure(scope)──▶ worker-orchestrator ──▶ provider ──▶ a sandbox per scope
        │                                        │                  (Docker engine | Azure sandbox group)
        │                                        └── sandboxes table (Postgres)
        └────────── the call itself, to the sandbox's own address, with its own key ──────────▶
```

- **`packages/sandbox-orchestrator`** — the library.
  - `provider.ts`: the `SandboxProvider` interface — `create`, `inspect`,
    `suspend`, `resume`, `destroy`, `list`, `check`. A provider keeps no
    state and decides nothing.
  - `docker-provider.ts`: a container per sandbox on a Docker engine. The
    local stand-in for Azure, and a real provider for a single host.
    Suspend is `stop` (disk kept, memory returned — Azure's disk mode) or
    `pause` (processes kept — Azure's memory mode).
  - `azure-provider.ts`: a microVM per sandbox in a sandbox group, through
    `@azure/containerapps-sandbox` (a preview SDK, pinned exactly and held
    behind a five-method interface so a change in it lands in one file).
  - `orchestrator.ts`: `ensure(scope)`, `sweep()`, `remove(scope)`.
- **`apps/worker-orchestrator`** — the service: `POST /v1/ensure`,
  `/v1/list`, `/v1/remove`, `GET /health`, and a timer running `sweep`.
  The **only** process holding the means to make a machine (the engine's
  socket, or the sandbox group's role). It runs nobody's code.
- **`sandboxes`** (migration 180, `store/domains/sandboxes`) — one row per
  sandbox: scope, provider, the provider's name for the machine, state,
  address, last activity.
- **`sandbox_archives`** (migration 181) — where a scope's archive is in
  the blob store: at most one per scope.
- **`packages/sandbox-client` `routing.ts`** — with
  `SANDBOX_ORCHESTRATOR_URL` set, "which instance is this caller assigned
  to" becomes "ask the orchestrator where this scope's sandbox is". None
  of the client's ~100 operations changed.

## Lifecycle

```
          claim              ready (archive unpacked)        idle 15 min
 (no row) ─────▶ provisioning ─────────────────────▶ running ───────────▶ suspending ─▶ suspended
                      │                               ▲   │                               │  │
                      │ failed                        │   │                   next call   │  │
                      ▼                               │   │              resuming ◀───────┘  │
                   deleted ◀── deleting ◀── archiving ◀───┴──────────────────────────────────┘
                                  (archive written)        idle 24 h
```

- **Every change of state is a compare-and-set on the row.** Whoever moves
  it does the work; everyone else waits for the row. Any number of
  orchestrators may run.
- **A scope has at most one sandbox that is not deleted** (a partial
  unique index), so two first calls make one machine.
- **Activity is the call.** The client asks the orchestrator before a call
  and remembers the answer for ten seconds; the asking is what moves
  `last_active_at`. Nothing inside the sandbox is consulted.
- **A row is believed for 30 seconds.** Past that — or when a caller says
  its last call did not connect — the provider is asked first. That is how
  a sandbox the platform suspended or removed by itself is noticed.
- **The sweep** (every 30 s) suspends what has been idle 15 minutes,
  evicts what has been idle 24 hours, puts right any transition
  abandoned for 10 minutes (from what the provider says), removes any
  machine whose row is gone (found by the sandbox id every machine is
  labelled with), drops archives nobody has come back for in 90 days,
  and purges `deleted` rows after a week.
- On Azure the platform's own auto-suspend is set as a **backstop** at
  twice the orchestrator's interval, so sandboxes still stop costing
  compute if every orchestrator is down. The platform's auto-delete is
  off: only the orchestrator removes a sandbox, after its archive.

## Eviction, archive and restore

1. **Evict.** The sandbox moves to `archiving`. It is resumed if it was
   suspended (only a running sandbox can hand over what it holds), and
   the orchestrator asks its worker for an archive
   (`POST /v1/archive`): a `tar` of the two disks — staged files and
   checkouts, with every owner, mode and link — compressed with
   Zstandard as it streams.
2. **Keep.** The orchestrator relays the stream into the blob store
   (`sandbox-archives/<hash of scope>/<sandbox id>.tar.zst`) a block at a
   time; it is never held whole or unpacked outside a sandbox. The
   archive is recorded in `sandbox_archives`, replacing the scope's
   previous one.
3. **Remove.** Only now is the machine removed.
4. **Restore.** The next call for the scope makes a new machine; once its
   worker answers, the orchestrator streams the archive into it
   (`POST /v1/restore`), which unpacks it at the same paths, and only
   then is the sandbox `running`.

The rule throughout is **no archive, no removal**. If the sandbox will
not hand its contents over, or the blob store refuses them, the sandbox
is put back — suspended, with its disk — and the eviction is tried again
a quarter of an hour later. If an archive cannot be unpacked, the call
fails and the archive stays: nobody is served an empty sandbox standing
in for their work. An orchestrator that dies mid-archive leaves a
sandbox that is put back as it was.

Compression is Zstandard because source trees and dependency
directories shrink to a fraction at a speed that does not hold an
eviction up (in the end-to-end run, 11 MB of text became 1.2 KB).

Archives go to the organization's file storage — the store set up on
Organization → Storage, or the deployment's own where the organization
has none — under `sandbox-archives/`. An archive is kept until the
scope's next eviction replaces it, or the organization's archive
retention (admin → Settings → Sandbox, 90 days unless changed) passes
with nobody coming back. Removing a scope's sandbox on request
(`/v1/remove`) removes its archive too. **With no storage configured an
archive cannot be written, so the sandbox is not removed**: it stays
suspended, with its work, until there is somewhere to keep it.

Both intervals are part of the organization's sandbox setup (below).

## Keys and what a sandbox holds

- Each sandbox's worker takes a bearer key **of its own**:
  `HMAC(SANDBOX_WORKER_API_KEY, sandbox id)`. The orchestrator hands it to
  the caller with the address. The deployment's key is never inside a
  sandbox, so what one sandbox holds opens no other.
- A sandbox is started with the variables the organization's sandbox
  setup names (below) — in practice what the shared worker had: the
  database URL of the narrowed **sandbox role**, its delegate key, the
  environment-secrets key. Never the organization's encryption keys: the
  setup refuses those names when it is saved, and again when it is read.
- **No sandbox has a way to the host's container engine.** The socket is
  mounted in the orchestrator alone, which is what retires the socket
  proxy.

## Services inside the sandbox

A code project's services — a Postgres, a Redis beside the checkout —
were containers the shared worker started on the host's engine. In an
orchestrated sandbox they run **inside the sandbox itself**, on a
container engine of its own: Podman, started by the image's entrypoint
(`docker/sandbox-entrypoint.sh`) when the orchestrator made the machine.
Podman's socket speaks the Docker API, so the worker's service code
(`services.ts`, `docker.ts`), the organization's image allow-list and
its registry credentials are unchanged; only the engine they talk to is
now the sandbox's own. The socket is root's inside the sandbox, so a
caller's command still cannot open it.

- A service is reached from the project's commands at its address on an
  internal network, as before; it shares the sandbox's memory and disk.
- Services do not survive an eviction (their images and volumes are not
  in the archive) or, on Docker's `stop` suspend, a suspension; the
  worker notices and the project starts them again — as it already did
  when a service's lifetime ran out.
- On Azure a sandbox is a microVM and runs the engine as it is. A local
  Docker container can only when privileged
  (“Run sandboxes privileged” in the sandbox setup): for a
  developer's machine, never a shared host. Without it the worker
  reports services as a capability it lacks.

## Who may call a sandbox (Azure)

Microsoft Entra decides, enforced by the platform's ingress outside the
sandbox (the setup's “Worker port: Microsoft Entra”, the default).

- **The worker's port** takes a bearer token for the ingress
  (`https://auth.adcproxy.io`) from the identities listed in
  the setup's “Allowed identities” — the orchestrator's own. The
  orchestrator gets that token as itself and answers it to callers with
  the sandbox's address, so the web app and the queue worker need no
  Azure identity. The ingress strips `authorization` before the request
  reaches the sandbox, so the per-sandbox key — still checked, as a
  second lock — rides `x-sandbox-key`.
- **A preview port** is opened to the people who open the preview, by
  name. A preview's link in the Code section goes to the web app's own
  route (`…/previews/[name]/open`), which checks the session is a member
  of the project and reads the person's email **from that session** —
  nothing the browser sends says who it is. It asks the orchestrator to
  let that person in at the port (`POST /v1/expose`), added to whoever
  was let in before, and redirects the browser to the sandbox, where
  they sign in with the same account. Stopping the preview closes the
  port. Where there is no such door (Docker, no orchestrator, a session
  without an email) the route redirects to the web app's relay, as
  before.

  Two limits: someone removed from a project keeps a port they had
  already opened until that preview is stopped; and the project's own
  server must listen on all interfaces to be reached this way.

With “Worker port: Sandbox key only” the worker's port is guarded by
the per-sandbox key alone. On Docker there is no ingress: the key is the
bearer, on a network only the callers share.

## Where sandboxes are set up

Not in the environment. Where sandboxes are made, how large they are,
the idle rules and what each is started with are **the organization's
own configuration**: one row in `connector_configs`
(`sandbox-orchestrator`), its secrets sealed with the deployment key
like every connector's. An operator edits it on **Organization →
Sandboxes** (`apps/web/app/(app)/admin/sandboxes`):

- **Provider** — Azure Container Apps sandboxes (subscription, resource
  group, sandbox group, region, disk image, size, VNet connection) or a
  Docker engine (image, networks, size).
- **Identity** (Azure) — a service principal's tenant id, client id and
  client secret, or nothing, for the orchestrator's own managed identity.
- **Who may call a sandbox** (Azure) — Entra or the sandbox key alone,
  the allowed identities, allowed source ranges.
- **When a sandbox is idle** — suspend after, evict after.
- **What a sandbox is started with** — variables by name; their values
  are secrets.

Secrets are write-only: the page shows which are stored, never what they
are, and a blank field keeps the stored one. **Test connection** hands
the setup about to be saved to the orchestrator, which asks the provider
whether it answers (the identity, its role and the sandbox group on
Azure; the engine and the image on Docker) without making a sandbox.

One module says what a valid setup is
(`packages/sandbox-client/src/orchestrator-config.ts`): the admin routes
check a submitted form with it and the orchestrator reads the stored row
with it. The orchestrator re-reads the row every quarter of a minute and
rebuilds itself when it has changed (`apps/worker-orchestrator`
`host.ts`, `stored.ts`), so a save takes effect with no restart. Until a
usable setup is stored it makes nothing, and every call — and the page —
says why.

Sandboxes are made for you: the first call for a scope makes its
sandbox. Nothing is created by hand.

What stays in the environment is only what a process needs before it can
read the database, and the keys two processes share:

| Where                 | Variable                                                   | For                                       |
| --------------------- | ---------------------------------------------------------- | ----------------------------------------- |
| orchestrator          | `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`                     | reading the stored setup                  |
| orchestrator          | `SANDBOX_ORCHESTRATOR_API_KEY`                             | the key its callers present               |
| orchestrator          | `SANDBOX_WORKER_API_KEY`                                   | each sandbox's own key is derived from it |
| web app, queue worker | `SANDBOX_ORCHESTRATOR_URL`, `SANDBOX_ORCHESTRATOR_API_KEY` | reaching the orchestrator                 |

## Running it locally

No Azure subscription needed — the Docker provider gives the same
lifecycle.

```sh
docker build -f docker/Dockerfile --target sandbox -t renkei-sandbox:latest .

# the orchestrator, on the host (with the TOKEN_ENCRYPTION_KEY and
# LOG_ENCRYPTION_KEY the other workers run with)
SANDBOX_ORCHESTRATOR_API_KEY=dev-orchestrator-key \
SANDBOX_WORKER_API_KEY=dev-sandbox-key \
DATABASE_URL=postgres://renkei:renkei@localhost:5432/renkei \
pnpm --filter @renkei/worker-orchestrator dev

# the web app
SANDBOX_ORCHESTRATOR_URL=http://127.0.0.1:8097 SANDBOX_ORCHESTRATOR_API_KEY=dev-orchestrator-key pnpm dev
```

Then, as an operator, on Organization → Sandboxes: provider **Docker
engine**, image `renkei-sandbox:latest`, “Publish on” `127.0.0.1`, and
the variables a worker needs (`DATABASE_URL` as the sandbox reaches it,
e.g. `postgres://renkei:renkei@host.docker.internal:5432/renkei`). Save,
then Test connection.

In the deploy stack it is the `orchestrator` compose profile
(`docker-compose.yaml`, `worker-orchestrator`).

## Running it on Azure

In Azure, once:

1. Create a sandbox group and import the sandbox image as a disk image.
2. Give the orchestrator's identity — its managed identity, or a service
   principal — the **Container Apps SandboxGroup Data Owner** role on the
   group.
3. Connect the group to the VNet the database and the delegate are on.

Then on Organization → Sandboxes: the subscription, resource group,
sandbox group and region; the disk image and the VNet connection by
name; the service principal's ids and secret (or neither, for a managed
identity); the identity allowed to call a worker; and the variables a
worker is started with. Test connection, then Save.

One step may still need the portal: the preview SDK sets a port's
allowed emails but not the tenant id that scripted (bearer) calls
require. If the worker's port refuses the service identity, switch
“Worker port” to **Sandbox key only** while that is sorted out.

**The Azure provider has not been run against a live sandbox group.** It
is written against the SDK's types and tested against a stand-in for the
SDK; the service is in preview. Expect to adjust it on first contact —
in particular the state words (`azureState`), whether a port's URL is
present on a sandbox that has just resumed, how environment variables
reach a process started from the image's entrypoint, whether Entra's
port policy admits a service identity (Microsoft's documentation
describes users) and whether Podman starts as it is in the microVM.

## What is not done yet

- **The sandbox worker is still a database client.** Every sandbox holds
  the sandbox role's URL. The blast radius is one scope's machine rather
  than everyone's, and the role is narrow, but the end state is a worker
  that reaches no database: metadata through the orchestrator or the web
  app. On Azure this is also what requires the VNet connection.
- **A chat moved between projects.** Which project a chat is in is
  remembered for a minute, and what the chat staged before the move stays
  in the sandbox it was staged in.
- **Shared preview links while suspended.** A share link names no caller,
  so it is looked for among _running_ sandboxes only, and following one
  does not count as activity. A member opening the preview resumes it.
- **Busy but uncalled.** Idle means "no call for 15 minutes". A long
  build started by one call and never polled is suspended with its
  sandbox. On Azure (memory mode) it continues on resume; on Docker
  (`stop`) it is lost.
- **Archive size.** An archive is everything on the two disks,
  dependency directories and build output included. Nothing is excluded
  and nothing is capped; a project with a very large checkout takes that
  long to evict and to come back.
- **The old path is still there.** Without `SANDBOX_ORCHESTRATOR_URL`
  everything works as before (shared instances, `sandbox_instances`, the
  host's engine behind a socket proxy for services). With services now
  inside the sandbox nothing in the orchestrated path needs the proxy;
  removing the old path, and the proxy with it, is the remaining step.
- **Sandbox egress policy.** Azure's per-sandbox egress rules (and secret
  injection at the proxy) are not configured; a sandbox has the network
  its group and VNet give it.
