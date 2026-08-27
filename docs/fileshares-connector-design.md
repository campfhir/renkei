# File-share connector (SMB/SFTP) — decision log

Shipped alongside the code; this records the decisions and their reasons,
the way `docs/onbase-connector-design.md` did for the design that preceded
its implementation.

## The model: delegate authorization to the file server

Every connector delegates authorization to its provider (RENKEI.md
Decision #2): the user connects an account, the provider decides what that
account sees. File shares now follow exactly that rule. An admin registers
a share's **connection details only** (protocol, host, port, share name,
root path); every person then connects the share **with their own
credentials** on the connectors page — a shared team account is the org's
choice, not Renkei's concern — and what that account may list, read,
write, or delete is judged by the file server itself, per operation.

### The ACL that was built, then deliberately removed

v1 shipped the opposite design: one admin-held service credential per
share, with Renkei's own store as the per-user ACL authority (grants,
two-layer path rules, longest-prefix evaluation, traverse-only visibility,
an anchored-rules destructive gate). It worked, and it was removed in full
(migration 062) for one reason: **it was too much security surface for
Renkei to own.** A bespoke authorization engine is a permanent stream of
correctness obligations — rule evaluation, existence oracles, annotation
consistency, cache staleness — and the service credential was a
super-credential reachable through any web-app bug, whose blast radius was
every file on every share. Delegation shrinks Renkei's job to two things
it already does well elsewhere: sealing a per-user secret at rest, and
narrowing what the LLM may attempt. If a compromise happens now, it is
bounded by one person's own account on the server, which the file-server
admins already audit and rotate.

What Renkei keeps is deliberately NOT authorization:

- **Discovery**: every enabled share is listed to every signed-in org
  member on the connectors page — credentials are the gate, existence is
  not a secret in this model.
- **LLM exposure** (per connection, chosen by its owner): whether the MCP
  tools may write on that share, and separately whether they may delete.
  Exposure can hide access the person holds; it can never mint any — the
  worker's I/O path deliberately never reads it, so no bug in the exposure
  layer can widen anything.

## Connections

One row per (share, person): the credential document (`smb`
user/pass/domain, `sftp` user/pass or private key) sealed in the
`@renkei/crypto` secretbox under `TOKEN_ENCRYPTION_KEY`, the account name
for display, and the exposure choice. Connecting validates the credential
against the live server (through the fileshare worker) **before** anything
is stored — a wrong password is an immediate 4xx, never a stored
credential that fails later. Disconnecting deletes the row, credential
included; deleting a share cascades over everyone's connections. Only the
fileshare worker ever decrypts a stored credential; the web app encrypts
on the way in and never reads back.

Delete is separate consent from write because file-server deletion is
permanent: one permission on the server, two checkboxes at the model
boundary.

## Paths

