# Code workspaces — design

Written with the change that built them. The sandbox connector
([`sandbox-connector-design.md`](./sandbox-connector-design.md)) gave an
agent a scratch space and a browser; this adds the third thing a person
working with a model wants from a sandbox — **a repository to work in**,
the way Claude Code works in a checkout: look around, search, read, edit,
run the project's own commands, commit, push, open a pull request.

## What a person sees

A **Code** section in the app menu, beside Chat, where the organization
has turned code workspaces on (Settings → Sandbox; the sandbox worker
checks the same setting per request). It holds **code projects** — a chat project with a
repository on it, kept apart from ordinary chats:

- **New code project** asks for a name, one of your Bitbucket
  repositories (a picker fed by your own grant; a branch, optional), the
  text of a `.env` — pasted as it is — and instructions. Creating it
  starts the clone; the project page follows it until it reads _Ready_.
- **The project page** shows the repository and its checkout (clone
  again, change repository), the environment as names (replace by
  pasting a `.env` again, remove one), a Bitbucket project's Pipelines
  at a glance (a card opening its Pipelines page, below), and everything
  a chat project's page has: instructions, files, memory, toolset, the
  chats inside it, sharing. Values are never shown again, to anyone.
- **New chat** starts a chat in the project. Its chats are listed on the
  project's page, right under its environment, and among the person's
  chats in the app menu — marked with the Code glyph and naming the
  project beneath the title, so they are told apart from ordinary chats
  and from chats in chat projects at a glance.
- **A worktree per chat.** Any number of chats in a project work at once.
  The project's clone is its **base**, which no chat edits; each chat
  works in a `git worktree` of it, on a branch of its own
  (`renkei/<last 12 hex of the chat id>`), made on the chat's first turn —
  or earlier, by its owner's first write from the code pane — and recorded
  on `chats.workspace_id` (migration 158; `lib/code/worktree.ts`,
  `startChatWorktree` in `lib/code/projects.ts`, the worker's `worktree`
  verb). It is a `sandbox_workspaces` row of its own (`parent_id` names the
  base), so every worker verb already addresses it by id; it shares the
  clone's object store, so making one takes moments and costs only its
  working files. The remote is fetched first with the chatting person's
  grant, so the chat starts from where the default branch is now, not from
  the clone; without a usable grant it starts from the clone. Edits,
  uncommitted files, branch switches and `code_run` in one chat are
  invisible to the others; work travels between them as it does between
  people — committed, pushed, merged. A new chat is never refused for
  another's running reply. The base is left on a detached `HEAD` so any
  worktree may check out the branch the clone began on. Deleting a chat
  deletes its worktree (best effort; the worker's sweep takes what that
  misses); deleting or re-cloning the project takes every worktree of it,
  and a chat whose worktree is gone is given a new one on its next turn
  (the branch outlives the worktree, so the work committed there is checked
  out again). Previous chats stay listed and readable and are no different
  from the latest — `chat_recall_chats`
  (`apps/web/lib/chat/recall-tools.ts`) still reaches what another chat
  found, tried or decided, in the project's own chats and nothing outside
  it. The code pane's routes are reached through the chat
  (`/api/code/projects/[projectId]/chats/[chatId]/files`, `/tree`, `/diff`,
  `/commit`, `/push`, `/discard`, `/branch`, `/lsp`): anyone who can read
  the project may look in a chat's worktree, only the chat's owner changes
  it; the project-level addresses of the same routes work on the base clone.
  Chat projects are untouched.

In such a chat the model has the `code_*` tools (below) bound to the
chat's worktree and a brief in its system prompt on how to work in
one; Jira, Confluence and the rest of the person's connectors are there
beside them as always, so "fix PROJ-123 and open a PR" is one
conversation. The tools exist nowhere else — not in other chats, not on
the MCP surface — because they name no workspace: the chat's worktree is
the workspace.

