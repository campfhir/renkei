#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$SCRIPT_DIR/.docker-build-config"

# ── Load saved config ────────────────────────────────────────────────────────
if [[ -f "$CONFIG_FILE" ]]; then
  source "$CONFIG_FILE"
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

prompt_choice() {
  local var="$1" prompt_text="$2" default="${3:-}"
  local current="${!var:-$default}"
  echo "$prompt_text"
  echo "  1) dev"
  echo "  2) staging"
  echo "  3) prod"
  read -rp "Choice${current:+ [$current]}: " input
  case "${input:-$current}" in
    1|dev)     eval "$var=dev" ;;
    2|staging) eval "$var=staging" ;;
    3|prod)    eval "$var=prod" ;;
    *)
      echo "Error: invalid choice." >&2
      exit 1
      ;;
  esac
}

prompt_platform() {
  local var="$1" default="${2:-}"
  local current="${!var:-$default}"
  echo "Platform:"
  echo "  1) linux/amd64"
  echo "  2) linux/arm64"
  echo "  3) linux/amd64,linux/arm64"
  echo "  4) (native)"
  read -rp "Choice${current:+ [$current]}: " input
  case "${input:-$current}" in
    1|linux/amd64)              eval "$var=linux/amd64" ;;
    2|linux/arm64)              eval "$var=linux/arm64" ;;
    3|linux/amd64,linux/arm64) eval "$var=linux/amd64,linux/arm64" ;;
    4|native|"")               eval "$var=" ;;
    *)
      echo "Error: invalid choice." >&2
      exit 1
      ;;
  esac
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
echo "🐳  Atlas — Docker Build"
echo "────────────────────────"

PKG_NAME="$(node -p "require('$ROOT_DIR/apps/web/package.json').name")"
PKG_VERSION="$(node -p "require('$ROOT_DIR/apps/web/package.json').version")"

prompt_choice BUILD_ENV "Environment:" "${BUILD_ENV:-dev}"
prompt_platform BUILD_PLATFORM "${BUILD_PLATFORM:-}"
prompt_registry_type REGISTRY_TYPE "${REGISTRY_TYPE:-none}"
configure_registry_prefix
prompt_yes_no BUILD_MIGRATE "Also build the migration image (docker/Dockerfile's 'migrate' target)?" "${BUILD_MIGRATE:-n}"
prompt_yes_no BUILD_WORKER "Also build the worker image (docker/Dockerfile's 'worker' target)?" "${BUILD_WORKER:-n}"

IMAGE_NAME="${ARG_NAME:-$PKG_NAME}"
VERSION="${ARG_VERSION:-$PKG_VERSION}"

echo "Image: $IMAGE_NAME:$VERSION"

LOCAL_SEMVER_TAG="${IMAGE_NAME}:${VERSION}"
LOCAL_LATEST_TAG="${IMAGE_NAME}:latest"
REMOTE_SEMVER_TAG=""
REMOTE_LATEST_TAG=""
if [[ -n "$REGISTRY_PREFIX" ]]; then
  REMOTE_SEMVER_TAG="${REGISTRY_PREFIX}/${IMAGE_NAME}:${VERSION}"
  REMOTE_LATEST_TAG="${REGISTRY_PREFIX}/${IMAGE_NAME}:latest"
fi

# A multi-platform manifest has no single-arch representation the local image
# store can hold, so it can only leave the build by being pushed straight to
# a registry — there is no local image for docker-push.sh to find afterward.
MULTI_PLATFORM=false
if [[ "$BUILD_PLATFORM" == *,* ]]; then
  MULTI_PLATFORM=true
  if [[ -z "$REGISTRY_PREFIX" ]]; then
    echo "Error: a multi-platform build produces no local image — it can only be exported" >&2
    echo "by pushing straight to a registry. Choose a registry, not 'none'." >&2
    exit 1
  fi
fi

if $MULTI_PLATFORM; then
  TAG_ARGS=(--tag "$REMOTE_SEMVER_TAG" --tag "$REMOTE_LATEST_TAG")
else
  TAG_ARGS=(--tag "$LOCAL_SEMVER_TAG" --tag "$LOCAL_LATEST_TAG")
  if [[ -n "$REGISTRY_PREFIX" ]]; then
    TAG_ARGS+=(--tag "$REMOTE_SEMVER_TAG" --tag "$REMOTE_LATEST_TAG")
  fi
