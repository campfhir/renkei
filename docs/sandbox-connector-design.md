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
  staged, forward these bytes into that upload slot, click the element
  with this ref) — never an arbitrary command, and never a script or a
  selector the model wrote. Filenames are display labels only; storage
  paths are always built from a UUID tenant id, a hashed subject, and a
  UUID file id, never from caller-supplied text
  (`apps/worker-sandbox/src/disk.ts`).

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

## `sandbox_fetch_page` — reading a URL without the browser

Most of what an agent wants from a URL is its text, and most pages give
it up to a plain GET: a public status page, a vendor's documentation, a
PDF linked from a wiki. The browser is the wrong tool for that — a
session, a rendered page, a snapshot with element refs — and staging the
bytes with `sandbox_download_url` then reading them back is two calls
and a file in the quota for something that was only passing through.
`sandbox_fetch_page` is the one-call read: the worker fetches the URL
exactly as `sandbox_download_url` does (same `assertPublicHttpsUrl`,
same byte cap), the web app reads the bytes back, turns them into text,
and deletes the staged file before answering, so nothing of the page is
at rest afterwards.

The text is `pageToText` (`packages/connector-sandbox/src/page-text.ts`),
pure string work over the HTML rather than a DOM: the `<title>`; the
largest `<main>` / `<article>` / `role="main"` region when the page marks
one with real text in it, else the body with its `<nav>`, `<header>`,
`<footer>` and `<aside>` dropped; headings as `#` lines, list items as
`-` lines, table cells joined by `|`, quotes as `>` lines, `<pre>` kept
verbatim, images as their alt text, and every http(s) link written as
`text (absolute URL)` so the model can follow one with another call —
`javascript:` and fragment links are just their text. Scripts, styles,
templates, SVG, iframes and comments never reach the output. The result
is capped (default 20k characters, at most 80k) and says when it was
cut. Anything that is not HTML goes through `@renkei/document-text`
(PDF, Word, Excel, PowerPoint) or is returned as text when it is one;
an unreadable format is refused with a pointer at `sandbox_download_url`.

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

## The browser (`sandbox_browser_*`)

The second thing the sandbox holds for an agent, after staged bytes: a
headless browser, for the pages no Renkei connector reaches — a vendor
portal, a public status page, a form that only exists on the web. It is
the same shape as the file tools applied to a page: every verb is one
named, bounded thing the worker does itself, and the model never hands
over a selector, a script, or a byte.

**Where it runs.** Inside `apps/worker-sandbox`, alongside the scratch
disk (`src/browser.ts`). A browser is a large, network-reaching process;
the sandbox worker is already the container that holds nothing but an
agent's own transient working state, reachable only over the internal
network with a bearer key, on its own image — so it gets that container
too, and its screenshots land in the same scratch space under the same
TTL and quota. The image (the `sandbox` target in `docker/Dockerfile`, now
Debian-based for glibc) bakes in the exact Chromium headless shell the
pinned `playwright-core` was tested with (`playwright-core install
--with-deps --only-shell chromium`), so nothing is downloaded at container
start. `SANDBOX_BROWSER_ENABLED=true` on the worker launches it (lazily, on
the first navigate); the same flag on the web app registers the tools.
Unset on either side means no browser — closed, never open.

**How a page reaches the model.** A _snapshot_, not HTML: the worker walks
the live DOM (`src/browser-page-script.ts`, run inside the page) and
reports the headings, text, images and landmarks a person would see, plus
every interactive element — links, buttons, form controls, ARIA widgets,
editable regions — with a short ref (`e12`) stamped onto the element as
`data-renkei-ref`. Rendering into text is pure and shared
(`packages/connector-sandbox/src/browser.ts`), bounded by a caller-chosen
`maxChars` (default 20k, ceiling 80k) and a node ceiling, and says when
it was cut. Password values are masked. Every action answers with a
fresh snapshot of wherever the page ended up (a navigation, a popup, a
menu), so the usual loop is navigate → act by ref → act by ref, with
`sandbox_browser_snapshot` only for re-reading.