The clone and the environment belong to the **project**, not to
whoever is chatting: the worker scopes them — and every worktree of the
clone — by the subject `code-project:<id>`, so every member works from one
clone with one environment, and the worker's per-caller isolation becomes
per-project isolation. What is personal is the credential: a push or pull spends the
chatting person's own Bitbucket grant, and a commit is authored as them.

## The tools

Local tools of the chat (`apps/web/lib/code/tools.ts`), added to a turn
when the project's checkout is ready (`lib/code/turn.ts`):

| Tool                       | Kind | What it does                                                                                                     |
| -------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------- |
| `code_ls`                  | Read | One directory's entries.                                                                                         |
| `code_find`                | Read | Paths matching a glob (`.gitignore` honoured).                                                                   |
| `code_grep`                | Read | Regex search of contents, as `path:line: text`.                                                                  |
| `code_read_file`           | Read | A file's text with line numbers, in line ranges.                                                                 |
| `code_write_file`          | Act  | Create or replace a file.                                                                                        |
| `code_edit_file`           | Act  | Replace one exact snippet (must be unique, or `replaceAll`).                                                     |
| `code_delete_file`         | Act  | Remove a file, or a folder and everything under it.                                                              |
| `code_move_file`           | Act  | Rename or move a file or folder; refuses an existing destination.                                                |
| `code_run`                 | Act  | A bash command in the checkout, with the project's environment; exit code and both streams.                      |
| `code_git_status`          | Read | Branch, changed files, a diff summary or the full diff, recent log.                                              |
| `code_git_commit`          | Act  | Stage (all or listed paths) and commit as the person, optionally on a new branch.                                |
| `code_git_push`            | Act  | Push the current branch to origin with the person's grant; `forceWithLease` after a rebase, never a plain force. |
| `code_git_pull`            | Act  | Fast-forward from origin, or fetch and switch to another remote branch.                                          |
| `code_git_log`             | Read | The history as records: a revision or range, paths, `grep`/`author`, paged.                                      |
| `code_git_fetch`           | Act  | Fetch origin (one branch or all) with the person's grant; `prune`.                                               |
| `code_git_branch`          | Act  | List local and remote-tracking branches; create, switch (a remote one by name), delete.                          |
| `code_git_rebase`          | Act  | Rebase onto a revision; stops on conflicts and names the files; continue, skip, abort.                           |
| `code_git_merge`           | Act  | Merge a revision in (`--no-ff`, squash, a message); the same conflict shape.                                     |
| `code_git_reset`           | Act  | Move the branch (soft, mixed, hard, keep) or unstage paths.                                                      |
| `code_git_stash`           | Act  | Push, list, show, pop, apply, drop — by position.                                                                |
| `code_git_clean`           | Act  | Remove untracked files; a dry run unless `dryRun: false`; `ignored` for ignored ones too.                        |
| `code_git_sparse_checkout` | Act  | Narrow the working tree to named directories (cone mode), add, list, disable.                                    |
| `code_env_names`           | Read | The names of the project's environment variables — never a value.                                                |
| `code_service_*`           |      | Containers beside the checkout, where the deployment offers them — see "Services" below.                         |
| `code_preview_*`           |      | The project's own server, run in the checkout and served through the app — see "Previews" below.                 |

A pull request is `bitbucket_create_pull_request`, as before. The worker
verbs behind these (`/v1/workspaces/*`, `/v1/env/*` on
`apps/worker-sandbox`) are reachable only from the web app with the
bearer key; nothing on the MCP surface reaches a checkout.