fi

# The migrate target carries the migration runner, which the runtime image
# deliberately does not — see docker/Dockerfile. Its own image repository
# (renkei-migrate), versioned in step with the app.
LOCAL_MIGRATE_SEMVER_TAG="${IMAGE_NAME}-migrate:${VERSION}"
LOCAL_MIGRATE_LATEST_TAG="${IMAGE_NAME}-migrate:latest"
REMOTE_MIGRATE_SEMVER_TAG=""
REMOTE_MIGRATE_LATEST_TAG=""
if [[ -n "$REGISTRY_PREFIX" ]]; then
  REMOTE_MIGRATE_SEMVER_TAG="${REGISTRY_PREFIX}/${IMAGE_NAME}-migrate:${VERSION}"
  REMOTE_MIGRATE_LATEST_TAG="${REGISTRY_PREFIX}/${IMAGE_NAME}-migrate:latest"
fi

if $MULTI_PLATFORM; then
  MIGRATE_TAG_ARGS=(--tag "$REMOTE_MIGRATE_SEMVER_TAG" --tag "$REMOTE_MIGRATE_LATEST_TAG")
else
  MIGRATE_TAG_ARGS=(--tag "$LOCAL_MIGRATE_SEMVER_TAG" --tag "$LOCAL_MIGRATE_LATEST_TAG")
  if [[ -n "$REGISTRY_PREFIX" ]]; then
    MIGRATE_TAG_ARGS+=(--tag "$REMOTE_MIGRATE_SEMVER_TAG" --tag "$REMOTE_MIGRATE_LATEST_TAG")
  fi
fi

# The worker image is the long-running queue consumer — its own repository
# (renkei-worker), versioned in step with the app.
LOCAL_WORKER_SEMVER_TAG="${IMAGE_NAME}-worker:${VERSION}"
LOCAL_WORKER_LATEST_TAG="${IMAGE_NAME}-worker:latest"
REMOTE_WORKER_SEMVER_TAG=""
REMOTE_WORKER_LATEST_TAG=""
if [[ -n "$REGISTRY_PREFIX" ]]; then
  REMOTE_WORKER_SEMVER_TAG="${REGISTRY_PREFIX}/${IMAGE_NAME}-worker:${VERSION}"
  REMOTE_WORKER_LATEST_TAG="${REGISTRY_PREFIX}/${IMAGE_NAME}-worker:latest"
fi

if $MULTI_PLATFORM; then
  WORKER_TAG_ARGS=(--tag "$REMOTE_WORKER_SEMVER_TAG" --tag "$REMOTE_WORKER_LATEST_TAG")
else
  WORKER_TAG_ARGS=(--tag "$LOCAL_WORKER_SEMVER_TAG" --tag "$LOCAL_WORKER_LATEST_TAG")
  if [[ -n "$REGISTRY_PREFIX" ]]; then
    WORKER_TAG_ARGS+=(--tag "$REMOTE_WORKER_SEMVER_TAG" --tag "$REMOTE_WORKER_LATEST_TAG")
  fi
fi

# ── Save config ──────────────────────────────────────────────────────────────
{
  echo "BUILD_ENV=$BUILD_ENV"
  echo "BUILD_PLATFORM=$BUILD_PLATFORM"
  echo "BUILD_MIGRATE=$BUILD_MIGRATE"
  echo "BUILD_WORKER=$BUILD_WORKER"
  registry_config_lines
} > "$CONFIG_FILE"
echo ""
echo "✅  Config saved to $CONFIG_FILE"

# ── Build ────────────────────────────────────────────────────────────────────
build_target() {
  local target="$1"; shift
  local tag_args=("$@")

  if [[ -n "$BUILD_PLATFORM" ]]; then
    if $MULTI_PLATFORM; then
      docker buildx build \
        -f "$ROOT_DIR/docker/Dockerfile" \
        --target "$target" \
        --platform "$BUILD_PLATFORM" \
        --build-arg BUILD_ENV="$BUILD_ENV" \
        "${tag_args[@]}" \
        --push \
        "$ROOT_DIR"
    else
      docker buildx build \
        -f "$ROOT_DIR/docker/Dockerfile" \
        --target "$target" \
        --platform "$BUILD_PLATFORM" \
        --build-arg BUILD_ENV="$BUILD_ENV" \
        "${tag_args[@]}" \
        --load \
        "$ROOT_DIR"
    fi
  else
    docker build \
      -f "$ROOT_DIR/docker/Dockerfile" \
      --target "$target" \
      --build-arg BUILD_ENV="$BUILD_ENV" \
      "${tag_args[@]}" \
      "$ROOT_DIR"
  fi
}

