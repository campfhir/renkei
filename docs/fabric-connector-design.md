# Microsoft Fabric connector — design

A point-in-time design doc (see [`README.md`](./README.md)); the as-built description is the
`connector-fabric` section of [`connectors.md`](./connectors.md).

## What it is for

Data teams moving work into Fabric spend their time in workspaces, lakehouses, notebooks and data
pipelines. The ask that started this: get context to advise on notebooks — see the lakehouses,
tables and pipelines — and help bridge Fabric's git integration, which does not reach Bitbucket.
The connector lets a person (or their agent) browse what they can see in Fabric, read a notebook
or pipeline, and create or change workspaces, notebooks and pipelines, with Fabric's own roles
deciding what is allowed. Querying the data and OneLake storage come later.

## Decisions

### A third Entra app registration, because it has to be

Entra issues a token for one resource. Fabric's API (`api.fabric.microsoft.com`) is not Graph, so
the Microsoft 365 grant could never carry Fabric's scopes however it was configured. So: connector
`fabric`, its own registration, grant, card and capability key — the Entra Developer arrangement,
for a stronger reason. Two consequences followed:

- The required scopes carry no `User.Read`. Asking for a Graph scope and Fabric scopes in one
  consent makes Entra refuse the request outright.
- The callback cannot fall back to Graph's `/me` to identify the person, so it reads the id_token
  only (`openid` and `profile` are always requested, so `oid` and `preferred_username` are there).

Fabric's scopes are resource-qualified when requested and short in the token's `scp` claim; one
helper (`shortFabricScope`) makes the two comparable for the scope gate.

### Definitions are long-running, so they are rows

`getDefinition` may answer 200 with the definition or 202 with an operation to poll; Fabric has no
webhook for an operation finishing. Rather than hold a request open, a fetch is a row the person
owns (`fabric_operations`), and three pollers share it under one lease (`next_poll_at`, claimed
before Fabric is asked, so it is never asked twice at once):

1. **The tool**, for up to 20 seconds — most definitions are ready by then, and the model reads
   the cells in the same turn.
2. **The page the person watches**, over a server-sent event stream that re-reads the row every
   two seconds and asks Fabric when the row is due. The browser holds one connection; the polling
   happens once, on the server. When the stream will not stay open (a buffering proxy), the page
   falls back to polling the same row.
3. **The worker's sweep**, for rows no stream has touched for 30 seconds — a closed tab, or a fetch
   a chat started. When it writes the end it notifies the owner through the existing framework:
   a feed row linking the operation's page, a push, and Outlook or WebEx if they asked.

"Watching" is recorded by the stream itself on every tick (the chat presence idea, kept on the row),
so a person looking at the page is never also notified, and closing the page hands over to the sweep
within the window. Only the poller that writes the end reports it (`finish` returns the row to one
caller), and `markNotified` keeps the notification once-only even so.

Considered and not taken: a queue message per poll (delayed messages are not something the queue
does, and a sweep over an indexed column is simpler); holding the definition in blob storage
(a definition is a few hundred KB at most; it is capped at 4 MB decoded and deleted after a week).

### Writes are cards; content is replaced whole

Every write is preview + confirm on the `directory_action_preview` card. `updateDefinition`
replaces a notebook's or pipeline's content entirely and Fabric keeps no earlier version behind it,
so the update preview says so, and the update tools are on the agents' always-approve list with the
workspace writes. The confirm acts on the ids the preview resolved. Creating an item and replacing
a definition are long-running too; the confirm follows them for 30 seconds and says plainly when
Fabric is still applying the change.

### Reading a definition needs write access

Fabric requires read-and-write permission on a notebook or pipeline to read its definition. The
definition tools therefore stand on `Notebook.ReadWrite.All` / `DataPipeline.ReadWrite.All`; there
is no read-only way to read code in Fabric's API.

## Fabric surface used

| Operation               | Call                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Workspaces              | `GET /workspaces`, `GET /workspaces/{id}`, `POST /workspaces`, `PATCH /workspaces/{id}`                                     |
| Items                   | `GET /workspaces/{id}/items[?type=]`, `GET /workspaces/{id}/items/{itemId}`                                                 |
| Lakehouse tables        | `GET /workspaces/{id}/lakehouses/{id}/tables` (preview API; `data`, paged)                                                  |
| Capacities              | `GET /capacities`                                                                                                           |
| Notebooks               | `POST /workspaces/{id}/notebooks`, `PATCH …/notebooks/{id}`, `POST …/getDefinition?format=ipynb`, `POST …/updateDefinition` |
| Data pipelines          | the same under `…/dataPipelines`                                                                                            |
| Long-running operations | `GET /operations/{id}`, `GET /operations/{id}/result`                                                                       |
