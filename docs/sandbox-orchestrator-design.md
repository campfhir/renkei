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

| Scope          | Key callers route by | Used for                                                |
| -------------- | -------------------- | ------------------------------------------------------- |
| a person       | their subject        | their chats' scratch space, browser, scripts            |
| an agent       | `agent:<id>`         | that agent's runs (acting as its owner)                 |
| a code project | `code-project:<id>`  | the checkout, and every chat's scratch space inside it  |
| nobody         | `system`             | calls made for no caller (image rules, capability asks) |

A sandbox is a Linux machine running the same sandbox image as before —
the sandbox worker, serving one scope. It is **suspended** when nothing
has called it for 15 minutes, **resumed** by the next call, and
**removed, with everything it holds, once it has been idle for 24
hours**. The next call after that starts from a fresh machine: a
repository is cloned again, a kernel starts again — the same thing that
already happened when an instance was replaced.

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
- **`packages/sandbox-client` `routing.ts`** — with
  `SANDBOX_ORCHESTRATOR_URL` set, "which instance is this caller assigned
  to" becomes "ask the orchestrator where this scope's sandbox is". None
  of the client's ~100 operations changed.

## Lifecycle

```
            claim                    ready                idle 15 min
 (no row) ────────▶ provisioning ───────────▶ running ───────────────▶ suspending ──▶ suspended
                         │                     ▲   │                                      │
                         │ failed              │   │ idle 24 h              next call     │ idle 24 h
                         ▼                     │   ▼                                      ▼
                      deleted ◀── deleting ◀───┼───┴──────────────────── resuming ◀───────┤
                                      ▲        └──────────────────────────────┘           │
                                      └───────────────────────────────────────────────────┘
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
  removes what has been idle 24 hours, puts right any transition
  abandoned for 10 minutes (from what the provider says), removes any
  machine whose row is gone (found by the sandbox id every machine is
  labelled with), and purges `deleted` rows after a week.
- On Azure the platform's own lifecycle policy is set as a **backstop** at
  twice the orchestrator's intervals, so sandboxes still stop costing
  money if every orchestrator is down.

Both intervals are configuration (`SANDBOX_IDLE_SUSPEND_MINUTES`,
`SANDBOX_IDLE_DELETE_HOURS`).

## Keys and what a sandbox holds

- Each sandbox's worker takes a bearer key **of its own**:
  `HMAC(SANDBOX_WORKER_API_KEY, sandbox id)`. The orchestrator hands it to
  the caller with the address. The deployment's key is never inside a
  sandbox, so what one sandbox holds opens no other.
- A sandbox is started with the `SANDBOX_TEMPLATE_ENV_*` variables the
  orchestrator was given — in practice what the shared worker had: the
  database URL of the narrowed **sandbox role**, its delegate key, the
  environment-secrets key. Never the organization's encryption keys
  (`scripts/check-compose-secrets.mjs` asserts this for the orchestrator
  as it does for the sandbox).
- **No sandbox has a way to a container engine.** That is what retires the
  Docker socket proxy: the socket is mounted in the orchestrator alone.

## Running it locally

No Azure subscription needed — the Docker provider gives the same
lifecycle.

```sh
docker build -f docker/Dockerfile --target sandbox -t renkei-sandbox:latest .

# orchestrator on the host, sandboxes published on loopback (plus the
# LOG_ENCRYPTION_KEY the other workers run with)
SANDBOX_ORCHESTRATOR_API_KEY=dev-orchestrator-key \
SANDBOX_WORKER_API_KEY=dev-sandbox-key \
SANDBOX_DOCKER_PUBLISH_HOST=127.0.0.1 \
SANDBOX_TEMPLATE_ENV_DATABASE_URL=postgres://renkei:renkei@host.docker.internal:5432/renkei \
DATABASE_URL=postgres://renkei:renkei@localhost:5432/renkei \
pnpm --filter @renkei/worker-orchestrator dev

# the web app
SANDBOX_ORCHESTRATOR_URL=http://127.0.0.1:8097 SANDBOX_ORCHESTRATOR_API_KEY=dev-orchestrator-key pnpm dev
```

In the deploy stack it is the `orchestrator` compose profile
(`docker-compose.yaml`, `worker-orchestrator`). The full list of
variables is in `packages/sandbox-orchestrator/src/config.ts`.

## Running it on Azure

1. Create a sandbox group and import the sandbox image as a disk image.
2. Give the orchestrator's identity the **Container Apps SandboxGroup
   Data Owner** role on the group (`DefaultAzureCredential`: a managed
   identity, or `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` /
   `AZURE_CLIENT_SECRET`).
3. Connect the group to the VNet the database and the delegate are on,
   and name that connection in `SANDBOX_AZURE_VNET_CONNECTION`.
4. Set `SANDBOX_PROVIDER=azure` and the `SANDBOX_AZURE_*` variables.

Each sandbox's worker port is exposed through the platform's HTTPS
ingress with anonymous access, authenticated by the sandbox's own bearer
key; restrict who can reach it with `SANDBOX_AZURE_ALLOWED_CIDRS` or a
private endpoint.

**The Azure provider has not been run against a live sandbox group.** It
is written against the SDK's types and tested against a stand-in for the
SDK; the service is in preview. Expect to adjust it on first contact —
in particular the state words (`azureState`), whether a port's URL is
present on a sandbox that has just resumed, and how environment
variables reach a process started from the image's entrypoint.

## What is not done yet

- **Code project services** (a Postgres or Redis beside a checkout).
  These were containers the sandbox worker started through the Docker
  socket. An orchestrated sandbox has no engine, so the worker reports
  the capability missing and the tools do not register. The intended
  shape: the orchestrator makes them, as sibling machines on the
  project's own network. Until then, a deployment that needs services
  stays on the shared worker.
- **The sandbox worker is still a database client.** Every sandbox holds
  the sandbox role's URL. The blast radius is one scope's machine rather
  than everyone's, and the role is narrow, but the end state is a worker
  that reaches no database: metadata through the orchestrator or the web
  app. On Azure this is also what requires the VNet connection.
- **Chat projects.** A chat in a (non-code) project uses its person's
  sandbox. Giving a chat project a sandbox of its own means its chats
  sharing one scratch space, which is a product change as well as a
  routing one.
- **Shared preview links while suspended.** A share link names no caller,
  so it is looked for among _running_ sandboxes only, and following one
  does not count as activity. A member opening the preview resumes it.
- **Busy but uncalled.** Idle means "no call for 15 minutes". A long
  build started by one call and never polled is suspended with its
  sandbox. On Azure (memory mode) it continues on resume; on Docker
  (`stop`) it is lost.
- **Data at removal.** Removal after 24 idle hours takes the checkout
  with it, uncommitted work included. Staged files already had a 24-hour
  life; checkouts did not. A warning before removal, or a volume that
  outlives the machine, is the follow-up.
- **The old path is still there.** Without `SANDBOX_ORCHESTRATOR_URL`
  everything works as before (shared instances, `sandbox_instances`,
  the worker's own Docker client). Removing it — and with it the socket
  proxy — is the last step, once services have moved.
- **Sandbox egress policy.** Azure's per-sandbox egress rules (and secret
  injection at the proxy) are not configured; a sandbox has the network
  its group and VNet give it.