**Acting by ref, never by selector.** A ref is validated to the
`e<digits>` shape before it goes anywhere near a locator, and a ref no
element carries is refused with "take a new snapshot" — refs die with the
page they were minted on. Typed text is bounded (10k), select values are
labels or values, key names are a strict token. Nothing the model writes
is ever evaluated in the page.

**Several steps in one call.** Every verb is one `BrowserStep`
(`packages/connector-sandbox/src/browser.ts` — navigate, click, type,
select, press, scroll, wait, back), parsed and bounded there and executed
by one `perform` in the worker. `sandbox_browser_run` takes an ordered
list of them (at most 20, with at most 20s of explicit waiting so a run
fits inside one tool call) and executes them in one round trip: fill
three fields, select an option, scroll, click submit, wait for the
confirmation text. A step that may move the page waits for it to load
before the next step; a popup a step opens becomes the page the rest of
the run works on. The run stops at the first failing step and answers
with how many completed, which step failed and why, and the page it ended
on — a partial run is something the model can continue from, not a
mystery. Since refs come from the snapshot the model already holds, a run
is for working _one_ page; actions on the page a link or submit leads to
belong in the next call, whose snapshot has that page's refs. `wait` is
either a bounded pause (≤10s) or "until this text is visible" (≤10s),
which is how a run survives a slow form submission without a round trip
to poll.

**Egress — the part that matters most.** Chromium is launched with **no
direct network access**: every connection it makes goes through a
loopback egress proxy inside the worker (`src/browser-proxy.ts`) that
resolves the host itself, refuses the localhost family and every
private/reserved range with the same `isBlockedIP` the download guard
uses, and then dials _the very address it verified_. That covers what a
tool-argument check never could — sub-resources, redirects, websockets,
`<img src="http://169.254.169.254/...">` — and it closes the DNS-rebinding
window the resolve-then-fetch pattern documents as residual, because there
is no second lookup for a rebinding answer to land on. Chromium's implicit
proxy bypass for loopback is switched off (`<-loopback>`), so
`http://127.0.0.1` from inside a page reaches the proxy and is refused
there; ports other than 80/443 below 1024 are refused outright. On top of
that, top-level navigation is https-only and pre-checked with
`assertPublicHttpsUrl`, so a blocked URL is refused with a clear message
before the browser is involved; a refused in-page navigation lands on
Chromium's error page, which the worker reports as "refused or
unreachable" rather than reading. Non-http(s) URLs are never navigable.

**Sessions.** One browser context per `(tenantId, subject)` — cookies,
storage and tabs never cross callers, the same scoping as their staged
files — created on the first navigate and closed after ten idle minutes
(`BROWSER_SESSION_IDLE_MS`) or on `sandbox_browser_close`; at most eight
at once (`BROWSER_MAX_SESSIONS`), least-recently-used evicted beyond that;
the browser process itself exits once no session remains. Calls on one
session are serialized so two tool calls racing for the same page cannot
interleave. Downloads are refused, service workers blocked, and a popup a
click opens becomes the page the next snapshot reads. When a session is
gone, the refusal says _why_ — idle, evicted, closed, or "the browser
process exited unexpectedly (it may have run out of memory on the last
page)" — and points at a `sandbox_browser_run` whose first step is
navigate, so the actions follow in the same call. A crashed page is
reported as such rather than read as blank. The worker logs unhandled
rejections instead of dying of them, and logs an uncaught exception
before exiting, so a restart is never silent.

**Pages that keep rendering.** Real sites are single-page apps: the
network goes quiet before the app has painted, analytics beacons keep it
from ever going quiet, and a framework re-creates DOM nodes on every
render. Three things keep a snapshot honest and a ref usable against
that:

- after every load, the worker waits for `load` and `networkidle`
  (bounded), then samples the element count until four samples a quarter
  second apart agree — a one-second quiet window that outlasts an app
  bootstrapping a beat after `load` — within a five-second budget;
