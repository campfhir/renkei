# Code workspaces — design

Written with the change that built them. The sandbox connector
([`sandbox-connector-design.md`](./sandbox-connector-design.md)) gave an
agent a scratch space and a browser; this adds the third thing a person
working with a model wants from a sandbox — **a repository to work in**,
the way Claude Code works in a checkout: look around, search, read, edit,
run the project's own commands, commit, push, open a pull request.

## What a person sees

A **Code** section in the app menu, beside Chat, where the deployment
enables workspaces (`SANDBOX_WORKSPACES_ENABLED=true` on the web app and
the sandbox worker). It holds **code projects** — a chat project with a
repository on it, kept apart from ordinary chats:

- **New code project** asks for a name, one of your Bitbucket
  repositories (a picker fed by your own grant; a branch, optional), the
  text of a `.env` — pasted as it is — and instructions. Creating it
  starts the clone; the project page follows it until it reads _Ready_.
- **The project page** shows the repository and its checkout (clone
  again, change repository), the environment as names (replace by
  pasting a `.env` again, remove one), and everything a chat project's
  page has: instructions, files, memory, toolset, the chats inside it,
  sharing. Values are never shown again, to anyone.
- **New chat** starts a chat in the project. Its chats are listed on the
  project's page, right under its environment, and among the person's
  chats in the app menu — marked with the Code glyph and naming the
  project beneath the title, so they are told apart from ordinary chats
  and from chats in chat projects at a glance.

In such a chat the model has the `code_*` tools (below) bound to the
project's checkout and a brief in its system prompt on how to work in
one; Jira, Confluence and the rest of the person's connectors are there
beside them as always, so "fix PROJ-123 and open a PR" is one
conversation. The tools exist nowhere else — not in other chats, not on
the MCP surface — because they name no workspace: the project is the
workspace.

The checkout and the environment belong to the **project**, not to
whoever is chatting: the worker scopes them by the subject
`code-project:<id>`, so every member works in one checkout with one
environment, and the worker's per-caller isolation becomes per-project
isolation. What is personal is the credential: a push or pull spends the
chatting person's own Bitbucket grant, and a commit is authored as them.

## The tools

Local tools of the chat (`apps/web/lib/code/tools.ts`), added to a turn
when the project's checkout is ready (`lib/code/turn.ts`):

| Tool              | Kind | What it does                                                                                |
| ----------------- | ---- | ------------------------------------------------------------------------------------------- |
| `code_ls`         | Read | One directory's entries.                                                                    |
| `code_find`       | Read | Paths matching a glob (`.gitignore` honoured).                                              |
| `code_grep`       | Read | Regex search of contents, as `path:line: text`.                                             |
| `code_read_file`  | Read | A file's text with line numbers, in line ranges.                                            |
| `code_write_file` | Act  | Create or replace a file.                                                                   |
| `code_edit_file`  | Act  | Replace one exact snippet (must be unique, or `replaceAll`).                                |
| `code_run`        | Act  | A bash command in the checkout, with the project's environment; exit code and both streams. |
| `code_git_status` | Read | Branch, changed files, a diff summary or the full diff, recent log.                         |
| `code_git_commit` | Act  | Stage (all or listed paths) and commit as the person, optionally on a new branch.           |
| `code_git_push`   | Act  | Push the current branch to origin with the person's grant; never force.                     |
| `code_git_pull`   | Act  | Fast-forward from origin, or fetch and switch to another remote branch.                     |
| `code_env_names`  | Read | The names of the project's environment variables — never a value.                           |

