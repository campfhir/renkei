/**
 * Side-effect module: importing this registers every batch-job kind
 * (kinds.ts's registerBatchJobKind) the batch-jobs-worker knows how to
 * run. Add a new kind by importing its module here — no other wiring
 * needed, the queue handler dispatches purely off `batch_jobs.kind`.
 */

import './document-ocr-pipeline';
