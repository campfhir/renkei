/**
 * Re-exported from @renkei/batch-jobs-store, which the batch-starting MCP
 * tools in apps/web need too — see that package for the real
 * implementation and its own doc comment. This file exists only to keep
 * every existing `./store` / `../batch-jobs/store` import in
 * apps/worker working unchanged.
 */
export * from '@renkei/batch-jobs-store';
