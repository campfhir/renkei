/**
 * @renkei/connector-sandbox — the pure logic behind the agent scratch space:
 * filename hygiene, quota/TTL constants, and the SSRF egress guard
 * `sandbox_download_url` runs its target through.
 *
 * Deliberately dependency- and I/O-free, the connector-onbase shape: the
 * worker that owns the scratch disk and the Postgres metadata is
 * apps/worker-sandbox; the web app reaches it through
 * apps/web/lib/sandbox/service-client.ts. Both sides share exactly this
 * code so a filename or a blocked URL is refused the same way everywhere.
 */

export type { SandboxFileSummary } from './types';

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
  isBlockedIP,
  BlockedUrlError,
} from './egress-guard';
