#!/usr/bin/env bash
# Smoke-start a built Renkei image: the thing the vulnerability scan cannot
# tell you.
#
# An image that cannot boot — a module next.config.ts imports that the
# runtime stage forgot to copy, a worker whose entry file moved — passes
# every static check and fails in production, on the first pull. This
# script starts one image the way compose would, against a throwaway
# Postgres already at this build's schema, and waits for the image's own
# sign of life: the health endpoint the web app and each HTTP worker
# expose for their container healthcheck, the "started" log line for the
# queue worker, a clean exit for the migrate image (which is run against
# the database, so the migrations themselves are the test).
#
#   scripts/smoke-image.sh <target> <image>
#
# <target> is the Dockerfile stage: runtime, migrate, worker, fileshares,
# onbase, mirth, admanager, delegate or sandbox. The database is
# SMOKE_DATABASE_URL (default postgres://renkei:renkei@127.0.0.1:5432/renkei),
# reached over the host network, which is also where the image binds its
# port — one image at a time. For every target but migrate the database
# must already be migrated (CI does that with `pnpm --filter @renkei/db
# migrate`). Every other variable an image needs — the encryption keys,
# the other workers' keys and URLs — is invented here: this is a boot,
# not a deployment, and nothing the image would talk to exists.
#
# CI runs it from the docker job (.github/workflows/ci.yml) against the
# job's Postgres service, after the build and before the scan. Locally,
# with a migrated Postgres on 5432:
#   docker build -f docker/Dockerfile --target runtime -t renkei:local .
#   scripts/smoke-image.sh runtime renkei:local
set -euo pipefail

usage='usage: smoke-image.sh <target> <image>'
target="${1:?$usage}"
image="${2:?$usage}"
database_url="${SMOKE_DATABASE_URL:-postgres://renkei:renkei@127.0.0.1:5432/renkei}"
timeout_s="${SMOKE_TIMEOUT_SECONDS:-120}"
container="renkei-smoke-${target}"

log() { printf '[smoke %s] %s\n' "$target" "$*"; }
fail() {
  log "FAILED: $*"
  echo "--- container log (last 200 lines) ---"
  docker logs "$container" 2>&1 | tail -n 200 || true
  exit 1
}
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# The migrate image has no port and no long life: running it to a clean
# exit against the database is its whole test.
if [[ "$target" == migrate ]]; then
  log "running $image against $database_url"
  docker run --rm --name "$container" --network host -e DATABASE_URL="$database_url" "$image"
  log "ok: the migrate image ran to completion"
  exit 0
fi

case "$target" in
  runtime) ready_url=http://127.0.0.1:3000/api/health ;;
  fileshares) ready_url=http://127.0.0.1:8090/health ;;
  onbase) ready_url=http://127.0.0.1:8091/health ;;
  sandbox) ready_url=http://127.0.0.1:8092/health ;;
  mirth) ready_url=http://127.0.0.1:8093/health ;;
  admanager) ready_url=http://127.0.0.1:8095/health ;;
  delegate) ready_url=http://127.0.0.1:8096/health ;;
  # The queue consumer listens on nothing; its boot line is the sign.
  worker) ready_url= ;;
  *)
    echo "smoke-image.sh: unknown target '$target'" >&2
    exit 2
    ;;
esac

key() { openssl rand -base64 32; }
env_args=(
  -e DATABASE_URL="$database_url"
  -e TOKEN_ENCRYPTION_KEY="$(key)"
  -e LOG_ENCRYPTION_KEY="$(key)"
  # The delegate's and the connector workers' bearer keys: one each, none
  # of them the development default every image refuses under
  # NODE_ENV=production.
  -e DELEGATE_WORKER_URL=http://127.0.0.1:8096
  -e DELEGATE_WORKER_API_KEY="$(key)"
  -e FILESHARES_WORKER_API_KEY="$(key)"
  -e ONBASE_WORKER_API_KEY="$(key)"
  -e MIRTH_WORKER_API_KEY="$(key)"
  -e ADMANAGER_WORKER_API_KEY="$(key)"
  -e SANDBOX_WORKER_API_KEY="$(key)"
  -e SANDBOX_WORKER_URL=http://127.0.0.1:8092
  -e PUBLIC_BASE_URL=http://127.0.0.1:3000
)

log "starting $image"
docker run -d --name "$container" --network host "${env_args[@]}" "$image" >/dev/null

started=$(date +%s)
while :; do
  running="$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || echo false)"
  if [[ "$running" != true ]]; then
    code="$(docker inspect -f '{{.State.ExitCode}}' "$container" 2>/dev/null || echo '?')"
    fail "the container exited (status $code) before it was ready"
  fi
  elapsed=$(( $(date +%s) - started ))
  if [[ -n "$ready_url" ]]; then
    # -f: a 503 (the web app's "schema behind this build") is not ready.
    if curl -fsS --max-time 5 "$ready_url" >/dev/null 2>&1; then
      log "ok: $ready_url answered after ${elapsed}s"
      exit 0
    fi
  elif docker logs "$container" 2>&1 | grep -q 'started @renkei/worker'; then
    log "ok: the worker reported itself started after ${elapsed}s"
    exit 0
  fi
  if (( elapsed >= timeout_s )); then
    fail "no sign of life within ${timeout_s}s"
  fi
  sleep 2
done
