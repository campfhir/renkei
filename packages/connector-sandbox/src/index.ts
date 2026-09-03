/**
 * @renkei/connector-sandbox — the pure logic behind the agent scratch space:
 * filename hygiene, quota/TTL constants, the SSRF egress guard
 * `sandbox_download_url` and every browser navigation run their target
 * through, and the browser snapshot vocabulary the sandbox_browser_* tools
 * read (browser.ts).
 *
 * Deliberately dependency- and I/O-free, the connector-onbase shape: the
 * worker that owns the scratch disk and the Postgres metadata is
 * apps/worker-sandbox; the web app reaches it through
 * apps/web/lib/sandbox/service-client.ts. Both sides share exactly this
 * code so a filename or a blocked URL is refused the same way everywhere.
 */

export type { SandboxFileSummary } from './types';

export {
  BROWSER_SESSION_IDLE_MS,
  BROWSER_MAX_SESSIONS,
  BROWSER_NAVIGATION_TIMEOUT_MS,
  BROWSER_ACTION_TIMEOUT_MS,
  BROWSER_SETTLE_TIMEOUT_MS,
  BROWSER_SNAPSHOT_DEFAULT_CHARS,
  BROWSER_SNAPSHOT_MAX_CHARS,
  BROWSER_SNAPSHOT_MAX_NODES,
  BROWSER_TYPE_MAX_CHARS,
  BROWSER_VIEWPORT,
  isBrowserRef,
  snapshotCharsOf,
  renderSnapshotNode,
  renderBrowserSnapshot,
  type BrowserInteractiveRole,
  type BrowserContentRole,
  type BrowserSnapshotNode,
  type BrowserPageState,
} from './browser';

export {
  DEFAULT_FILE_TTL_MS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_SUBJECT_QUOTA_BYTES,
  MAX_FILES_PER_SUBJECT,
  DEFAULT_BATCH_FILE_TTL_MS,
  DEFAULT_BATCH_MAX_FILE_BYTES,
  DEFAULT_BATCH_QUOTA_BYTES,
  MAX_FILES_PER_BATCH,
} from './limits';

export { validateFilename } from './naming';

export {
  assertPublicHttpsUrl,
  assertSafeHttpsUrl,
  assertSafeHostname,
  isBlockedIP,
  BlockedUrlError,
} from './egress-guard';
