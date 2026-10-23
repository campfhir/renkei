# Artifacts — design

Written with the change that built them (migration 163). Before it, a
file a person dropped into a chat and a file uploaded to a project page
were `chat_attachments` rows that belonged to that chat or project and
died with it; a file a tool wrote was the same row with `origin =
'model'`. This makes all of them one thing — an **artifact** — owned by
a person and **held by reference**, so the same manual serves any number
of code projects without a second copy, and so what a chat generated can
be found again.

## What a person sees

- **Artifacts** in the app menu (Workspace group, under Knowledge;
  `/chat/artifacts`): every file they own — uploads and what their chats
  generated — and every file shared with them, each with where it is
  used. The whole page is a drop target. The list is one page of the
  library at a time (25), chosen in the database by what the URL says
  (`q`, `show`, `project`, `page`), and scrolls in its own box, so the
  filters and the pager stay put; the search finds a file by a word in
  its name or in its digest (below). One
  selected at a time: its projects (with how each uses it), who can read
  it, download, replace, rename, share, delete, or — for a file someone
  shared — make a copy they own, or take it off their list. On a wide
  screen the details stand beside the list; on a phone the rows are cards
  and a tap opens the details over the list, with a back button — the
  way the code pane opens a file on a phone.
- **An Artifacts card** on every project page, chat and code projects
  alike (the Files section it replaces was hidden on code projects). What
  the project holds, with an **Always / On demand** switch per file,
  Attach from library…, Upload, and a drop zone. The card also shows the
  per-turn budget the Always files take.
- **In a project's chat**, dropping or picking a file asks once where it
  goes — kept as a project artifact (every chat in the project reads it,
  and it is sent with this message) or this message only — and remembers
  the answer per project in that browser.
- **Tools**: `artifact_search` finds passages across the project's
  on-demand artifacts; `chat_read_attachment` reads one by id, in pages,
  as before; `artifact_attach` keeps a file of the chat for the project;
  `artifact_share` shares one of the person's own. A file the model writes
  (`chat_write_file`) is an artifact of the chat from the start.
- **Notifications** when a file is shared with you, when someone copies a
  file you shared, and when a file is handed over to you.

## The model

| Table                 | What a row is                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `artifacts`           | `chat_attachments` renamed: owner, bytes (`blob_key`), extracted text, `chat_id` (the chat it came from), `origin`. |
| `artifact_references` | A project holds an artifact, with `mode` `always` or `on_demand`.                                              |
| `resource_access_grants` kind `artifact` | A person it is shared with. Role is always `viewer`: shared to **use**, never to edit.                      |
| `resource_keys` kind `artifact` | Its own content key (below).                                                                                   |

Rules, as enforced in `apps/web/lib/chat/artifact-access.ts`:

- The **owner** does everything: rename, replace, share, hand over, delete.
- A person it is **shared with** may use it — read it, attach it to their
  own projects, copy it, remove it from their own list (which deletes
  only their grant). They never change the file.
- A **member of a project** that holds it reads it there. The project's
  owner and editors attach, detach and set the mode; its viewers do not.
- A **reader of the chat** it came from reads it, as before.
- Nobody else: the routes answer 404, never 403, as everywhere else.

Lifecycle: a chat's own file (no reference, no share) still dies with the
chat, by cascade, as it did; a file a project holds or a person was
shared outlives any one chat or project. Deleting shows the owner who
loses it — projects and their member counts, direct shares, the chat it
came from — and offers **hand-over** instead: the new owner keeps the
file, every attachment and every share, and the old owner's access ends.
A **copy** duplicates the bytes under the copier as a new artifact of
their own; the original's owner is told.

## Keys

Content stays sealed under resource keys that only the delegate unwraps
([delegate-key-design.md](./delegate-key-design.md)) — the extracted text
in `artifacts.extracted_text` (`renc2:`), and the **bytes** in the object
store (`renc2b`, the same key, AES-256-GCM over the whole file with the
key id in front: `sealBytesWithResourceKey` in `@renkei/crypto`). The
store holds nothing it could read; a download, a preview, a copy, a
sandbox staging, an OCR pass and an image edit all go through
`readAttachmentBytes`, which opens the file under the key the reader's
access resolved. What stays in the clear is the row's metadata: filename,
content type, size, owner. An artifact has a key of its own, kind
`artifact`:

