/**
 * Batch-job kind name constants — the one thing both sides need to agree
 * on byte-for-byte: apps/web's batch_start_document_pipeline writes this
 * string into `batch_jobs.kind`, and apps/worker's
 * batch-jobs/kinds.ts dispatches on it. The actual handler (discover/runItem)
 * stays worker-only; this is just the shared label.
 */

export const DOCUMENT_OCR_PIPELINE_KIND = 'document-ocr-pipeline';
