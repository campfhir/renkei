/**
 * @renkei/batch-jobs-store — the generic batch_jobs / batch_job_items read
 * model, shared between whatever creates a batch (an MCP tool in
 * apps/web) and whatever runs it (the queue handlers in
 * apps/worker/src/handlers/batch-jobs.ts). `kind` dispatch (which handler
 * runs a given batch's items) is worker-only — see
 * apps/worker/src/batch-jobs/kinds.ts — this package only ever reads/writes
 * rows.
 */

export {
  createBatch,
  getBatch,
  listBatches,
  beginDiscovery,
  failBatch,
  completeEmptyBatch,
  activateBatch,
  insertItem,
  claimItem,
  getItem,
  recordItemOutcome,
  listItems,
  TERMINAL_BATCH_STATUSES,
  isTerminalBatchStatus,
} from './store';
export type {
  BatchJobRow,
  BatchJobItemRow,
  CreateBatchInput,
  ListBatchesOptions,
  ItemOutcome,
  ListItemsOptions,
} from './store';

export { enqueueDiscover, enqueueItem, BATCH_JOB_SOURCE } from './enqueue';

export { DOCUMENT_OCR_PIPELINE_KIND } from './kind-names';

export { batchKindLabel, describeBatchOutcome } from './describe';

export {
  createSchedule,
  getSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule,
} from './schedules';
export type {
  BatchJobScheduleRow,
  CreateScheduleInput,
  UpdateScheduleInput,
} from './schedules';
