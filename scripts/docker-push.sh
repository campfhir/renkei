#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_CONFIG="$SCRIPT_DIR/.docker-build-config"
PUSH_CONFIG="$SCRIPT_DIR/.docker-push-config"

# ── Load saved configs ───────────────────────────────────────────────────────
if [[ -f "$BUILD_CONFIG" ]]; then
  source "$BUILD_CONFIG"
fi
if [[ -f "$PUSH_CONFIG" ]]; then
  source "$PUSH_CONFIG"
fi

# ── Prompt helpers ───────────────────────────────────────────────────────────
prompt() {
  local var="$1" prompt_text="$2" default="${3:-}"
  local current="${!var:-$default}"
  read -rp "$prompt_text${current:+ [$current]}: " input
  if [[ -n "$input" ]]; then
    eval "$var=\"$input\""
  elif [[ -n "$current" ]]; then
    eval "$var=\"$current\""
  else
    echo "Error: $var is required." >&2
    exit 1
  fi
}

prompt_yes_no() {
  local var="$1" prompt_text="$2" default="${3:-n}"
  local current="${!var:-$default}"
  read -rp "$prompt_text (y/n)${current:+ [$current]}: " input
  case "${input:-$current}" in
    y|Y|yes|Yes) eval "$var=y" ;;
    n|N|no|No)   eval "$var=n" ;;
    *)
      echo "Error: invalid choice." >&2
      exit 1
      ;;
  esac
}

source "$SCRIPT_DIR/docker-registry-lib.sh"

# ── Parse flags ──────────────────────────────────────────────────────────────
ARG_NAME=""
ARG_VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)    ARG_NAME="$2";    shift 2 ;;
    --version) ARG_VERSION="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ── Gather inputs ────────────────────────────────────────────────────────────
echo ""
echo "🚀  Atlas — Docker Push"
echo "────────────────────────"

PKG_NAME="$(node -p "require('$ROOT_DIR/apps/web/package.json').name")"
PKG_VERSION="$(node -p "require('$ROOT_DIR/apps/web/package.json').version")"

IMAGE_NAME="${ARG_NAME:-$PKG_NAME}"
VERSION="${ARG_VERSION:-$PKG_VERSION}"

echo "Image: $IMAGE_NAME:$VERSION"

# Defaults to whatever docker-build.sh last used, but can be repointed here
# without re-running a build.
prompt_registry_type REGISTRY_TYPE "${REGISTRY_TYPE:-none}"
configure_registry_prefix

if [[ -z "$REGISTRY_PREFIX" ]]; then
  echo "Error: choose a registry to push to — 'none' has nowhere to push." >&2
  exit 1
fi

# Defaults to whatever docker-build.sh last built, loaded from BUILD_CONFIG above.
prompt_yes_no PUSH_MIGRATE "Also push the migration image?" "${BUILD_MIGRATE:-n}"
prompt_yes_no PUSH_WORKER "Also push the worker image?" "${BUILD_WORKER:-n}"

LOCAL_SEMVER_TAG="${IMAGE_NAME}:${VERSION}"
LOCAL_LATEST_TAG="${IMAGE_NAME}:latest"
REMOTE_SEMVER_TAG="${REGISTRY_PREFIX}/${IMAGE_NAME}:${VERSION}"
REMOTE_LATEST_TAG="${REGISTRY_PREFIX}/${IMAGE_NAME}:latest"

LOCAL_MIGRATE_SEMVER_TAG="${IMAGE_NAME}-migrate:${VERSION}"
LOCAL_MIGRATE_LATEST_TAG="${IMAGE_NAME}-migrate:latest"
REMOTE_MIGRATE_SEMVER_TAG="${REGISTRY_PREFIX}/${IMAGE_NAME}-migrate:${VERSION}"
REMOTE_MIGRATE_LATEST_TAG="${REGISTRY_PREFIX}/${IMAGE_NAME}-migrate:latest"

LOCAL_WORKER_SEMVER_TAG="${IMAGE_NAME}-worker:${VERSION}"
LOCAL_WORKER_LATEST_TAG="${IMAGE_NAME}-worker:latest"
REMOTE_WORKER_SEMVER_TAG="${REGISTRY_PREFIX}/${IMAGE_NAME}-worker:${VERSION}"
REMOTE_WORKER_LATEST_TAG="${REGISTRY_PREFIX}/${IMAGE_NAME}-worker:latest"

# ── Save push config ─────────────────────────────────────────────────────────
registry_config_lines > "$PUSH_CONFIG"
echo ""
echo "✅  Config saved to $PUSH_CONFIG"

