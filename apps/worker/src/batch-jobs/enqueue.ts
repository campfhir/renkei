/**
 * Re-exported from @renkei/batch-jobs-store, which the batch-starting MCP
 * tools in apps/web need too — see that package for the real
 * implementation and its own doc comment. This file exists only to keep
 * every existing `../batch-jobs/enqueue` import in apps/worker working
 * unchanged.
 */
export { enqueueDiscover, enqueueItem, BATCH_JOB_SOURCE } from '@renkei/batch-jobs-store';
