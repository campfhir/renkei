/**
 * The batch-job kind registry — one entry per `batch_jobs.kind`, the same
 * dispatch-by-kind shape upload-executors.ts's `executeUpload` uses for
 * upload slots. document-ocr-pipeline (batch-jobs/document-ocr-pipeline.ts)
 * is the first kind; a future batch job type registers itself here and
 * needs no change to the queue handler, the store, or the schema.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { BatchJobItemRow, BatchJobRow } from './store';

export interface DiscoverOutcome {
  ok: boolean;
  /** Payload for each item to create, in the order they should run. */
  items?: Record<string, unknown>[];
  /**
   * Payloads discovery decided NOT to run — recorded as items with status
   * 'skipped' (so the batch page lists them) but never enqueued. Each
   * should say why in `skipReason`.
   */
  skipped?: Record<string, unknown>[];
  error?: string;
}

export interface RunItemOutcome {
  ok: boolean;
  /** Deliberately not processed (already done by an earlier batch). */
  skipped?: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

export interface BatchJobKindHandler {
  /** List/group the batch's source into items — called once per batch. */
  discover(db: Kysely<DB>, batch: BatchJobRow): Promise<DiscoverOutcome>;
  /** Do the work for one item — called once per item, fanned out across the queue. */
  runItem(db: Kysely<DB>, batch: BatchJobRow, item: BatchJobItemRow): Promise<RunItemOutcome>;
}

const registry = new Map<string, BatchJobKindHandler>();

export function registerBatchJobKind(kind: string, handler: BatchJobKindHandler): void {
  registry.set(kind, handler);
}

export function getBatchJobKind(kind: string): BatchJobKindHandler | undefined {
  return registry.get(kind);
}
