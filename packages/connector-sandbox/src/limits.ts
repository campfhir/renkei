/**
 * Bounds on the sandbox scratch space. This is the first place Renkei
 * deliberately holds file bytes at rest outside a provider or a browser
 * (see docs/sandbox-connector-design.md), so the bounds here are tighter
 * and more mechanical than the other connectors': a short, fixed TTL and a
 * hard per-caller quota, enforced by the worker's own sweep rather than
 * left to callers to clean up after themselves.
 */

/** How long a staged file survives before the worker's sweep deletes it. */
export const DEFAULT_FILE_TTL_MS = 24 * 60 * 60_000; // 24h

/** Fallback per-file cap when the org has not configured maxAttachmentBytes. */
export const DEFAULT_MAX_FILE_BYTES = 20_971_520; // 20MB

/** Total bytes one (tenantId, subject) may have staged at once. */
export const DEFAULT_SUBJECT_QUOTA_BYTES = 200 * 1_048_576; // 200MB

/** Files staged at once per (tenantId, subject) — a sanity ceiling, not a workflow limit. */
export const MAX_FILES_PER_SUBJECT = 200;

/**
 * A separate, much larger pool for batch-tagged files (packages/db/src/migrations/075-*):
 * a document-ocr-pipeline batch staging thousands of pages must not be
 * measured against — or crowd out — the same person's ordinary interactive
 * scratch space, and a multi-thousand-file job legitimately runs for days,
 * not hours.
 */
export const DEFAULT_BATCH_FILE_TTL_MS = 7 * 24 * 60 * 60_000; // 7 days
export const DEFAULT_BATCH_MAX_FILE_BYTES = 104_857_600; // 100MB — scanned TIFFs run large
export const DEFAULT_BATCH_QUOTA_BYTES = 50 * 1_073_741_824; // 50GB
export const MAX_FILES_PER_BATCH = 50_000;
