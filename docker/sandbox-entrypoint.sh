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
#
# In a sandbox the orchestrator made for one scope (SANDBOX_ORCHESTRATED=1,
# docs/sandbox-orchestrator-design.md) code project services — a Postgres
# or a Redis beside a checkout — run INSIDE the sandbox, on a container
# engine of its own: Podman, whose socket speaks the Docker API the worker
# already uses (src/docker.ts). It is started here, as root, and the
# worker is pointed at it; its socket is root's, so a caller's command
# (dropped to its own uid) cannot open it, exactly as with the host's
# socket before. Nothing outside the sandbox is involved: no host engine,
# no socket proxy. If the engine does not come up (a local Docker
# container without SANDBOX_DOCKER_NESTED_ENGINE on the orchestrator),
# the worker starts all the same and reports services as a capability it
# lacks.
set -eu

if [ "${SANDBOX_ORCHESTRATED:-}" = "1" ] && [ -z "${SANDBOX_DOCKER_HOST:-}" ] \
  && command -v podman >/dev/null 2>&1; then
  socket=/run/podman/podman.sock
  mkdir -p /run/podman
  rm -f "$socket"
  podman system service --time=0 "unix://$socket" >/var/log/podman-service.log 2>&1 &
  # Up to ten seconds for the socket: the worker asks the engine once, at boot.
  waited=0
  while [ ! -S "$socket" ] && [ "$waited" -lt 50 ]; do
    sleep 0.2
    waited=$((waited + 1))
  done
  chmod 600 "$socket" 2>/dev/null || true
  export SANDBOX_DOCKER_HOST="unix://$socket"
fi

case "${SANDBOX_RUN_AS_WORKER:-}" in
  1|true|TRUE|True|yes|YES|on|ON) exec setpriv --reuid=worker --regid=nodejs --init-groups "$@" ;;
  *) exec "$@" ;;
esac
