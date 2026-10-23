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

- **Artifacts** in the app menu (Chat group, `/chat/artifacts`): every
  file they own — uploads and what their chats generated — and every file
  shared with them, each with where it is used. The whole page is a drop
  target. One selected at a time: its projects (with how each uses it),
  who can read it, download, replace, rename, share, delete, or — for a
  file someone shared — make a copy they own, or take it off their list.
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
([delegate-key-design.md](./delegate-key-design.md)). An artifact has a
key of its own, kind `artifact`:

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
**promoted**: opened by whoever may (their access), re-sealed under a new
key of its own (minted as the owner's, so the owner's key must be
delegated — signed in, or their automation delegation standing), and
wrapped under its chat and every project that holds it. A plain chat
upload stays under the chat's key from the start, and so costs nothing
more than before until it is kept.

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
differently after.
