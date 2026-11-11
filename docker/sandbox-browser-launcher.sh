#!/bin/sh
# Starts the sandbox's headless Chromium as an unprivileged uid.
#
# The worker stays root (docker/sandbox-entrypoint.sh) so it can drop each
# caller's commands to their own uid, which would leave the browser — the
# one process that parses arbitrary pages — running as root too. Playwright
# runs this script in place of the browser (`executablePath`, see
# apps/worker-sandbox/src/browser.ts) and it execs the real binary
# (SANDBOX_BROWSER_BINARY) as a uid that owns nothing: no supplementary
# groups, no capabilities, no-new-privs, so a renderer bug lands in an
# unprivileged process, not in the container's root.
#
# Playwright creates the profile directory as root before the launch; the
# browser needs to write to it, so it is handed over here.
set -eu

uid="${SANDBOX_BROWSER_UID:-1002}"

# The browser to start: the one the worker pinned (SANDBOX_BROWSER_EXECUTABLE),
# else the headless shell the image installs under PLAYWRIGHT_BROWSERS_PATH
# (Playwright's own resolution for a headless launch, repeated here because
# executablePath replaces it).
binary="${SANDBOX_BROWSER_BINARY:-}"
if [ -z "$binary" ]; then
  for candidate in "${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"/chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell; do
    if [ -x "$candidate" ]; then binary="$candidate"; fi
  done
fi
if [ -z "$binary" ]; then
  echo "sandbox-browser-launcher: no browser under ${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}" >&2
  exit 127
fi

profile=""
for arg in "$@"; do
  case "$arg" in
    --user-data-dir=*) profile="${arg#--user-data-dir=}" ;;
  esac
done

if [ -n "$profile" ] && [ -d "$profile" ]; then
  chown -R "$uid:$uid" "$profile"
  export HOME="$profile"
else
  export HOME=/tmp
fi
# The worker's own variables stay with the worker: the browser gets a
# minimal environment of its own.
exec env -i HOME="$HOME" PATH="$PATH" LANG="${LANG:-C.UTF-8}" \
  ${PLAYWRIGHT_BROWSERS_PATH:+PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH"} \
  setpriv --reuid="$uid" --regid="$uid" --clear-groups --bounding-set=-all --no-new-privs \
  "$binary" "$@"