- a walk that comes back thin (fewer than eight items on a real URL) is
  taken as "not painted yet": one more beat, one more walk, and the thin
  result stands only if it holds;
- a ref whose attribute vanished with a re-created node is _recovered_:
  every snapshot the model receives records each ref's signature (role,
  accessible name, link target, and which of its look-alikes it was);
  when a ref's attribute is gone, the worker walks again under a probe
  attribute, finds the element with the same signature, re-stamps it with
  the model's ref, and proceeds. The model's numbering stays valid for
  everything it can still find; only a truly gone element is refused
  with "take a new snapshot".

A link marked for a new tab (`target="_blank"`) is followed in the same
tab: the flow has one page, and a popup that is blocked or slow to appear
would otherwise leave the model looking at an unchanged snapshot.

**Secrets — logins the browser may type but the model may never see.**
The one thing a real portal needs that nothing above provides is a
credential, and a credential handed to a model as tool text is a
credential in a transcript, a log, and every prompt after. So secrets go
around the model entirely:

- _Supplied in the Renkei UI, never over MCP._ The "Browser secrets" card
  on the connectors page (`apps/web/app/[slug]/connectors/sandbox-secrets.tsx`,
  routes under `/api/tenant/[tenantId]/sandbox/secrets`) is where a person
  adds, unlocks, locks and revokes them, with their own session. The MCP
  surface can list secrets (`sandbox_browser_list_secrets`: name, field
  names, hosts, lock state — never a value) and type one
  (`sandbox_browser_type` with `secret: {name, field}` instead of `text`,
  as a single verb or a run step). It cannot create, unlock or read one.
- _Sealed under their own key, not the deployment's._ Every other
  credential Renkei holds is under `TOKEN_ENCRYPTION_KEY`. A browser
  secret is sealed (AES-256-GCM, `sbx1.` envelope) under a key derived by
  scrypt from a passphrase — one Renkei **generates** (five groups of five
  unambiguous characters, ~124 bits; a person may choose their own, 12+
  characters) and shows exactly once, and does not store. The row in
  `sandbox_secrets` (migration 090) carries the sealed blob plus the
  non-secret half (name, field names, hosts, expiry); the table plus every
  Renkei key yields nothing.
- _Unlocked for a window, in memory, in the worker._ Unlocking sends the
  passphrase to `apps/worker-sandbox` for the length of one request; the
  worker derives the key, proves it opens the blob (GCM's tag refuses a
  wrong passphrase before anything is held), and keeps the key in
  `SecretVault` (`src/secret-vault.ts`) until the window closes — 8 hours
  by default, 24 at most — or the person locks it, or the process restarts.
  Nothing about the unlock is written anywhere, which is why the UI asks
  the worker for lock state rather than a column. The secret itself
  expires (30 days by default, 90 at most) and is swept like a staged file.
- _Scoped to hosts._ A secret names 1–8 hostnames (`portal.vendor.com`,
  `*.vendor.com`) it may be typed on, required at creation. The worker
  resolves a type step's reference against the page's **current** host
  (`src/secrets.ts`) and refuses otherwise — so a task that wandered, or
  was steered, onto another site cannot spend the credential there.
- _Never readable back._ The control the worker filled is stamped
  `data-renkei-secret`, and the walk masks its value like a password
  field's. Every typed value is also remembered for the session and
  scrubbed (`scrubSecretValues`, URL-encoded form included) from every
  snapshot, URL, title and error message the model receives — so a site
  that echoes a username, or a form that put the value in the query
  string, does not become the channel that reveals it. What the site
  itself does with a credential it was given is, of course, the site's.
- _Auditable._ Creating, unlocking, locking and revoking each record an
  audit event (`sandbox.secret.*`); `last_used_at` records the last time
  the browser typed it.

