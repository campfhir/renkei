# Code beside the chat — design

Built on the branch this doc sits on; the running description is in
[`docs/chat.md`](./chat.md#code-projects) under "The code pane". Sketches: the
"Code Project Editor Sketches" canvas (seven artboards: three desktop, four
phone), kept in the repository under
[`docs/design/code-editor/`](./design/code-editor/README.md) with a link to
the live canvas. This doc records what the sketches decide and what they
leave open; the cuts at the bottom say what is built.

## What is asked

In a **code project's chat** (`docs/chat.md` § Code projects), see the
repository's actual source while talking to the chat; on a wide screen a
split, code on the left (about 70%) and the chat on the right (about 30%);
on a phone one screen with a switch between the two. Edit a file in place.
Edits land in the checkout without being committed; a **Commit** button
records them when the person says so.

## The good news

Almost all of the plumbing exists, because the chat's own tools needed it:

| Piece                                          | Where                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| One checkout per project on the sandbox worker | `lib/code/scope.ts`, `docs/sandbox-workspaces-design.md`                        |
| Folder listing, checkout or Bitbucket          | `…/code/projects/[id]/tree?path=`, `code/_components/repo-tree.tsx`             |
| Read a file (text, line window)                | `sbWorkspaceRead` (`READ_MAX_CHARS` 200 k, `READ_MAX_BYTES` 4 MB)               |
| Write a file, uncommitted                      | `sbWorkspaceWrite` (text, `WRITE_MAX_CHARS` 1 M), `sbWorkspaceUpload` (bytes)   |
| Diff of the working tree, per file too         | `…/diff?path=&context=`, `sbWorkspaceGitDiff`, `code/_components/diff-view.tsx` |
| Commit as the person, on a new branch or not   | `sbWorkspaceGitCommit` (`message`, `paths`, `newBranch`, `author`)              |
| Push with the person's own Bitbucket grant     | `sbWorkspaceGitPush` + `bitbucketAuthFor`                                       |
| Where a commit stands now                      | `…/diff?commit=` (`git-show`: pushed / in head / gone)                          |
| A self-hosted Monaco with two workers          | `admin/email-sanitizer/script-editor.tsx`                                       |
| A chat pane that already works narrow          | `chat-thread.tsx` `compact` (title bar folds under 640 px)                      |
| A title-bar Changes panel                      | `code/_components/code-chat-tools.tsx`                                          |

So this is a pane over solved verbs, plus three routes, plus one honest
new problem: two writers on one checkout.

## Layout

**Desktop (artboard 1).** The split lives inside the chat page's main
column, not the viewport: the app menu column (18 rem on `lg`) stays where
it is, and the split shares what is left. Default 70 / 30 of that column, a
drag handle between the panes, the ratio remembered in the browser
(`localStorage`, one key for all code chats). The chat pane never goes
under 320 px. The chat pane keeps its existing compact title bar (Tools
plus an overflow menu) whenever the **pane** is under 640 px — today
`compact` is a window media query; it becomes a container measurement
(`ResizeObserver` on the pane) so the split and the phone share one rule.

A **Code** button in the chat's title bar opens and closes the pane; whether
it is open is remembered per browser too. It is open by default the first
time a code chat is visited on a wide screen — the point of the feature is
to see the code, and the button is there for people who want the chat
alone.

**The pane becomes tabs (artboards 4–7)** when the main column is under
about 1024 px, measured on the column: at that width 30% of it is not a
chat. On a phone that is always; on a laptop it is when the app menu is
open and the window is not wide. The two tabs are a segmented control in
the chat's title bar, **Chat | Code**, the Code segment carrying a badge:
the count of files with unsaved edits, else nothing. The title bar is the
right place because it survives the keyboard (`chat-frame.tsx` sizes the
frame to the visual viewport) and because a bottom tab bar would fight the
composer for the same edge.

**Inside the code pane (artboard 1):**

- A **header** (48 px, matching the chat's title bar): a tree toggle, the
  open files as tabs (name, its folder in grey beside it, an amber dot when
  unsaved), then Save, Commit with a count badge, and a close.
- A **tree rail** (220 px), the existing `RepoTree` with two additions: a
  **Changed** section above the tree listing the working tree's modified
  and untracked files with their +added −deleted (from `…/diff?stat=1`, the
  same call the Changes badge already makes when a turn ends), and an `M`
  mark on those files inside the tree. Click a file anywhere to open it.
- The **editor**: Monaco, read-only or not (below), with a line gutter that
  marks lines changed against HEAD in amber (from `…/diff?path=`, parsed
  by `lib/code/diff.ts`; deferred to a later cut, see Scope) and lines with
  unsaved edits in blue.
- A **status line**: path, language, cursor, and the one sentence that
  matters — _Saved to the checkout · not committed_, or _Unsaved edits_ —
  with the working tree's totals.

**On a phone (artboards 5–6)** the Code tab opens on the rail's content
made full-width — Changed first, since that is why someone opens it on a
phone, then the tree — with a bottom bar carrying Search files and Commit
where the composer would be. Opening a file replaces the list with the
file (a Back arrow in a file header, the path, a Diff toggle) and the
editor. Rows are 40–48 px tall for touch.

## Viewing

`GET …/code/projects/[projectId]/files?path=` (the route exists for PUT;
this adds GET), answering `{ path, text, sizeBytes, totalLines, truncated,
etag, language, source }`:

- From the checkout when the project has a ready workspace, through
  `sbWorkspaceRead` — the working tree, uncommitted changes included, the
  same bytes the chat's tools see.
- Before any chat has cloned, from Bitbucket's source endpoint on the
  project's branch (`source: 'bitbucket'`), read-only, the way the tree
  already falls back — so a project's files are there to read the moment
  it is made, and editing simply says _Send a message to clone the
  repository first_.
- `etag` is a SHA-256 of the text as read; the save sends it back (below).
- Binary or over `READ_MAX_BYTES`: `{ binary: true }` or `{ truncated: true
}` and the pane says so instead of an editor. Images could render later;
  not now.
- Any member may read (viewer role included); the workspace's own scope
  check applies as in the tree route.

Tabs: the open files and the active one are kept per chat in
`sessionStorage`, so a reload or a tab switch on the phone does not lose
the place. Unsaved text is kept in memory per file across tab switches and
guarded by `beforeunload`.

**Monaco** is the editor on any device with a fine pointer, configured as
the admin script editor does it (self-hosted, `editor.worker` only; Monaco's
own TypeScript worker is kept off the pane's models — there is no
project-wide type information on the client, so its single-file service
would only mislead). Language intelligence comes from the sandbox worker
instead: see **Language servers** below. Syntax colouring uses Monaco's
built-in tokenizers by file extension, in
two themes (`renkei-light`, `renkei-dark`, `lib/monaco/setup.ts`) that carry
the chat's code palette so a file and the same code quoted in a reply read
alike. On a coarse pointer (a phone) Monaco is replaced by a plain monospace
`<textarea>` with a line-number column and a row of accessory keys above
the keyboard (tab, braces, parens, arrow, semicolon, quote, undo — artboard
6): Monaco on a phone keyboard is a known bad time, and a textarea saves
the bundle. The textarea is coloured all the same: its glyphs are
transparent over a backdrop that draws the same text through the chat's
highlighter (`components/code-tokens.tsx`), sharing every font metric and
scrolling with it. Both editors are one component behind one interface (`value`,
`onChange`, `readOnly`, `markers`), so nothing above them knows which is
mounted.

**Dark mode**: the dark theme follows the app's `data-theme`, as the script
editor already does.

## Language servers

The editor is an IDE's when the sandbox worker has a language server for
the file's language, and a coloured text box otherwise. The shape:

- **The worker runs the server, in the checkout, as the project's uid.**
  `packages/connector-sandbox/src/lsp.ts` is the registry — TypeScript
  and JavaScript (typescript-language-server), Python (Pyright), Java
  (Eclipse JDT), SQL, C and C++ (clangd), Go (gopls), Rust
  (rust-analyzer), R — each with its command, and the sandbox image
  installs them (`docker/Dockerfile`, one layer each). The worker probes
  its PATH at boot and `lsp/languages` says which it found, so a
  deployment that drops a toolchain loses only that language's server.
  `apps/worker-sandbox/src/lsp-sessions.ts` starts one process per
  (checkout, server, editor) exactly as a checkout's commands start
  (setpriv to the project's uid, an environment built from nothing, the
  shell prelude's limits), speaks the protocol's `Content-Length` framing
  over stdio, and owns the lifecycle: it runs `initialize` rooted at the
  checkout and nowhere else, keeps the capabilities for the editor,
  answers the server→client requests that are about the process rather
  than the editor (configuration, capability registration, progress
  tokens, the workspace folder), and shuts the server down on close,
  after ten idle minutes, and when the worker exits. At most six servers
  per checkout, forty-eight per worker.
- **Every message from the browser is checked.** `validateClientMessage`
  refuses anything that is not JSON-RPC 2.0, any lifecycle method, and
  any message naming a `file:` URI outside the checkout — so an editor
  can neither re-root a server nor have it open `/etc/passwd`. What the
  server says back is scrubbed of the project's environment values like
  every other text the worker returns.
- **The transport is two routes.** `POST …/code/projects/[id]/lsp
{ server, clientId }` starts (or, for the same client id, hands back)
  a session and answers its capabilities; `POST …/lsp/[session]` carries
  one message to the server; `GET …/lsp/[session]` is a
  `text/event-stream` of the server's messages, relayed byte for byte
  from the worker's own; `DELETE` shuts it down. The client
  (`lib/lsp/client.ts`) sends in order (a `didChange` must land before
  the completion asked on it), correlates responses, cancels with
  `$/cancelRequest` when Monaco does, and answers the server's own
  requests or says they are unhandled. The `EventSource` reconnects on
  its own and the worker buffers what the server said meanwhile, so a
  hiccup costs nothing. The client id lives in `sessionStorage`, so a
  reload gets its still-running servers back rather than starting them
  again.
- **Monaco is the language client.** `lib/lsp/monaco.ts` registers, from
  the server's capabilities, completion (with resolve), hover, signature
  help, definition / type definition / implementation / references,
  document highlights, formatting, code actions whose edits the pane can
  apply, and semantic tokens (drawn in the pane's own theme, where named
  things fall into the same few colours as the tokenizer's), and turns
  `publishDiagnostics` into markers. Documents are synced whole: `didOpen`
  when a file is first shown, a debounced full-text `didChange` (flushed
  before any request that reads the file), `didSave` from the pane's
  Save, `didClose` when its tab closes. Open tabs stay open to the server
  across tab switches, so a diagnostic in one file sees the unsaved text
  of another. A definition or a reference in another file loads that
  file as a model (peek works) and, when followed, opens it as a pane
  tab and reveals the range; one outside the checkout (a library) is
  named, not opened.
- **The status line says which.** Beside the language: _Starting
  TypeScript…_, _TypeScript language server_, _No Pyright server_ (the
  worker lacks it; colouring only), or _clangd exited · Retry_.
- **Not in this cut.** Rename and workspace-wide edits (an edit to a file
  the pane has not loaded would be silently dropped, so they are not
  offered), commands a server wants the client to run, inlay hints,
  `didChangeWatchedFiles` (servers watch the disk themselves), the
  touch-screen text area (no server; the accessory keys are the point
  there).

## Editing and saving

Editors (`access.role !== 'viewer'`, the same test the files upload route
makes) can type. Viewers, shared chats, and the Bitbucket fallback get the
editor read-only, with the reason in the status line.

**Save is explicit** — the button, or ⌘S / Ctrl+S inside the editor.
Autosave was considered and dropped: the checkout is shared with the
chat's turn and with other members, and a half-typed line landing in the
working tree while a turn runs its tests would be a fine way to make a
green build red. Save writes the file's whole text through the existing
`PUT …/files?path=` — the body is the file, as today — with two additions:
an `If-Match: <etag>` header, and `Content-Type: text/plain` marking an
editor save from an upload for the audit event (`code.files.saved` rather
than `code.files.uploaded`). The route answers the new `etag`. Discard
reloads the file from the checkout.

**The guard (artboard 2).** A save whose `If-Match` no longer matches the
file's current hash is refused with 409, and the pane shows the amber
banner: _The assistant changed this file while you were editing it_, with
**Compare** (a side-by-side of the checkout's text and yours in the same
`DiffView` the chat uses), **Reload theirs** (drop the edits), and **Keep
mine** (save again without the header — an explicit overwrite, never the
default). The same banner appears without a save attempt when a turn ends
and the diff stat says a file with unsaved edits was among the ones the
turn changed; a file open without unsaved edits is simply reloaded when
the turn ends, since that is when the checkout changes (the Changes badge
already refreshes on that signal).

**What the chat knows (artboard 2, chat pane).** A save or a commit from the
editor appends a small **note row** to the chat's transcript — user-role,
kind `edit` or `commit`, stored and streamed the way the auto-mode `nudge`
rows are, shown in the thread as a one-line note rather than a bubble:
_You edited docs/chat.md and saved it to the checkout_; _You committed
a91f3c2 on claude/env-masking: Mask env values…_. Three things follow from
one row:

1. The next turn's model reads it in the conversation, so it knows a person
   changed those files by hand rather than finding a surprise in `git
status` or, worse, overwriting the edit from a stale read.
2. `lib/code/chat-commits.ts` learns the new row kind, so a commit made from
   the editor counts in the Changes panel and its milestone cards exactly
   like one the chat's tool made — the transcript stays the one record.
3. The thread is an honest log of what happened to the repository in this
   chat, whoever did it.

Notes are only written into the chat the editor is open in; a member
editing from another chat of the same project leaves no note here, which
is the same today for the tools.

## Commit (artboards 3 and 7)

The **Commit** button — in the pane's header on desktop, the bottom bar of
the Code tab on a phone — opens a dialog (the app's `Modal`; a bottom sheet
on a phone) that is the existing Changes panel's uncommitted half with
checkboxes and a message:

- The branch it will land on, and **Create a new branch first** with a name
  field (`newBranch` on the commit verb — the usual way to start a change
  for a pull request, as the tool's description says).
- The changed files, all selected, each with its counts, a diff button
  (opens the file's diff in `DiffView` inline), and a small tag — _edited
  here_ for files this browser saved from the editor, _by the chat_ for
  files the chat's tools wrote in this chat (read off the transcript),
  nothing for the rest. Git cannot say who changed a file in a shared
  working tree, so the tags are what the page knows, never a claim.
- Subject and body. **Suggest a message from the diff** asks the chat's
  model for one (a small read-only call with the selected files' diff),
  which the person keeps or edits; a suggestion is never sent on its own.
- The footer says who the commit is authored as and that nothing leaves
  the sandbox until a push.

`POST …/code/projects/[projectId]/commit` `{ message, paths, newBranch?,
chatId? }` → `{ branch, sha, subject }`, editors only, refused in org
read-only mode, authored from the session identity exactly as
`code_git_commit` does, audit event `code.commit`. It writes the transcript
note when `chatId` is given.

**After** (artboard 3, lower card): the dialog becomes the result — the
short hash on its branch, _not pushed_ — with **Push branch** (`POST
…/push`, the person's own grant, the same one call the tool spends),
**Ask the chat to push and open a pull request** (sends the existing
`PULL_REQUEST_ASK`), and Done. If unsaved edits exist when Commit is
pressed, the dialog first asks to save them, since a commit of what is on
disk would silently leave them out.

## Access and safety

- Reads: any member of the project. Writes and commits: editors. Pushes: the
  person's own Bitbucket grant, or a clear "connect Bitbucket" refusal.
- Every path goes through `validateWorkspacePath` as the upload route does;
  the worker never sees a path outside the checkout.
- Environment values never appear: the pane reads files, not the sealed
  `.env`, and a file that happens to contain a secret is the repository's
  own business, as it is for the tools.
- Org read-only mode: the editor is read-only and Commit is withheld, the
  same rule the act tools follow.

## Scope, in cuts

1. **Look** — built. The split and the tabs, the tree with Changed, files
   opened read-only, tabs remembered, the Bitbucket fallback.
2. **Edit** — built. Monaco and the textarea, Save with `If-Match`, Discard,
   the conflict banner with Compare, the `edit` note row, reload on turn end.
3. **Commit** — built, but for the suggested message: the dialog, the commit
   and push routes, the `commit` and `push` note rows counted by
   `chat-commits.ts`. **Suggest a message from the diff** needs a small
   model call of its own and is not there yet.
4. **Later.** Follow the assistant (the editor jumps to the file a turn is
   writing, off when there are unsaved edits); diff markers against HEAD in
   the gutter; find across files (the worker's `grep` verb is there);
   create, rename and delete from the pane; images.

Each cut ships on its own and leaves the chat as it was for anyone who
does not open the pane.

## Open questions

- **Default open?** The sketch opens the pane by default on a wide screen.
  If people mostly chat and only sometimes look, closed-by-default with a
  visible Code button is the gentler start. Cheap to flip.
- **Autosave after all?** A middle path is autosave into a per-browser draft
  (never the checkout) with Save still explicit — the draft survives a
  reload. Worth doing if unsaved-edit loss turns out to hurt.
- **Where a phone's Commit button lives** when a file is open: the sketch
  keeps Save above the keyboard and puts Commit on the list screen. If
  people commit straight from a file, a second button fits there.