# ── Registry login ───────────────────────────────────────────────────────────
echo ""
echo "Logging in to ${REGISTRY_PREFIX}..."
registry_login

# ── Tag ──────────────────────────────────────────────────────────────────────
# docker-build.sh already tags the registry-qualified name directly when it
# knows the registry up front; this only re-tags when that didn't happen —
# e.g. the image was built with registry "none" and is being pushed now.
tag_if_needed() {
  local local_tag="$1" remote_tag="$2"
  if docker image inspect "$remote_tag" >/dev/null 2>&1; then
    return 0
  fi
  if ! docker image inspect "$local_tag" >/dev/null 2>&1; then
    echo "Error: neither $remote_tag nor $local_tag exists locally." >&2
    echo "Run scripts/docker-build.sh first. (A multi-platform build pushes" >&2
    echo "directly during build and leaves no local image for this script.)" >&2
    exit 1
  fi
  echo "Tagging:  $local_tag → $remote_tag"
  docker tag "$local_tag" "$remote_tag"
}

tag_if_needed "$LOCAL_SEMVER_TAG" "$REMOTE_SEMVER_TAG"
tag_if_needed "$LOCAL_LATEST_TAG" "$REMOTE_LATEST_TAG"

# ── Push ─────────────────────────────────────────────────────────────────────
echo ""
echo "Pushing:  $REMOTE_SEMVER_TAG"
echo "──────────────────────────────────────────────────────"
docker push "$REMOTE_SEMVER_TAG"

echo ""
echo "Pushing:  $REMOTE_LATEST_TAG"
echo "──────────────────────────────────────────────────────"
docker push "$REMOTE_LATEST_TAG"

echo ""
echo "✅  Pushed: $REMOTE_SEMVER_TAG"
echo "✅  Pushed: $REMOTE_LATEST_TAG"

if [[ "$PUSH_MIGRATE" == y ]]; then
  tag_if_needed "$LOCAL_MIGRATE_SEMVER_TAG" "$REMOTE_MIGRATE_SEMVER_TAG"
  tag_if_needed "$LOCAL_MIGRATE_LATEST_TAG" "$REMOTE_MIGRATE_LATEST_TAG"

  echo ""
  echo "Pushing:  $REMOTE_MIGRATE_SEMVER_TAG"
  echo "──────────────────────────────────────────────────────"
  docker push "$REMOTE_MIGRATE_SEMVER_TAG"

  echo ""
  echo "Pushing:  $REMOTE_MIGRATE_LATEST_TAG"
  echo "──────────────────────────────────────────────────────"
  docker push "$REMOTE_MIGRATE_LATEST_TAG"

  echo ""
  echo "✅  Pushed: $REMOTE_MIGRATE_SEMVER_TAG"
  echo "✅  Pushed: $REMOTE_MIGRATE_LATEST_TAG"
fi

if [[ "$PUSH_WORKER" == y ]]; then
  tag_if_needed "$LOCAL_WORKER_SEMVER_TAG" "$REMOTE_WORKER_SEMVER_TAG"
  tag_if_needed "$LOCAL_WORKER_LATEST_TAG" "$REMOTE_WORKER_LATEST_TAG"

  echo ""
  echo "Pushing:  $REMOTE_WORKER_SEMVER_TAG"
  echo "──────────────────────────────────────────────────────"
  docker push "$REMOTE_WORKER_SEMVER_TAG"

  echo ""
  echo "Pushing:  $REMOTE_WORKER_LATEST_TAG"
  echo "──────────────────────────────────────────────────────"
  docker push "$REMOTE_WORKER_LATEST_TAG"

  echo ""
  echo "✅  Pushed: $REMOTE_WORKER_SEMVER_TAG"
  echo "✅  Pushed: $REMOTE_WORKER_LATEST_TAG"
fi

echo ""
echo "Pull on your server with:"
echo "  docker pull $REMOTE_SEMVER_TAG"
if [[ "$PUSH_MIGRATE" == y ]]; then
  echo "  docker pull $REMOTE_MIGRATE_SEMVER_TAG"
  echo "  docker run --rm -e MIGRATION_DATABASE_URL=... $REMOTE_MIGRATE_SEMVER_TAG"
fi
if [[ "$PUSH_WORKER" == y ]]; then
  echo "  docker pull $REMOTE_WORKER_SEMVER_TAG"
fi
case "$REGISTRY_TYPE" in
  acr)    echo "  (ensure the server is also logged in via: az acr login --name $ACR_NAME)" ;;
  ghcr)   echo "  (ensure the server is also logged in via: docker login ghcr.io)" ;;
  custom) echo "  (ensure the server is also logged in via: docker login $CUSTOM_REGISTRY_HOST)" ;;
esac
