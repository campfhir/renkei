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
