#!/bin/sh
# The sandbox worker's entrypoint: the process stays root.
#
# Not to do anything as root, but so that every command a caller runs in
# a code workspace, and every script over their staged files, can be
# dropped to THAT caller's own uid (setpriv, see
# apps/worker-sandbox/src/workspaces.ts) and, for a script, started in a
# network namespace of its own (unshare, see src/scripts.ts): one caller's
# checkout, home and processes are theirs alone, and the worker's own
# environment (its database URL, its bearer keys) is root's, which no
# caller's uid can read. Workspaces and scripts are always served by the
# worker — whether an organization may use them is its own switch in the
# web app's settings, not a flag here — so there is no arrangement under
# which this process could drop to the unprivileged `worker` account and
# still isolate callers from each other. A worker started as `worker`
# (a developer running it by hand) still works, with every caller's
# commands as that one user; the process logs that plainly.
set -eu

exec "$@"