A pull request is `bitbucket_create_pull_request`, as before. The worker
verbs behind these (`/v1/workspaces/*`, `/v1/env/*` on
`apps/worker-sandbox`) are reachable only from the web app with the
bearer key; nothing on the MCP surface reaches a checkout. Two verbs
serve the page rather than the model: `git-diff` (the working tree
against HEAD, untracked files included, with per-file counts) and
`git-show` (one commit by its hash — never a ref — with its header, its
diff against its parent, and where it stands: `pushed` when any remote
branch holds it, `inHead` when the current branch's history does), both
behind `…/code/projects/[projectId]/diff`, the latter with `?commit=`.

## Why a shell, after "curated verbs, not a shell"

The sandbox design doc drew a hard line: every verb is one bounded thing
the worker does, never an arbitrary command. `code_run`
crosses it on purpose, because a repository's own commands — its test
runner, its build, its package manager, its linter — are the whole point
of working in a checkout, and there is no curated verb for "whatever
this project's `Makefile` says". So the line moves from _what_ runs to
_who runs it and where_, and that is where the containment now lives.

## Containment

**Who.** The sandbox image's entrypoint (`docker/sandbox-entrypoint.sh`)
keeps the worker as root only when workspaces are enabled, and only so
that every command it starts for a caller can be dropped with `setpriv`
to **that caller's own unprivileged uid** — derived from the worker's
`(tenantId, subject)` scope (`execUidFor`), which for a code project is
the project itself, stable across restarts, far above any system
account — with no supplementary groups, no capabilities, and
`no-new-privs` so a setuid binary cannot climb back. The worker itself
does nothing as root but spawn, chown and read.

**Where.** A second volume (`SANDBOX_WORKSPACES_DIR`, default
`/workspaces`, mode 0711) holds `<tenant>/<sha256(scope)>/` per project
at 0700, owned by its uid, with a `home/` (caches, dotfiles) and its
checkout, named by id, never by repository. The staged-file
disk (`/data`) is root's, and the worker sets `umask 077` at boot, so
nothing it creates from then on is readable by any caller's uid. One
caller's `cat` of another's checkout, or of `/proc/<worker>/environ`
(the database URL, the bearer keys), is a permission error.

**What it may do to the machine.** Every command runs behind a prelude
that caps its process count (per uid, so a fork bomb stops at the
caller's own ceiling), the largest file it may write, and core dumps;
each has a wall-clock limit (two minutes by default, ten at most) after
which its whole process group is killed; output is bounded in memory and
clipped head-and-tail for the model. A checkout that grows past 2 GB
refuses further commands until something is deleted.

**Paths.** A caller-supplied path is validated (relative, no `..`, no
control characters, nothing written under `.git`) and then resolved and
checked again against the checkout's real path, so a symlink in the
repository cannot aim a read or a write outside it. Searches run as the
caller through ripgrep; reads and writes are the worker's, behind that
check.

**Network — the honest gap.** A command has the container's network,
because `pnpm install` and a test against a sandbox API need it, and the
browser's egress proxy cannot be forced on an arbitrary process. Nothing
a command can reach is protected by network position alone (every worker
takes a bearer key; Postgres a password; none of those are in a
command's environment), but a deployment with workspaces enabled should
still put the sandbox worker on its own network with a route out and no
route to the other services — the compose file says so beside the
service. Per-command network namespaces are the next step if that
placement is not enough.

**Without root** (a developer's checkout, `pnpm dev`), commands run as
the worker's own user with no per-caller isolation; startup logs that
plainly. Fine for one person; wrong for a shared deployment.

## The `.env`: the model sees names, never values

A project's commands need credentials — a registry token, a database
URL, an API key — and a credential in a tool result is a credential in
a transcript. So, as with browser secrets, values go around the model:

- **Supplied on the project, never over MCP.** The `.env` is pasted when
  the project is made and replaced from its page
  (`/api/tenant/[tenantId]/code/projects/[projectId]/env`), with the
  person's own session. It is parsed in the web app (`parseDotenv`:
  comments, `export`, quotes, multi-line double-quoted values) and only
  the pairs travel on; lines that were not variables are reported back.
  `code_env_names` lists names.
- **Sealed by the worker, under its own key.** A value passes through
  the web app once, on the way in, and the worker seals it
  (`sandbox_env_secrets`, an `env1.` envelope over `@renkei/crypto`'s
  secretbox) under `SANDBOX_ENV_SECRETS_KEY` — a key the web app does
  not need to hold — falling back to `TOKEN_ENCRYPTION_KEY` for a
  one-key deployment. Nothing can read it back but the worker, at exec
  time, into that one process's environment. Replacing the `.env`
  replaces the whole set on the worker (`env/replace`), so what the
  project's commands see is always exactly what was last pasted.
- **Scrubbed from every answer.** The worker opens the caller's values
  once per request and runs every string it returns for a workspace —
  command output, file text, grep lines, git's own messages — through
  the browser secrets' `scrubSecretValues`, in every spelling that scrub
  knows. A command that prints its environment, or writes a token into a
  file a later read picks up, answers with the mask.
- **Not overridable where it would matter.** `PATH`, `HOME`,
  `LD_PRELOAD`, `NODE_OPTIONS`, `GIT_CONFIG_*` and their kin are refused
  as names: a value there would change what runs, not what it is told.

What a command does with a value it was given — sends it to the service
it is for — is, of course, the point.

## Git credentials

A clone, pull or push spends the acting person's own Bitbucket grant —
the creator's for the clone, the chatting person's for a push or pull:
the web app resolves the token (the same resolver the `bitbucket_*` tools use,
the same requested ∩ granted scope check — `repository` to clone or
pull, `repository:write` to push), turns it into git's Basic
`x-token-auth` header, and hands the worker that header in the request
body for one call. The worker puts it in that one git process's
environment as an `http.extraheader` config entry — never in argv (a
`ps` away), never in `.git/config` (at rest on the volume) — and it is
gone when the process exits. The stored remote URL carries no
credential, so `git fetch` typed into `code_run` fails by
design; the git tools are the way to reach the remote.

Commits are authored as the person: their org email when the identity
knows it, else a no-reply address on their Bitbucket username.

## Lifetime and limits

| Bound                            | Value                            |
| -------------------------------- | -------------------------------- |
| Checkouts per project            | 1 (a new clone replaces it)      |
| Lifetime since last use          | 7 days (the worker's sweep)      |
| Checkout size                    | 2 GB                             |
| Default clone depth              | 100 commits (`depth: 0` for all) |
| Command timeout                  | 2 min default, 10 min max        |
| Command output to model          | 30k chars default, 100k max      |
| Processes per project            | 512 (RLIMIT_NPROC)               |
| Largest file a command may write | 512 MB (RLIMIT_FSIZE)            |
| Environment variables            | 50 per project, 8 KB each        |

A workspace's row (`sandbox_workspaces`, migration 101) is the metadata
half; the sweep that retires expired staged files retires expired
checkouts the same way — bytes first, then the row. A clone that never
finished (a crash mid-clone) sits in `cloning` until its lifetime lapses.
A ready row whose directory is gone — the container recreated without
the workspaces volume mounted, the directory removed by hand — is marked
`failed` the first time a verb reaches for it, with a message that says
it will be cloned again. The chat does that itself, mid-turn: the model
has no clone tool, but every `code_*` tool is wrapped (`lib/code/tools.ts`)
so that a "not ready" answer re-reads the project, adopts a newer clone
if another chat already made one, otherwise clones again with the
chatting person's grant, waits for it as the turn's first step would,
and runs the same call again in the new checkout — saying so at the top
of its answer. One clone is shared by every tool that hits the wall at
the same time. After two consecutive losses in one turn the tools stop
trying and every call answers the same refusal, telling the model to
stop and tell the person: a checkout that keeps vanishing is the
worker's volume, not something another clone fixes. The next turn's
prelude starts afresh. The model also has `code_clone`, a probe that
reports the checkout present or, through the same wrapper, brings it
back — it never re-clones a checkout that is there. The worker's "gone"
answer says whether it has the project's other files (this checkout
alone was removed) or none at all (a worker without the volume, or a
second instance behind one address), names itself (hostname, uptime),
and every workspace it describes carries `worker` for the same
comparison. Replicas of the worker on one host are fine when they share
both named volumes — nothing about a checkout lives in memory, every
verb reads the disk — and each replica's sweep removes only bytes it can
see (DEPLOYMENT.md, "More than one sandbox replica"); a clone whose directory is missing straight after `du`
measured it is marked failed rather than ready; before that check every such verb answered a bare
`spawn setpriv ENOENT`, Node's word for a working directory that is not
there, which reads as a missing binary. The worker also proves at boot,
when it is root, that setpriv can drop a command to another uid, and
refuses to start otherwise.
The code project (`chat_projects` with `kind = 'code'`, migration 102)
keeps a soft reference to its checkout; when the worker no longer has
it, the project page says so and offers to clone again, and the chat's
prompt says the tools are not available until it is.

## What it deliberately is not

Not a general container the model controls — no `docker`, no root, no
network isolation to promise beyond placement — and not a way past the
sandbox's other rules: staged files and the browser are unchanged, the
knowledge index never sees a checkout, and a workspace is working state
with a lifetime, not a source of truth. Bitbucket is the one provider;
the vocabulary (`provider` on the row and the clone verb) leaves room
for another.