- the owner holds it as they hold a chat's;
- a **share** wraps it to the grantee (`shareKey`), exactly as a project
  share does;
- **attaching** wraps it under the project's key (`wrapKeyUnder`), so
  every member — present and future — opens it through the project, one
  level deep; a chat upload kept for the project is wrapped under the chat
  as well, for the chat's readers.

A row from before the migration keeps the key of where it lived
(`key_kind` `chat` or `chat_project`, `key_ref` naming it) and reads as it
did. The first time it is shared or attached anywhere else it is
**promoted**: opened by whoever may (their access), re-sealed — bytes
first, then text — under a new key of its own (minted as the owner's, so
the owner's key must be delegated — signed in, or their automation
delegation standing), and wrapped under its chat and every project that
holds it. A plain chat upload stays under the chat's key from the start,
and so costs nothing more than before until it is kept.

A file whose bytes were stored before they were sealed (any upload from
before this build) is recognised by the absence of the envelope's magic
and read as it is; the first read whose cipher can seal writes it back
sealed under that same key, so the store holds it sealed from then on
without a sweep. A reader with no key (the row's marker case) still reads
it and leaves it for the next.

## Search: the digest

A file's text stays sealed, so the library cannot search it. What it
searches instead is the file's **digest**: a short summary and a list of
keywords the organization's default model writes for a file when its
text lands (`artifact-digest.ts`) — at upload, when a tool hands a file
back, when OCR finishes, when the bytes are replaced; a copy carries the
original's across. The digest is stored in the clear on the row
(`summary`, `keywords`, `digest_status`) beside the sealed text, with the
keywords and summary as full-text terms in an indexed `search_vector`,
so a search is one indexed predicate (`websearch_to_tsquery`) plus a
substring match on the filename, and never a read of sealed text. What
goes to the model is what the chat would send it: the extracted text as
redacted at upload, cut to its head (`DIGEST_INPUT_CHARS`), under a
system prompt that tells it to describe the document and not to follow
what is written in it; the call is recorded in the usage ledger under
`artifact_digest`.

All of it is behind an organization switch, **Summarize artifacts with
the default model** (admin → Settings → Knowledge search;
`artifactDigestEnabled`), off by default: while it is off no file text
goes to a model on its own, rows stay `pending`, the search matches file
names only, and the page says so; turning it on digests files as they
are uploaded and looked at. The ask runs after the response that
created the row (`after()`), never before it, and is advisory: no model, a model down, or an answer with
nothing usable in it leaves the file searchable by name alone, with the
row saying where it stands (`pending`, `running`, `done`, `failed`,
`none` for a file with no text). The library page asks again for the
pending rows it shows, a few at a time, so a digest a recycled process
dropped — and every row from before digests existed, which migration
164 marks pending — fills in as people look at their files. The details
panel shows the summary and the keywords, each keyword a search of its
own.

## Always and on demand

An `always` artifact's whole text travels in the system prompt of every
turn in the project's chats, inside `<artifact>` tags, up to a budget per
project (`ALWAYS_BUDGET_TOKENS`, 24k, chars / 4). It suits short guides
and conventions. `on_demand` — the default, and the only mode for a file
with no extracted text — lists the file for the model to search
(`artifact_search`, lexical windows over the extracted text, no index to
build or go stale) and read (`chat_read_attachment`). Setting `always`
past the budget is refused; an upload asked to be `always` lands on
demand instead.

## Migration

163 renames the table, drops the `project_id` column into
`artifact_references` (mode `on_demand`), stamps every old row's
`key_kind`/`key_ref`, and widens the grant and key kind checks. Nothing
is re-sealed at migration time; nothing a chat could read before reads
differently after. 164 adds the digest columns and the search index,
and marks every row with text `pending`.
