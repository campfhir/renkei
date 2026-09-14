# Code workspaces — design

Written with the change that built them. The sandbox connector
([`sandbox-connector-design.md`](./sandbox-connector-design.md)) gave an
agent a scratch space and a browser; this adds the third thing a person
working with a model wants from a sandbox — **a repository to work in**,
the way Claude Code works in a checkout: look around, search, read, edit,
run the project's own commands, commit, push, open a pull request.

## What a person sees

On the connectors page, two cards appear where the deployment enables
workspaces (`SANDBOX_WORKSPACES_ENABLED=true` on the web app and the
sandbox worker):

- **Code workspaces** — clone one of your Bitbucket repositories (a
  picker fed by your own grant; a branch, optional) into the sandbox.
  The clone runs on the worker in the background and the card polls
  until it reads _Ready_. Each workspace has **Open in chat**, which
  starts a chat whose first message names the workspace, and Delete. At
  most three per person; a week's lifetime, extended on use.
- **Workspace environment** — the variables your workspace commands run
  with (`NPM_TOKEN`, a test database URL, an API key a project needs). A
  value is sealed on the worker and never shown again, to you or to the
  model.

In a chat, the model has the `sandbox_workspace_*` tools (below) and a
brief in its system prompt on how to work in one; Jira, Confluence and
the rest of the person's connectors are there beside them as always, so
"fix PROJ-123 in the billing service and open a PR" is one conversation.
The same tools are available to an agent run, in the owner's workspaces.

## The tools

| Tool                           | Kind | What it does                                                                                              |
| ------------------------------ | ---- | --------------------------------------------------------------------------------------------------------- |
| `sandbox_workspace_list`       | Read | Your workspaces: id, repository, branch, state, size, expiry.                                             |
| `sandbox_workspace_clone`      | Act  | Clone `workspace/repo` (a branch, a depth) with your Bitbucket grant; answers at once, the clone runs on. |
| `sandbox_workspace_delete`     | Act  | Remove a workspace and its checkout.                                                                      |
| `sandbox_workspace_ls`         | Read | One directory's entries.                                                                                  |
| `sandbox_workspace_find`       | Read | Paths matching a glob (`.gitignore` honoured).                                                            |
| `sandbox_workspace_grep`       | Read | Regex search of contents, as `path:line: text`.                                                           |
| `sandbox_workspace_read_file`  | Read | A file's text with line numbers, in line ranges.                                                          |
| `sandbox_workspace_write_file` | Act  | Create or replace a file.                                                                                 |
| `sandbox_workspace_edit_file`  | Act  | Replace one exact snippet (must be unique, or `replaceAll`).                                              |
| `sandbox_workspace_run`        | Act  | A bash command in the checkout, as you, with your environment; exit code and both streams.                |
| `sandbox_workspace_git_status` | Read | Branch, changed files, a diff summary or the full diff, recent log.                                       |
| `sandbox_workspace_git_commit` | Act  | Stage (all or listed paths) and commit as you, optionally on a new branch.                                |
| `sandbox_workspace_git_push`   | Act  | Push the current branch to origin with your grant; never force.                                           |
| `sandbox_workspace_git_pull`   | Act  | Fast-forward from origin, or fetch and switch to another remote branch.                                   |
| `sandbox_workspace_list_env`   | Read | The names of your environment variables — never a value.                                                  |

The clone, pull and push verbs exist only for a caller who holds a
Bitbucket grant the org has not switched off; the rest work on checkouts
that already exist. A pull request is `bitbucket_create_pull_request`, as
before.

## Why a shell, after "curated verbs, not a shell"

The sandbox design doc drew a hard line: every verb is one bounded thing
the worker does, never an arbitrary command. `sandbox_workspace_run`
crosses it on purpose, because a repository's own commands — its test
runner, its build, its package manager, its linter — are the whole point
of working in a checkout, and there is no curated verb for "whatever
this project's `Makefile` says". So the line moves from _what_ runs to
_who runs it and where_, and that is where the containment now lives.