**The rest of git** (`apps/worker-sandbox/src/git-verbs.ts`, the tools in
`apps/web/lib/code/git-tools.ts`) keeps the "curated verbs" line rather
than opening `git` in `code_run`: every argument passes a validator in
`@renkei/connector-sandbox` first — a revision is a branch or tag name,
`origin/<branch>`, a head or a hash with `~N`/`^N` steps and never an
option (`validateGitRevision`, `validateGitRange` for `a..b`), a path is
inside the checkout, a stash is a position — and a remote operation
(`fetch`, `push`) spends the person's own grant for one call as before.
Rebase and merge are shaped for how a developer finishes one: the answer
says `completed`, or `inProgress` with the `conflicts`, and the same verb
takes `continue` (the resolved files are `git add`ed by the worker — the
model has no add of its own, it edits with the file tools), `skip` and
`abort`; `git-status` reports an operation left half-done and the files
still in conflict, so the next turn sees it. Nothing opens an editor
(`GIT_EDITOR=true`). `reset --hard` and `clean` discard work, and the tool
descriptions say so; `clean` is a dry run unless told otherwise. After a
rebase the remote branch must be replaced, so `git-push` takes
`forceWithLease` — `--force-with-lease`, which refuses when the remote
moved since the last fetch — and a plain `--force` is still nowhere. A
sub-agent (`code_delegate`) is not offered the verbs that reshape the
branch or the checkout (fetch, rebase, merge, reset, stash, clean, sparse
checkout, previews): those are the orchestrator's call.

**Sparse checkouts.** `clone` takes `sparsePaths` (`git clone --sparse`,
then `sparse-checkout set --cone`), so a monorepo project's checkout holds
one app's directories and the root's files; a worktree made of it
inherits the patterns (git copies them on `worktree add`), and
`code_git_sparse_checkout` narrows or widens a worktree on its own
(per-worktree config, so the base and the other chats are untouched).
History and objects are whole either way; only the working tree is
narrowed. Two verbs
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
clipped head-and-tail for the model. A command is also killed when its
caller goes away — the chat turn behind it was stopped, and the request
dropped — and when the worker itself is told to stop: on SIGTERM the
worker turns new requests away (503 `shutting_down`), kills every
command in flight and answers each with `interrupted: true`, which
`code_run` renders as "INTERRUPTED … run it again" rather than as a
failure of the command's own; a read the web app makes while the worker
is restarting is retried for a few seconds (`@renkei/sandbox-client`),
a command or a write never. A checkout that grows past its limit
refuses further commands until something is deleted. The limit is the org
setting `sandboxWorkspaceMaxBytes` (default 8 GB, Admin → Settings); a
project member may ask for more, and an admin's approval raises that
project's limit only (`sandbox_size_requests`, `getWorkspaceLimitBytes`).

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
placement is not enough — and they are what `sandbox_run_python`
(`sandbox-connector-design.md`) already uses, since a script over a
person's staged files needs no network at all: the same runner, with
`isolateNetwork` set, starts the interpreter under `unshare --net`
before the uid drop where the container may.

