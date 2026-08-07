#!/usr/bin/env bash
# Shared registry selection, tag-prefix, and login logic for docker-build.sh
# and docker-push.sh. Sourced, not executed — the caller must already define
# the `prompt` helper before sourcing this file.

prompt_registry_type() {
  local var="$1" default="${2:-}"
  local current="${!var:-$default}"
  echo "Registry:"
  echo "  1) none (local only)"
  echo "  2) Docker Hub"
  echo "  3) GitHub Container Registry (ghcr.io)"
  echo "  4) Azure Container Registry"
  echo "  5) custom"
  read -rp "Choice${current:+ [$current]}: " input
  case "${input:-$current}" in
    1|none)      eval "$var=none" ;;
    2|dockerhub) eval "$var=dockerhub" ;;
    3|ghcr)      eval "$var=ghcr" ;;
    4|acr)       eval "$var=acr" ;;
    5|custom)    eval "$var=custom" ;;
    *)
      echo "Error: invalid choice." >&2
      exit 1
      ;;
  esac
}

# Prompts for whatever identifier the chosen REGISTRY_TYPE needs and sets
# REGISTRY_PREFIX — the path segment every image tag is built under. Empty
# for "none". Must run after REGISTRY_TYPE is set.
configure_registry_prefix() {
  case "$REGISTRY_TYPE" in
    none)
      REGISTRY_PREFIX=""
      ;;
    dockerhub)
      prompt DOCKERHUB_NAMESPACE "Docker Hub namespace (user or org)" "${DOCKERHUB_NAMESPACE:-}"
      REGISTRY_PREFIX="$DOCKERHUB_NAMESPACE"
      ;;
    ghcr)
      prompt GHCR_NAMESPACE "GHCR namespace (user or org)" "${GHCR_NAMESPACE:-}"
      REGISTRY_PREFIX="ghcr.io/$GHCR_NAMESPACE"
      ;;
    acr)
      prompt ACR_NAME "ACR registry name (e.g. myregistry)" "${ACR_NAME:-}"
      REGISTRY_PREFIX="${ACR_NAME}.azurecr.io"
      ;;
    custom)
      prompt CUSTOM_REGISTRY_HOST "Registry host (e.g. registry.example.com:5000)" "${CUSTOM_REGISTRY_HOST:-}"
      local current="${CUSTOM_NAMESPACE:-}"
      read -rp "Namespace/path prefix, if any${current:+ [$current]}: " input
      CUSTOM_NAMESPACE="${input:-$current}"
      REGISTRY_PREFIX="${CUSTOM_REGISTRY_HOST}${CUSTOM_NAMESPACE:+/$CUSTOM_NAMESPACE}"
      ;;
    *)
      echo "Error: unknown REGISTRY_TYPE '$REGISTRY_TYPE'." >&2
      exit 1
      ;;
  esac
}

# Logs in to the configured registry. No-op for "none".
registry_login() {
  case "$REGISTRY_TYPE" in
    none)      ;;
    dockerhub) docker login ;;
    ghcr)      docker login ghcr.io ;;
    acr)       az acr login --name "$ACR_NAME" ;;
    custom)    docker login "$CUSTOM_REGISTRY_HOST" ;;
  esac
}

# Emits the config lines both scripts persist, so whichever one runs next
# picks up the other's last registry choice.
registry_config_lines() {
  cat <<EOF
REGISTRY_TYPE=$REGISTRY_TYPE
DOCKERHUB_NAMESPACE=${DOCKERHUB_NAMESPACE:-}
GHCR_NAMESPACE=${GHCR_NAMESPACE:-}
ACR_NAME=${ACR_NAME:-}
CUSTOM_REGISTRY_HOST=${CUSTOM_REGISTRY_HOST:-}
CUSTOM_NAMESPACE=${CUSTOM_NAMESPACE:-}
EOF
}
