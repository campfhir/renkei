#!/bin/sh
# The sandbox worker's entrypoint: who the process runs as depends on what
# it is asked to do.
#
# Without code workspaces the worker holds staged bytes and a browser and
# needs no privilege at all, so it drops to the unprivileged `worker`
# account exactly as the image always has. With SANDBOX_WORKSPACES_ENABLED
# it stays root — not to do anything as root, but so that every command a
# caller runs can be dropped to THAT caller's own uid (setpriv, see
# apps/worker-sandbox/src/workspaces.ts): one caller's checkout, home and
# processes are theirs alone, and the worker's own environment (its
# database URL, its bearer keys) is root's, which no caller's uid can
# read. A worker started as root without the flag would be root for no
# reason; one started as `worker` with the flag would run every caller's
# commands as one shared user — the process logs that plainly, but this
# script is what makes the right arrangement the default.
set -eu

case "${SANDBOX_WORKSPACES_ENABLED:-}" in
  1|true|TRUE|True|yes|YES|on|ON)
    exec "$@"
    ;;
  *)
    exec setpriv --reuid=worker --regid=nodejs --init-groups "$@"
    ;;
esac