PLATFORM_LABEL="${BUILD_PLATFORM:-native}"
REGISTRY_LABEL="${REGISTRY_PREFIX:-none}"
echo ""
echo "Building: ${TAG_ARGS[*]} (env=$BUILD_ENV, platform=$PLATFORM_LABEL, registry=$REGISTRY_LABEL)"
echo "──────────────────────────────────────────────────────────────────────────────"
build_target runtime "${TAG_ARGS[@]}"

echo ""
if $MULTI_PLATFORM; then
  echo "✅  Built and pushed: $REMOTE_SEMVER_TAG"
  echo "✅  Pushed: $REMOTE_LATEST_TAG"
  echo ""
  echo "Multi-platform images are pushed directly during build — there is no local"
  echo "image for scripts/docker-push.sh to push; this one is already at the registry."
else
  echo "✅  Built: $LOCAL_SEMVER_TAG"
  echo "✅  Tagged: $LOCAL_LATEST_TAG"
  if [[ -n "$REGISTRY_PREFIX" ]]; then
    echo "✅  Also tagged: $REMOTE_SEMVER_TAG"
    echo "✅  Also tagged: $REMOTE_LATEST_TAG"
    echo ""
    echo "Run scripts/docker-push.sh to push $REMOTE_SEMVER_TAG"
  fi
fi

if [[ "$BUILD_MIGRATE" == y ]]; then
  echo ""
  echo "Building: ${MIGRATE_TAG_ARGS[*]} (env=$BUILD_ENV, platform=$PLATFORM_LABEL, registry=$REGISTRY_LABEL)"
  echo "──────────────────────────────────────────────────────────────────────────────"
  build_target migrate "${MIGRATE_TAG_ARGS[@]}"

  echo ""
  if $MULTI_PLATFORM; then
    echo "✅  Built and pushed: $REMOTE_MIGRATE_SEMVER_TAG"
    echo "✅  Pushed: $REMOTE_MIGRATE_LATEST_TAG"
  else
    echo "✅  Built: $LOCAL_MIGRATE_SEMVER_TAG"
    echo "✅  Tagged: $LOCAL_MIGRATE_LATEST_TAG"
    if [[ -n "$REGISTRY_PREFIX" ]]; then
      echo "✅  Also tagged: $REMOTE_MIGRATE_SEMVER_TAG"
      echo "✅  Also tagged: $REMOTE_MIGRATE_LATEST_TAG"
      echo ""
      echo "Run scripts/docker-push.sh to push $REMOTE_MIGRATE_SEMVER_TAG"
    fi
  fi
fi

if [[ "$BUILD_WORKER" == y ]]; then
  echo ""
  echo "Building: ${WORKER_TAG_ARGS[*]} (env=$BUILD_ENV, platform=$PLATFORM_LABEL, registry=$REGISTRY_LABEL)"
  echo "──────────────────────────────────────────────────────────────────────────────"
  build_target worker "${WORKER_TAG_ARGS[@]}"

  echo ""
  if $MULTI_PLATFORM; then
    echo "✅  Built and pushed: $REMOTE_WORKER_SEMVER_TAG"
    echo "✅  Pushed: $REMOTE_WORKER_LATEST_TAG"
  else
    echo "✅  Built: $LOCAL_WORKER_SEMVER_TAG"
    echo "✅  Tagged: $LOCAL_WORKER_LATEST_TAG"
    if [[ -n "$REGISTRY_PREFIX" ]]; then
      echo "✅  Also tagged: $REMOTE_WORKER_SEMVER_TAG"
      echo "✅  Also tagged: $REMOTE_WORKER_LATEST_TAG"
      echo ""
      echo "Run scripts/docker-push.sh to push $REMOTE_WORKER_SEMVER_TAG"
    fi
  fi
fi