One canonical spelling: Unix-style, `/`-rooted, no trailing slash.
Backslashes fold to `/` before splitting (SMB treats them as separators on
the wire, so a "name" containing `\..\` would be re-split into the
traversal it hid). `..` is **rejected, never resolved** — at every
boundary (MCP handler, REST route, admin parser), again structurally
inside the backends (`joinUnder` re-verifies containment), and on SFTP a
third time through the server's `realpath` so symlinks cannot widen the
root. Path discipline is hygiene, not authorization: it keeps requests
inside the share the admin registered, and the server decides the rest.

## Library choices

- SFTP: `ssh2-sftp-client` (mature, promise-based, exposes `realPath`).
- SMB: `@tryjsky/v9u-smb2` — pure JS, so `node:24-alpine` needs no samba
  packages. The fork specifically, because upstream `v9u-smb2` hashes NTLM
  credentials with OpenSSL MD4, which OpenSSL 3 removed: it cannot
  authenticate on Node 22+ at all. The fork vendors js-md4. The library is
  additionally patched (`patches/@tryjsky__v9u-smb2.patch`): it treated
  SMB2's interim async response (STATUS_PENDING — "still working", real
  answer follows) as a terminal error, which under server load failed
  healthy requests and desynced the connection; the patch drops the
  interim in the dispatch and waits for the final response. The backend
  also keeps a bounded fresh-connection retry (pending / sharing-violation
  / double-timeout) as defense in depth. Both backends sit behind the
  `ShareBackend` seam, so a swap (e.g. to an smbclient wrapper) touches
  one file. Verified against live servers; the integration suites
  (`FILESHARE_TEST_*` env, self-skipping) and
  `docker-compose.fileshares-test.yaml` keep that check repeatable.

## Destructive operations

- **Delete is preview-confirmed over MCP.** There is no plain delete tool:
  `fileshare_delete_entry_preview` renders the shared issue-preview card
  and the app-only `fileshare_delete_entry_confirm` — the same handler,
  re-running the exposure check itself — executes only on the user's
  click. File-server deletion has no recycle bin, so a human sits between
  the model and the irreversible act. Folder deletion removes EMPTY
  folders only; a non-empty folder is refused ('not_empty'), never
  tree-deleted.
- **Nothing clobbers.** Move/rename probe the destination first so every
  server answers 'exists' uniformly. On SMB the operations are made
  convergent under the wedge-retry: a retried remove treats absence as
  success, and a retried rename disambiguates through the destination.

## The dedicated worker process

File-share I/O lives outside the web app in `apps/worker-fileshares`, a
small internal HTTP service on its own image (`renkei-fileshares` — the
`fileshares` Dockerfile target), so the container carries exactly the
protocol stack (the patched SMB library included) and none of the queue
workers' dependencies, and the service versions and rolls out
independently of them. Two reasons: SMB/SFTP sessions are heavy, slow I/O
against servers that cannot defend themselves — a wedged NAS was tying up
web request handlers — and isolation: the protocol libraries and every
credential plaintext live in one small process instead of the web app's.

How the seam is cut:

- **The package owns a service layer** (`service.ts`): one function per
  operation, each resolving the CALLER'S OWN stored credential fresh and
  opening a bounded backend session itself. The worker's HTTP endpoints
  are thin wrappers over these functions.
- **The web app holds a client, not a library.** REST routes, the
  fileshare MCP tools and the upload-slot executor call the worker
  (`FILESHARES_WORKER_URL`, bearer `FILESHARES_WORKER_API_KEY` —
  comma-separated for overlapping rotation, timing-safe compare, no key
  means no service). Every call carries the authenticated `subject`, and
  the worker resolves that person's credential per call — so a disconnect
  takes effect on the next operation regardless of which process observed
  it. The web app's remaining store reads are discovery (connection
  listings) and the exposure checks in the MCP layer, both I/O-free.
- **Trust boundary:** the bearer key marks the caller as the web app,
  which has already authenticated its user. The `test-connection` endpoint
  is the one place an unsaved credential crosses the seam (the connect
  flow's validation); it is re-parsed at that boundary and never stored by
  the worker. File bytes travel as raw HTTP bodies — never base64 in JSON.
- **The bounds are global.** The per-share session cap and lane limiter
  live in the single worker; the org attachment ceiling is enforced
  worker-side per tenant, with the web routes keeping only a cheap
  declared-length pre-check.
- HTTP/JSON was chosen over gRPC deliberately: a handful of endpoints on
  node:http, no proto toolchain, and the payloads are either small JSON or
  raw file bytes — nothing gRPC would improve.

## What deliberately did not ship

- **Knowledge indexing** — retrieval-only. Indexing under per-user
  credentials would mean indexing as somebody; there is no service
  credential to index as anymore, so this waits for a deliberate design.
- **Renkei-side ACLs** — removed, see above. If an org needs narrower
  access than an account's own, the file-server admin narrows the account:
  that is where the authority lives.
- **Anonymous download links** — `fileshare_download_file` hands out the
  session-guarded REST URL, so the download runs on the clicker's own
  stored credentials at click time. A pre-authenticated link would be a
  new secret-distribution surface with no provider to blame it on.

## Operational notes

- Availability = the caller's exposure aggregate over connected enabled
  shares, resolved per MCP connection and part of the handler-cache
  fingerprint: any connection mounts the read tools; write and delete
  each mount their families only when opted into somewhere, and every act
  handler re-checks the per-share choice fresh on each call.
- The upload-slot executor resolves the caller's credential at byte
  arrival — a slot must never outlive the connection that minted it.
- Bounds: reads/extracts capped by `@renkei/document-text`'s input limit,
  transfers by the org's `maxAttachmentBytes`; 10s connect / 15s op / 60s
  transfer timeouts; a lane limiter plus a per-share session cap (a NAS
  has no 429s to defend itself with). All enforced in the fileshare
  worker, so they hold globally however many web replicas run.
- Audit: admin share CRUD writes `fileshare.created/updated/deleted`;
  connects and disconnects write `fileshare.connected/disconnected`
  (exposure choice included, never a credential).
