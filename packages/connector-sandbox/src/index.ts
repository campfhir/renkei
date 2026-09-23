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

export {
  WORKSPACE_MAX_PER_SUBJECT,
  WORKSPACE_TTL_MS,
  WORKSPACE_MAX_BYTES,
  WORKSPACE_PROVIDERS,
  CLONE_DEFAULT_DEPTH,
  CLONE_TIMEOUT_MS,
  EXEC_DEFAULT_TIMEOUT_MS,
  EXEC_MAX_TIMEOUT_MS,
  EXEC_COMMAND_MAX_CHARS,
  EXEC_OUTPUT_DEFAULT_CHARS,
  EXEC_OUTPUT_MAX_CHARS,
  EXEC_MAX_PROCESSES,
  EXEC_MAX_FILE_BYTES,
  EXEC_UID_BASE,
  EXEC_UID_SPAN,
  READ_DEFAULT_CHARS,
  READ_MAX_CHARS,
  READ_MAX_BYTES,
  WRITE_MAX_CHARS,
  UPLOAD_MAX_BYTES,
  FIND_MAX_RESULTS,
  GREP_MAX_MATCHES,
  GREP_MAX_LINE_CHARS,
  GREP_PATTERN_MAX_CHARS,
  GIT_OUTPUT_MAX_CHARS,
  DIFF_MAX_CHARS,
  DIFF_DEFAULT_CONTEXT,
  DIFF_MAX_CONTEXT,
  DIFF_MAX_UNTRACKED,
  COMMIT_MESSAGE_MAX_CHARS,
  ENV_NAME_PATTERN,
  ENV_VALUE_MAX_CHARS,
  ENV_MAX_PER_SUBJECT,
  validateEnvName,
  validateEnvValue,
  isWorkspaceProvider,
  validateRepoFullName,
  validateGitRef,
  validateWorkspacePath,
  validateCommand,
  validateGlob,
  validateGrepPattern,
  execTimeoutMs,
  outputCharsOf,
  clipOutput,
  execUidFor,
  subjectSegmentOf,
  looksBinary,
  type WorkspaceStatus,
  type WorkspaceProvider,
  type SandboxWorkspaceSummary,
} from './workspaces';

export { parseDotenv, type ParsedDotenv } from './dotenv';

export {
  SERVICE_MAX_PER_SUBJECT,
  SERVICE_TTL_MS,
  SERVICE_START_TIMEOUT_MS,
  SERVICE_NAME_PATTERN,
  SERVICE_ENV_MAX,
  SERVICE_ENV_VALUE_MAX_CHARS,
  SERVICE_EXPORT_MAX,
  SERVICE_EXPORT_MAX_CHARS,
  SERVICE_LOGS_DEFAULT_CHARS,
  SERVICE_LOGS_MAX_CHARS,
  SERVICE_LOGS_DEFAULT_LINES,
  SERVICE_LOGS_MAX_LINES,
  IMAGE_RULE_MAX_PER_TENANT,
  IMAGE_RULE_NOTE_MAX_CHARS,
  IMAGE_RULE_USERNAME_MAX_CHARS,
  IMAGE_RULE_SECRET_MAX_CHARS,
  IMAGE_REFERENCE_MAX_CHARS,
  DEFAULT_IMAGE_RULES,
  parseImageReference,
  normalizeImageRule,
  imageRuleMatches,
  matchImageRule,
  imageRuleHost,
  validateServiceName,
  validateServiceEnv,
  validateServiceExports,
  serviceEnvPrefix,
  renderServiceExport,
  serviceEnvironment,
  serviceLogLines,
  type ServiceStatus,
  type SandboxServiceSummary,
  type ImageRuleSummary,
  type ImageReference,
  type ImageRule,
} from './services';