## Containment

**Who.** The sandbox image's entrypoint (`docker/sandbox-entrypoint.sh`)
keeps the worker as root only when workspaces are enabled, and only so
that every command it starts for a caller can be dropped with `setpriv`
to **that caller's own unprivileged uid** — derived from their
`(tenantId, subject)` (`execUidFor`), stable across restarts, far above
any system account — with no supplementary groups, no capabilities, and
`no-new-privs` so a setuid binary cannot climb back. The worker itself
does nothing as root but spawn, chown and read.

**Where.** A second volume (`SANDBOX_WORKSPACES_DIR`, default
`/workspaces`, mode 0711) holds `<tenant>/<sha256(subject)>/` per caller
at 0700, owned by their uid, with their `home/` (caches, dotfiles) and one
directory per checkout, named by id, never by repository. The staged-file
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

## Secrets: the model sees names, never values

A project's commands need credentials — a registry token, a database
URL, an API key — and a credential in a tool result is a credential in
a transcript. So, as with browser secrets, values go around the model:

- **Supplied in the UI, never over MCP.** The Workspace environment card
  (`/api/tenant/[tenantId]/sandbox/env`) sets and removes variables with
  the person's own session. `sandbox_workspace_list_env` lists names.
- **Sealed by the worker, under its own key.** A value passes through
  the web app once, on the way in, and the worker seals it
  (`sandbox_env_secrets`, an `env1.` envelope over `@renkei/crypto`'s
  secretbox) under `SANDBOX_ENV_SECRETS_KEY` — a key the web app does
  not need to hold — falling back to `TOKEN_ENCRYPTION_KEY` for a
  one-key deployment. Nothing can read it back but the worker, at exec
  time, into that one process's environment.
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

A clone, pull or push spends the person's own Bitbucket grant: the web
app resolves the token (the same resolver the `bitbucket_*` tools use,
the same requested ∩ granted scope check — `repository` to clone or
pull, `repository:write` to push), turns it into git's Basic
`x-token-auth` header, and hands the worker that header in the request
body for one call. The worker puts it in that one git process's
environment as an `http.extraheader` config entry — never in argv (a
`ps` away), never in `.git/config` (at rest on the volume) — and it is
gone when the process exits. The stored remote URL carries no
credential, so `git fetch` typed into `sandbox_workspace_run` fails by
design; the git tools are the way to reach the remote.

Commits are authored as the person: their org email when the identity
knows it, else a no-reply address on their Bitbucket username.

## Lifetime and limits

| Bound                            | Value                            |
| -------------------------------- | -------------------------------- |
| Workspaces per person            | 3                                |
| Lifetime since last use          | 7 days (the worker's sweep)      |
| Checkout size                    | 2 GB                             |
| Default clone depth              | 100 commits (`depth: 0` for all) |
| Command timeout                  | 2 min default, 10 min max        |
| Command output to model          | 30k chars default, 100k max      |
| Processes per caller             | 512 (RLIMIT_NPROC)               |
| Largest file a command may write | 512 MB (RLIMIT_FSIZE)            |
| Environment variables            | 50 per person, 8 KB each         |

A workspace's row (`sandbox_workspaces`, migration 101) is the metadata
half; the sweep that retires expired staged files retires expired
checkouts the same way — bytes first, then the row. A clone that never
finished (a crash mid-clone) sits in `cloning` until its lifetime lapses.

## What it deliberately is not

Not a general container the model controls — no `docker`, no root, no
network isolation to promise beyond placement — and not a way past the
sandbox's other rules: staged files and the browser are unchanged, the
knowledge index never sees a checkout, and a workspace is working state
with a lifetime, not a source of truth. Bitbucket is the one provider;
the vocabulary (`provider` on the row and the clone verb) leaves room
for another.
