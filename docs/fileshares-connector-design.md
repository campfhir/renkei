# File-share connector (SMB/SFTP) — decision log

Shipped alongside the code; this records the decisions and their reasons,
the way `docs/onbase-connector-design.md` did for the design that preceded
its implementation.

## The departure this connector makes

Every prior connector delegates authorization to its provider (RENKEI.md
Decision #2): the user connects an account, the provider decides what that
account sees. An SMB or SFTP share offers no such delegation — Renkei
connects with **one admin-managed service credential**, so the per-user
question has no provider to answer it. This is therefore the first
connector where **Renkei's own store is the ACL authority**, and everything
below follows from taking that seriously:

- **Discovery is gated by grants.** No `file_share_grants` row → the share
  does not exist for that caller: not in `fileshare_list_shares`, not on
  the files page, and a direct request answers exactly like a nonexistent
  id (no existence oracle).
- **Enforcement is per call, in deterministic code** (Decision #16's
  spirit): every tool handler and REST route evaluates the pure ACL engine
  over a freshly-read context. The capability gate only decides whether the
  tools exist for a caller; it never substitutes for the per-path check.
- **Fail closed, everywhere.** A missing grant, an unreadable rule row, a
  decryption failure, or a DB error all mean `none`. A malformed rule
  poisons its whole context rather than being skipped — the skipped row
  might have been the deny.

## The permission model

Levels `none < read < read_write`, two rule layers over normalized paths:

- **Share-wide layer** (rules with `subject NULL`) applies to everyone
  granted; its implicit rule at `/` is the share's `max_access` ceiling.
- **Per-user layer** narrows further; its implicit `/` rule is the grant's
  `default_access` — which may be `none`, making "only these carved-in
  folders" expressible.
- Within a layer, the **longest matching directory-boundary prefix wins**
  (inheritance down; deeper rules override shallower ones, allow and deny
  alike). Across layers, the **minimum** wins — layers narrow, never widen,
  the same invariant the capability registry keeps.
- **Traverse-only visibility:** a folder whose own level is `none` but
  which shields a deeper allow appears in listings marked traverse-only.
  Without this, "longest path wins" would let a carve-in be read by exact
  path while browsing could never find it — the two access paths must
  agree.

## Paths

One canonical spelling: Unix-style, `/`-rooted, no trailing slash.
Backslashes fold to `/` before splitting (SMB treats them as separators on
the wire, so a "name" containing `\..\` would be re-split into the
traversal it hid). `..` is **rejected, never resolved** — at every boundary
(MCP handler, REST route, admin parser), again structurally inside the
backends (`joinUnder` re-verifies containment), and on SFTP a third time
through the server's `realpath` so symlinks cannot widen the root. Rule
matching folds case per-share (`case_insensitive`, defaulting on for SMB);
the SFTP containment check never folds — that flag describes rules, not
the server's filesystem.

## Credentials

One credential document per share (`smb` user/pass/domain, `sftp`
user/pass or private key), sealed in the `@renkei/crypto` secretbox under
`TOKEN_ENCRYPTION_KEY`. Write-only through the admin API (GETs report
presence; PATCH treats absent fields as "keep"); decrypted only
server-side, per call; a share without a credential is unusable rather
than anonymously connected. Connections happen exclusively server-side.

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
  one file. Verified against live servers; the
  integration suites (`FILESHARE_TEST_*` env, self-skipping) and
  `docker-compose.fileshares-test.yaml` keep that check repeatable.

## Destructive operations (added after v1)

Move, rename and delete shipped as a follow-up, under three rules:

- **Delete is preview-confirmed over MCP.** There is no plain delete tool:
  `fileshare_delete_entry_preview` renders the shared issue-preview card and
  the app-only `fileshare_delete_entry_confirm` — the same handler, re-running
  every check itself — executes only on the user's click. File-server deletion
  has no recycle bin, so a human sits between the model and the irreversible
  act. Folder deletion removes EMPTY folders only; a non-empty folder is
  refused ('not_empty'), never tree-deleted.
- **Anchored rules are immovable.** Move/rename/delete refuse when any path
  rule — either layer, ANY subject — sits at or under the source
  (`listRulePathsUnder`). Rules govern paths, not objects: a rename that slid
  deny-ruled content to an unruled path would be an ACL bypass, so anchored
  content stays put until an admin removes the rules.
- **Both ends need read/write, and nothing clobbers.** Move/rename require
  effective `read_write` on source and destination, and probe the destination
  first so every server answers 'exists' uniformly. On SMB the operations are
  made convergent under the wedge-retry: a retried remove treats absence as
  success, and a retried rename disambiguates through the destination.

## What deliberately did not ship

- **Knowledge indexing** — retrieval-only. Indexing would need this
  connector's `verifyAccess` against Renkei's own ACL plus a change-poll
  strategy for servers with no change feed; it layers on later without
  reshaping what shipped.
- **Per-user backend credentials** — the share-level service credential is
  the model; defense-in-depth via native server ACLs can be added as an
  opt-in later.
- **Anonymous download links** — `fileshare_download_file` hands out the
  session-guarded REST URL, so the ACL re-runs at click time. A
  pre-authenticated link (the SharePoint pattern) would be a new
  secret-distribution surface with no provider to blame it on.

## Operational notes

- Availability = "any grant row on an enabled share", resolved per MCP
  connection and part of the handler-cache fingerprint. Rule/grant CONTENT
  stays out of the fingerprint on purpose: handlers read the ACL fresh per
  call (15s TTL cache, cleared in-process by admin mutations), so
  narrowing takes effect without a handler rebuild. Worst-case
  cross-process staleness after an admin edit: 15 seconds.
- The upload-slot executor re-runs the full ACL at byte arrival — a slot
  must never outlive the access that minted it.
- Bounds: reads/extracts capped by `@renkei/document-text`'s input limit,
  transfers by the org's `maxAttachmentBytes`; 10s connect / 15s op / 60s
  transfer timeouts; a lane limiter plus a per-share session cap (a NAS
  has no 429s to defend itself with).
- Admin mutations write `fileshare.*` audit events (subjects, paths,
  levels — never file content).
