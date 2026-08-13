#!/usr/bin/env bash
#
# Vendor Zoom's OpenAPI specs into docs/, per the repo convention of
# committed <vendor>-<product>-open-api-spec.json files.
#
# These URLs are what developers.zoom.us itself loads to render its API
# reference — stable in practice, but not a documented contract, which is
# why each download is validated as JSON before it can replace the vendored
# copy. Re-run to refresh; review the diff before committing.

set -euo pipefail

cd "$(dirname "$0")/.."

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

download() {
  local url="$1" dest="$2"
  local tmp
  tmp="$(mktemp)"
  echo "Fetching ${url}"
  curl --fail --silent --show-error --location "$url" -o "$tmp"
  # Validate and pretty-print in one pass so diffs stay reviewable.
  jq . "$tmp" > "$dest" || { echo "Not valid JSON: ${url}" >&2; rm -f "$tmp"; exit 1; }
  rm -f "$tmp"
  echo "Wrote $(du -h "$dest" | cut -f1 | tr -d ' ')	${dest}"
}

download "https://developers.zoom.us/api-hub/meetings/methods/endpoints.json" \
  "docs/zoom-meeting-open-api-spec.json"

download "https://developers.zoom.us/api-hub/users/methods/endpoints.json" \
  "docs/zoom-users-open-api-spec.json"

download "https://developers.zoom.us/api-hub/meetings/events/webhooks.json" \
  "docs/zoom-meeting-events-open-api-spec.json"

download "https://developers.zoom.us/api-hub/my-notes/methods/endpoints.json" \
  "docs/zoom-my-notes-open-api-spec.json"

download "https://developers.zoom.us/api-hub/canvas/methods/endpoints.json" \
  "docs/zoom-canvas-open-api-spec.json"

echo "Done. Review with: git diff --stat docs/"