**Without root** (a developer's checkout, `pnpm dev`), commands run as
the worker's own user with no per-caller isolation; startup logs that
plainly. Fine for one person; wrong for a shared deployment.

## The `.env`: the model sees names, never values

A project's commands need credentials — a registry token, a database
URL, an API key — and a credential in a tool result is a credential in
a transcript. So, as with browser secrets, values go around the model:

- **Supplied on the project, never over MCP.** The `.env` is pasted when
  the project is made and replaced from its page
  (`/api/code/projects/[projectId]/env`), with the
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

## Pipelines: a page of their own, never a chat tool

A Bitbucket code project has a **Pipelines page**
(`/[slug]/code/[projectId]/pipelines`,
`apps/web/app/(app)/code/_components/pipelines-page.tsx`, over
`/api/code/projects/[projectId]/pipelines` and
`apps/web/lib/code/bitbucket-pipelines.ts`): the recent runs (state,
ref, who, when, how long — each opening on Bitbucket, where the steps
and logs are), a way to start one (a branch or tag, optionally a named
custom pipeline; `runs/route.ts`, on `pipeline:write` exactly as the
chat's `bitbucket_trigger_pipeline` is), whether Bitbucket runs pipelines for the repository at
all, whether a `bitbucket-pipelines.yml` is on the project's branch —
and when there is none, an editor that starts one from the org's
**pipeline templates** (`pipeline_templates`, migration 122, seeded with
Node/pnpm, Node/npm, Python and a bare skeleton; operators rename,
rewrite or delete them at `/admin/pipeline-templates`, the
project-templates idiom) and commits it to the branch with the person's
own grant over `config-file/route.ts`, on `repository:write` as a code
project's pushes are; the file there is edited the same way — and
the variables the runs get — the repository's own and each deployment
environment's, each set edited as one text box (`KEY=value` a line as a
`.env` reads, `KEY: value` taken too, `secret ` in front of a secured
one; `parseVariableText`/`renderVariableText`) and applied as the
difference against what Bitbucket has (`applyVariableText`, over
`variables/route.ts`): creates, replacements and deletions each on their
own call, so a refusal names its key and the rest still lands. A secured
variable renders as `secret KEY=` and keeps its value while that line
stays; a line taken out removes the variable, after the page names what
is about to go. The project page carries only a card
(`pipelines-summary.tsx`, the route's `?view=summary`: on/off, the file,
counts, the last run — no names or values) so it stays a summary, and
the page has the room for a runs table beside the setup. It exists to
make CI/CD the path of least resistance: the page says what is missing
and what to do about it (turn it on here; start the file from a template
here, or ask a chat to write one fitted to the code), and the variables
are set where the person already is. The page is
framed provider-neutrally — runs, setup, variables — so a GitHub Actions
variant can fill the same frame from its own reader; today the page and
the card render for Bitbucket projects only.

The split follows the `.env`'s rule. The **YAML is a file**: a chat can
write and commit it with the code tools, and a chat can run, watch and
stop pipelines through the `bitbucket_*` tools. The **switch and the
variables are not tools**, and are never to be: a pipeline variable is
where a deploy key or a registry token lives, and a value the model can
set is a value in a transcript. They are read and written on the page
with the person's own Bitbucket grant, a value travels to Bitbucket once
and is never echoed, and Bitbucket keeps a secured variable's value to
itself (its API never returns one, and neither does this route). The
audit log records the key and where it lives, never the value.

Two Bitbucket scopes sit under it beyond a code project's own three
(`apps/web/lib/atlassian-scopes.ts`): the switch stands on
`repository:admin` (the admin bundle, off by default), the variables on
`pipeline:variable` — a checkbox of its own, "Set pipeline variables",
that no `bitbucket_*` tool maps to (`mcp-tools/bitbucket/scopes.ts`), so
granting it registers nothing for the model. A connection narrowed away
from either is told so in the Connectors page's words before Bitbucket
is asked. Not on the page, on purpose: workspace-wide variables (a
workspace's secrets are not one project's to edit), SSH keys, schedules
and caches — the Bitbucket UI, linked from the section, keeps those.

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

| Bound                            | Value                                                 |
| -------------------------------- | ----------------------------------------------------- |
| Clones per project               | 1 (a new clone replaces it, and takes its worktrees)  |
| Worktrees per project            | one per chat (50 per project at once)                 |
| Lifetime since last use          | 7 days (the worker's sweep)                           |
| Checkout size                    | 8 GB (org setting; per-project approval may raise it) |
| Default clone depth              | 100 commits (`depth: 0` for all)                      |
| Command timeout                  | 2 min default, 10 min max                             |
| Command output to model          | 30k chars default, 100k max                           |
| Processes per project            | 512 (RLIMIT_NPROC)                                    |
| Largest file a command may write | 512 MB (RLIMIT_FSIZE)                                 |
| Environment variables            | 50 per project, 8 KB each                             |

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

## Services: a container beside the checkout

A project's tests usually need something running — a database, a
cache, a broker — and a checkout on its own has none. So a project may
start **services**: containers the sandbox worker runs beside the
checkout, from images the organization allows, reachable from every
command the project runs. The organization's **Code project services**
switch (Settings → Sandbox; with workspaces on, and the worker given a
Docker engine — DEPLOYMENT.md) puts four tools in a project's chat:

| Tool                 | Kind | What it does                                                                 |
| -------------------- | ---- | ---------------------------------------------------------------------------- |
| `code_services`      | Read | What is running: name, image, status, address, the variables it sets.        |
| `code_service_start` | Act  | Pull an allowed image, start it on the services network, answer its address. |
| `code_service_logs`  | Read | The container's last lines — is it ready, why did it stop.                   |
| `code_service_stop`  | Act  | Stop and remove the container with its data; the name is free again.         |

The model names the service (`db`), the image (`postgres:16`), the
container's own variables (`env`: `POSTGRES_PASSWORD`, a throwaway) and
what to export into the project's commands (`exports`: templates over
`{host}` and `{port}` — `DATABASE_URL: postgres://postgres:pw@{host}:{port}/app`).
A person has the same verbs on the project's **Services page**
(`/[slug]/code/[projectId]/services`,
`apps/web/app/(app)/code/_components/services-page.tsx`, over
`/api/code/projects/[projectId]/services`): what is
running with its address, the variables it sets and when it expires,
every service's log lines in one time-ordered tail that follows as
they write (the worker reads each container's lines stamped by the
engine and merges them; the page asks every few seconds for what came
after its last line, filtered to one service when wanted), a Stop, and
a form to start one — name, image, the
container's variables and the exports as text, `KEY=value` a line — with
the organization's allowed images listed beside it so the image field is
not a guess. The project page carries only a card (`services-summary.tsx`,
the route's `?view=summary`: how many running, their names, how many
images are allowed) that opens the page, the Pipelines arrangement, so
the project page stays a summary; a start or stop from the page is an
audit event (`code.services.started`, `code.services.stopped`).
While the service runs, every `code_run` command gets
`SERVICE_<NAME>_HOST`, `SERVICE_<NAME>_PORT` (the lowest port the image
declares) and `SERVICE_<NAME>_PORTS`, plus the exports rendered — set
over the project's `.env`, because a service is started to be what the
tests talk to. A sub-agent can list and read logs but not start or stop
one: what runs beside the checkout is the orchestrator's call.

**The image is the boundary.** The organization keeps an allow-list
(`code_service_image_rules`, migration 122; Organization → Code services
in the admin console) of rules in one of three shapes, each normalized
to `host[/path]`: a whole registry (`myorg.azurecr.io`), a namespace on
one (`myorg.azurecr.io/platform/*`), or a single repository at any tag
(`docker.io/library/postgres` — typed as `postgres`, `postgres:16` or
`index.docker.io/library/postgres`, all one repository to the rules).
Every tenant is seeded with a handful of public images and an operator
adds their own registry, so a private Azure Container Registry can be
allowed wholesale while Docker Hub is allowed only by name. A reference
the model gives is parsed the way `docker pull` reads it and matched
against the rules; the most specific rule wins, and a refusal names what
is allowed. A rule may carry the credential its registry is pulled with
(a service principal, a pull token): the worker seals the secret under
its own key — the environment secrets' key, a `reg1.` envelope — the
listing shows the username only, and the credential rides the one pull
request that needs it.

**Containment.** The engine answers to the worker process — its socket
(or the proxy in front of it) is root's, and a project's commands, dropped
to their own uids, cannot open it; what may run is decided by the worker
against the rules, never by anything a command can do. A service is a
plain container: no privileges, `no-new-privileges`, a memory and a pids
ceiling, no restart policy, no published ports, on an INTERNAL Docker
network with no route out, so an image that turns out to be more than a
database reaches neither the internet nor the other compose services from
there. It is reached by address from the worker's own container, joined
to that network at boot — where every project's commands run — so, as
with the checkouts' shared network, one project can reach another's
service if it knows the address and the password; the password is the
project's own. A service lives a day past the project's last command
(`sandbox_services`, the same expiry-on-use as a checkout); the worker's
sweep stops and removes it with its anonymous volumes, and removes any
container carrying its label that no row claims.

## Previews: the project's own server, reached from outside

A chat that built a web page, an API or a static site wants to show it,
and a person wants to open it — in a browser, on a phone, from a webhook
— without the code leaving the sandbox. So a project may run
**previews** (`apps/worker-sandbox/src/previews.ts`, the tools in
`apps/web/lib/code/preview-tools.ts`): the project's own start command
(`pnpm dev`, `uvicorn app:app`, `python -m http.server`) run in the chat's
worktree as a long-lived process — the same uid drop, prelude, limits and
environment as `code_run`, with `PORT` (and `HOST=0.0.0.0`) set to a port
the worker chose from its own range (or the one the project insists on,
checked free) and `RENKEI_PREVIEW_URL` set to where the app serves it —
and reached only through the web app:

| Tool                 | Kind | What it does                                                                                                   |
| -------------------- | ---- | -------------------------------------------------------------------------------------------------------------- |
| `code_previews`      | Read | What is running: name, state, port, the address to open.                                                       |
| `code_preview_start` | Act  | Run the command, wait for the port to accept connections, answer the address (and a share link when `public`). |
| `code_preview_logs`  | Read | The server's output, both streams stamped, newest last.                                                        |
| `code_preview_stop`  | Act  | End the process tree; the address and the share link stop working, the name is free.                           |

**How a request gets there.** Nothing is published on the container: the
process listens on the worker's own loopback, and the only way in is the
app's relay (`apps/web/lib/code/previews.ts`, `previewRelay`) —
`/api/code/projects/[projectId]/previews/[name]/app/…` (and the same
under `/chats/[chatId]/`), which checks the person's session and
membership like every project route, then forwards the request as it
came (any method, the body streamed, `duplex: half`) to the worker's
`/v1/previews/proxy/<name>/…` with the bearer key and the project's
subject in a header; the worker (`preview-endpoints.ts`) relays it to
`127.0.0.1:<port>` and streams the answer back. Hop-by-hop headers stop at
each hop; the app's own session cookie is taken out of the `cookie`
header before it goes (the preview runs the project's own code — a
repository that captured it would hold the person's session) and the
server's other cookies pass; `accept-encoding: identity` is asked of the
server so what the app relays is what the browser gets;
`x-forwarded-host`, `-proto` and `-prefix` say where the request really
came from; a `location` that names a path on the server is rewritten
under the preview's prefix so a redirect lands back inside it. The
preview's answers are NOT scrubbed of environment values — they are the
project's own server's, relayed as bytes like `download` — which the
model is told. WebSockets (a dev server's HMR) do not cross the relay.

**Share links.** Started with `public`, a preview also gets a token — 32
random bytes, minted in the web app so the public address can be told to
the process — and `/api/code/preview/<token>/…` relays without a session,
through the worker's `/v1/previews/public/<token>/…`. The token is the
whole secret: it travels only inside its link, is answered by nothing the
worker does not hold, and stops working the moment the preview is stopped
or expires. It is for a phone, a colleague or a webhook to reach what a
chat built for a few hours, not a way to host.

**Lifetime and bounds.** A preview is working state in the worker's memory
and process table: at most 3 per project, alive 4 hours past its last
relayed request (the sweep ends an idle one), ended when its checkout is
deleted and when the worker stops (none outlives the process; a restart
takes every preview with it and the list says so by saying nothing). The
start waits up to 60 seconds (5 minutes at most) for the port to accept
connections and answers either way — listening, still starting, or
exited with its last lines — and keeps 2,000 lines of output. Because
every project's commands share the worker's network namespace, one
project's command can reach another's preview on the loopback if it
knows the port, as it can a service; the honest gap above applies. A
start or stop from the routes is an audit event
(`code.previews.started`, `code.previews.stopped`).

## What it deliberately is not

Not a general container the model controls — no `docker` in a command,
no root, no image outside the organization's rules, no network isolation
to promise beyond placement — and not a way past the sandbox's other
rules: staged files and the browser are unchanged, the knowledge index
never sees a checkout, and a workspace (and a service beside it) is
working state with a lifetime, not a source of truth. Bitbucket is the
one provider; the vocabulary (`provider` on the row and the clone verb)
leaves room for another.
