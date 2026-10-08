#!/bin/sh
# The sandbox worker's entrypoint: who the process runs as depends on what
# it is asked to do.
#
# Without code workspaces or scripts the worker holds staged bytes and a
# browser and needs no privilege at all, so it drops to the unprivileged
# `worker` account exactly as the image always has. With
# SANDBOX_WORKSPACES_ENABLED or SANDBOX_SCRIPTS_ENABLED it stays root —
# not to do anything as root, but so that every command a caller runs can
# be dropped to THAT caller's own uid (setpriv, see
# apps/worker-sandbox/src/workspaces.ts) and, for a script, started in a
# network namespace of its own (unshare, see src/scripts.ts): one
# caller's checkout, home and processes are theirs alone, and the
# worker's own environment (its database URL, its bearer keys) is root's,
# which no caller's uid can read. A worker started as root without either
# flag would be root for no reason; one started as `worker` with a flag
# would run every caller's commands as one shared user — the process logs
# that plainly, but this script is what makes the right arrangement the
# default.
set -eu

is_on() {
  case "$1" in
    1|true|TRUE|True|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

if is_on "${SANDBOX_WORKSPACES_ENABLED:-}" || is_on "${SANDBOX_SCRIPTS_ENABLED:-}"; then
  exec "$@"
else
  exec setpriv --reuid=worker --regid=nodejs --init-groups "$@"
fi
