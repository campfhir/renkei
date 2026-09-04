/**
 * @renkei/connector-sandbox — the pure logic behind the agent scratch space:
 * filename hygiene, quota/TTL constants, the SSRF egress guard
 * `sandbox_download_url` and every browser navigation run their target
 * through, the browser snapshot vocabulary the sandbox_browser_* tools
 * read (browser.ts), a fetched page's text for `sandbox_fetch_page`
 * (page-text.ts), and how a browser secret is sealed and scoped
 * (secrets.ts).
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
  BROWSER_RUN_MAX_STEPS,
  BROWSER_WAIT_MAX_MS,
  BROWSER_RUN_WAIT_BUDGET_MS,
  BROWSER_WAIT_TEXT_MAX_CHARS,
  BROWSER_SCROLL_MAX_PX,
  BROWSER_SCROLL_DEFAULT_PX,
  BROWSER_SELECT_MAX_VALUES,
  BROWSER_KEY_PATTERN,
  BROWSER_KEY_MAX_LENGTH,
  BROWSER_STEP_KINDS,
  isBrowserRef,
  snapshotCharsOf,
  renderSnapshotNode,
  renderBrowserSnapshot,
  parseBrowserStep,
  parseBrowserSteps,
  type BrowserInteractiveRole,
  type BrowserContentRole,
  type BrowserSnapshotNode,
  type BrowserPageState,
  type BrowserStep,
  type BrowserStepKind,
  type BrowserStepRefusal,
  type BrowserRunResult,
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
  SECRET_NAME_PATTERN,
  SECRET_FIELD_PATTERN,
  SECRET_MAX_FIELDS,
  SECRET_VALUE_MAX_CHARS,
  SECRET_MAX_HOSTS,
  SECRET_MAX_PER_SUBJECT,
  SECRET_PASSPHRASE_MIN_CHARS,
  SECRET_PASSPHRASE_MAX_CHARS,
  SECRET_UNLOCK_DEFAULT_MS,
  SECRET_UNLOCK_MAX_MS,
  SECRET_TTL_DEFAULT_MS,
  SECRET_TTL_MAX_MS,
  SECRET_MASK,
  generatePassphrase,
  deriveSecretKey,
  sealSecretFields,
  sealedSalt,
  openSecretFields,
  openSecretFieldsWithKey,
  validateSecretName,
  validateSecretFields,
  validateSecretHosts,
  secretHostAllowed,
  validatePassphrase,
  parseSecretRef,
  unlockWindowMs,
  secretTtlMs,
  scrubSecretValues,
  type SandboxSecretSummary,
  type SecretRef,
} from './secrets';

export {
  PAGE_TEXT_DEFAULT_CHARS,
  PAGE_TEXT_MAX_CHARS,
  pageToText,
  pageTitle,
  decodeEntities,
  looksLikeHtml,
  type PageText,
  type PageTextOptions,
} from './page-text';

export {
  assertPublicHttpsUrl,
  assertSafeHttpsUrl,
  assertSafeHostname,
  isBlockedIP,
  BlockedUrlError,
} from './egress-guard';