**What it deliberately is not.** Not a headed or remote-controlled
browser, not a way to run JavaScript, not a file-download path (that is
`sandbox_download_url`, byte-capped and quota'd), and not a vault the
model can open — the tool descriptions tell the model never to type a
credential as text, to use a stored secret, and to ask the person when
none exists or it is locked.

## Tool inventory

| Tool                           | Kind | What it does                                                                                                                                                                   |
| ------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sandbox_download_url`         | Act  | Fetch an `https://` URL into the scratch space (SSRF-guarded, byte-capped).                                                                                                    |
| `sandbox_fetch_page`           | Read | Fetch an `https://` URL through the same guard and answer its readable text — a page's title, main content and links, or a PDF/Office file's extracted text — keeping nothing. |
| `sandbox_fetch_from_fileshare` | Act  | Pull a file from a connected SMB/SFTP share straight in, server-to-server.                                                                                                     |
| `sandbox_list_files`           | Read | What's currently staged, with size and expiry.                                                                                                                                 |
| `sandbox_stat_file`            | Read | Filename/content type of one staged file.                                                                                                                                      |
| `sandbox_read_file`            | Read | Extracted text of a staged file (same extractor as `fileshare_read_file`).                                                                                                     |
| `sandbox_delete_file`          | Act  | Remove a staged file ahead of its TTL.                                                                                                                                         |
| `sandbox_send_to_upload`       | Act  | Forward a staged file's bytes into a pending `*_request_*_upload` slot.                                                                                                        |
| `sandbox_browser_navigate`     | Act  | Open an `https://` URL in the caller's browser session; answers a snapshot.                                                                                                    |
| `sandbox_browser_snapshot`     | Read | Re-read the open page (title, URL, text, `[eN]`-ref'd controls).                                                                                                               |
| `sandbox_browser_click`        | Act  | Click an element by ref; answers the snapshot of wherever that led.                                                                                                            |
| `sandbox_browser_type`         | Act  | Replace a field's text by ref — or fill it from a stored secret the model never sees — optionally pressing Enter.                                                              |
| `sandbox_browser_list_secrets` | Read | The stored secrets' names, fields, hosts and lock state; never values.                                                                                                         |
| `sandbox_browser_select`       | Act  | Choose option(s) of a `<select>` by ref.                                                                                                                                       |
| `sandbox_browser_press_key`    | Act  | Press one key (Escape, Tab, PageDown, ...) in the page.                                                                                                                        |
| `sandbox_browser_scroll`       | Act  | Scroll the page up/down by pixels, or bring one ref into view.                                                                                                                 |
| `sandbox_browser_run`          | Act  | Execute up to 20 steps (type, select, scroll, wait, click, ...) in one round trip.                                                                                             |
| `sandbox_browser_back`         | Act  | Browser history back.                                                                                                                                                          |
| `sandbox_browser_screenshot`   | Act  | PNG of the open page, staged as a scratch-space file.                                                                                                                          |
| `sandbox_browser_close`        | Act  | Close the caller's session (pages, cookies, history).                                                                                                                          |

The browser tools exist only when `SANDBOX_BROWSER_ENABLED=true` on both
the web app and the worker.

## Deployment

`apps/worker-sandbox` — its own image (`renkei-sandbox`, the `sandbox`
target in `docker/Dockerfile`), its own named volume (`SANDBOX_DATA_DIR`,
default `/data`). The web app reaches it at `SANDBOX_WORKER_URL` with the
shared bearer key `SANDBOX_WORKER_API_KEY` (`apps/web/lib/sandbox/service-client.ts`).
Both unset means the `sandbox_*` tools simply don't register — closed,
never open, the same convention every other worker-backed connector
follows. `SANDBOX_BROWSER_ENABLED=true`, set on both the web app and the
worker, adds the `sandbox_browser_*` tools; `SANDBOX_BROWSER_EXECUTABLE`
optionally points the worker at a specific Chromium binary instead of the
one baked into the image. See `DEPLOYMENT.md` for the full env contract.
