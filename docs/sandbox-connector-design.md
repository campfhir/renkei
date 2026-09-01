# Sandbox connector — design

As-built. The sandbox connector gives an agent a per-caller scratch space —
stage a file, look at what's staged, hand it to another tool — for moving a
file between two connectors that have no way to reference each other
directly today.

## The problem this solves

Every other byte path in Renkei is stream-through by design (see the
upload-slot pattern in `apps/web/lib/mcp-tools/upload-slots.ts`): a read
either returns extracted text or a signed link the browser fetches, and a
write is bytes POSTed straight from an external client into the destination
connector's API, in one request, never touching disk. That works as long as
one side of a transfer already knows how to hand the other side a
reference — `jira_add_attachment` takes a `driveItem` or `outlookAttachment`
and pulls the bytes itself, server-to-server.

It breaks down for a source that only offers a download link (the
`fileshare_*` connector — org SMB/SFTP shares) feeding a destination that
only accepts staged upload bytes (`onbase_request_document_upload`). Neither
tool can call the other; something has to hold the bytes for a moment in
between. That's this connector.

## Why this is a bigger decision than it looks

Every existing connector treats "Renkei never holds file bytes at rest
outside a provider or a browser" as load-bearing. `connector-fileshares`
was deliberately narrowed (migration 062) away from an earlier design that
gave Renkei more of its own state and authorization surface than it needed.
The sandbox is, on purpose, the first exception to "never at rest" — so the
bar for containing it is the same bar those decisions were held to, not a
lower one:

- **Short, fixed lifetime.** Every staged file gets a TTL (24h) set at
  write time, enforced by the worker's own periodic sweep — not something a
  caller has to remember to clean up. `sandbox_delete_file` removes one
  early.
- **Hard quota, not just a per-file cap.** A per-(tenant, subject) byte
  quota and file-count ceiling (`packages/connector-sandbox/src/limits.ts`)
  bound how much any one caller can have staged at once, checked before any
  bytes move and enforced again while streaming — the same
  cap-while-reading discipline `serviceWriteFile` and the fileshare
  worker's `readBody` already use, so an oversized source is refused, never
  buffered in full first.
- **No cross-caller reads.** Every operation is scoped to
  `(tenantId, subject)`, the same discipline `upload_slots` and fileshare
  connections already keep.
- **Isolated like the credential-holding workers.** `apps/worker-sandbox`
  is its own image, its own Docker volume, no published ports, reached only
  over the internal compose network with a bearer key — the same shape as
  `worker-fileshares` (decrypts credentials) and `worker-onbase` (dials a
  tenant's private network). This one holds bytes instead of credentials,
  but the isolation reasoning is identical: one process, one kind of
  sensitive state, nothing else in the fleet touches it.
- **Not knowledge-indexed.** Staged files are transient working state, not
  a source of truth — same as `connector-fileshares`/`connector-onbase`.
- **Curated verbs, not a shell.** Every sandbox_* tool is one named,
  bounded thing the worker does itself (download this URL, read back what's
  staged, forward these bytes into that upload slot) — never an arbitrary
  command. Filenames are display labels only; storage paths are always
  built from a UUID tenant id, a hashed subject, and a UUID file id, never
  from caller-supplied text (`apps/worker-sandbox/src/disk.ts`).

## `sandbox_download_url` and the egress guard

The one operation that reaches outside the process. It fetches an
`https://` URL **on the worker**, so the model never generates or sees the
bytes, through the same SSRF guard `apps/web/lib/safe-fetch.ts` already
applies to tenant-configured OIDC discovery URLs: scheme allow-list, the
`localhost` family, and every private/reserved IPv4/IPv6 range including
the cloud-metadata address, checked both on the literal host and after DNS
resolution (`packages/connector-sandbox/src/egress-guard.ts`). It's a
deliberate duplication rather than a shared import — a worker process can't
depend on the Next.js app's `lib/` — kept in sync by hand; see that file's
own comment for the residual DNS-rebinding caveat the original already
documents.

## `sandbox_send_to_upload` and slot ownership

Completing a `*_request_*_upload` normally requires the slot's opaque
bearer token, presented by whatever out-of-band client (curl, a browser)
POSTs the bytes — because that request carries no Renkei session of its
own. `sandbox_send_to_upload` is different: it's an MCP tool call, already
running inside an authenticated session for the same caller who could have
minted the slot in the first place. So it claims the slot by **ownership**
instead — `(tenantId, subject)` matching the slot's own row, the same
identity `check_file_upload`'s status lookup already trusts — rather than
by token. The upload id alone is deliberately non-secret (see
`upload-slots.ts`'s own comment) and must never authorize an action by
itself, which is why this claim additionally requires the caller's own
subject to match. `claimPendingUploadSlotByOwner`
(`apps/web/lib/mcp-tools/upload-slots.ts`) and the shared
`completeUploadSlot`/`finalizeUploadSlot` helpers
(`apps/web/lib/upload-executors.ts`) are what both this tool and
`/api/upload/[slotId]`'s POST route now share, so there is one finish path
instead of two copies of the same status update.

## Tool inventory

| Tool | Kind | What it does |
| --- | --- | --- |
| `sandbox_download_url` | Act | Fetch an `https://` URL into the scratch space (SSRF-guarded, byte-capped). |
| `sandbox_fetch_from_fileshare` | Act | Pull a file from a connected SMB/SFTP share straight in, server-to-server. |
| `sandbox_list_files` | Read | What's currently staged, with size and expiry. |
| `sandbox_stat_file` | Read | Filename/content type of one staged file. |
| `sandbox_read_file` | Read | Extracted text of a staged file (same extractor as `fileshare_read_file`). |
| `sandbox_delete_file` | Act | Remove a staged file ahead of its TTL. |
| `sandbox_send_to_upload` | Act | Forward a staged file's bytes into a pending `*_request_*_upload` slot. |

## Deployment

`apps/worker-sandbox` — its own image (`renkei-sandbox`, the `sandbox`
target in `docker/Dockerfile`), its own named volume (`SANDBOX_DATA_DIR`,
default `/data`). The web app reaches it at `SANDBOX_WORKER_URL` with the
shared bearer key `SANDBOX_WORKER_API_KEY` (`apps/web/lib/sandbox/service-client.ts`).
Both unset means the `sandbox_*` tools simply don't register — closed,
never open, the same convention every other worker-backed connector
follows. See `DEPLOYMENT.md` for the full env contract.
