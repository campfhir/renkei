#!/bin/sh
# The sandbox worker's entrypoint: the process stays root.
#
# Not to do anything as root. Whether an organization gets code workspaces
# or scripts is that organization's own setting, decided per request
# (apps/worker-sandbox/src/features.ts) rather than known when the
# container starts, so the worker must always be ABLE to run a caller's
# command the right way: dropped to THAT caller's own uid (setpriv, see
# src/workspaces.ts) and, for a script, started in a network namespace of
# its own (unshare, see src/scripts.ts). One caller's checkout, home and
# processes are theirs alone, and the worker's own environment (its
# database URL, its bearer keys) is root's, which no caller's uid can
# read. The container holds only the capabilities that drop needs
# (docker-compose.yaml drops every other one), and a root that cannot drop
# a command runs nobody's: the worker verifies setpriv at boot and reports
# workspaces and scripts as capabilities it lacks rather than run every
# caller's commands as root.
#
# A deployment that wants the worker unprivileged anyway — no organization
# will ever turn workspaces or scripts on — sets SANDBOX_RUN_AS_WORKER=true
# and gets the unprivileged `worker` account the image always had; the
# worker then serves workspace and script verbs unisolated by uid and says
# so in its log.
set -eu

case "${SANDBOX_RUN_AS_WORKER:-}" in
  1|true|TRUE|True|yes|YES|on|ON) exec setpriv --reuid=worker --regid=nodejs --init-groups "$@" ;;
  *) exec "$@" ;;
esac
