/**
 * batch_jobs / batch_job_items, through the data store
 * (`getDataStore().batchJobs`) — the read/write model shared by whatever
 * creates a batch (an MCP tool or a form in apps/web) and whatever runs it
 * (the batch-jobs queue handlers in apps/worker; see
 * apps/worker/src/batch-jobs/kinds.ts for the per-kind discover()/runItem()
 * contract those handlers dispatch to).
 *
 * Two crash-recovery guards, both the mail_bulk_jobs single-effective-
 * attempt pattern applied at their own granularity:
 *
 *  - A batch found 'discovering' on redelivery means a previous attempt
 *    died mid-discovery. It is NOT re-run (that would create duplicate
 *    items) — it finalizes as failed, and starting over is a fresh batch.
 *  - An item found 'processing' on redelivery means a previous attempt
 *    died mid-item. It is NOT re-run either — OCR (or whatever a future
 *    kind's item work is) is billed per call, so a blind retry would
 *    double-charge; it finalizes as failed and rolls into the batch's
 *    counters like any other failure.
 *
 * Batch completion is a distributed counter: many items finish concurrently
 * across worker instances, so `recordItemOutcome` increments succeeded/failed
 * with a single atomic UPDATE...RETURNING (the store's `addCounts`, never
 * read-then-write), and the terminal-status flip (`finishRunning`) is
 * guarded by `WHERE status = 'running'` so only the one caller that
 * actually wins the race finalizes the batch — every other concurrent
 * finisher's same UPDATE affects zero rows. Which counters complete a batch,
 * and with which outcome, is decided here, not in the store.
 */

import { getDataStore, type BatchJobItemRecord, type BatchJobRecord } from '@renkei/db';
import { isRecord } from '@renkei/guards';

export interface BatchJobRow {
  id: string;
  subject: string;
  name: string;
  kind: string;
  config: Record<string, unknown>;
  status: string;
  total: number | null;
  succeeded: number;
  failed: number;
  /**
   * Items the batch deliberately did not process — a file an earlier batch
   * already handled (see processed-files.ts). Neither a success nor a
   * failure; counted against `total` like both.
   */
  skipped: number;
  last_error: string | null;
  /** The schedule that spawned this run, or null for a one-off batch. */
  schedule_id: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

export interface BatchJobItemRow {
  id: string;
  batch_id: string;
  status: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
}

function batchOf(record: BatchJobRecord): BatchJobRow {
  return {
    id: record.id,
    subject: record.subject,
    name: record.name,
    kind: record.kind,
    config: isRecord(record.config) ? record.config : {},
    status: record.status,
    total: record.total,
    succeeded: record.succeeded,
    failed: record.failed,
    skipped: record.skipped,
    last_error: record.lastError,
    schedule_id: record.scheduleId,
    started_at: record.startedAt,
    finished_at: record.finishedAt,
    created_at: record.createdAt,
  };
}

function itemOf(record: BatchJobItemRecord): BatchJobItemRow {
  return {
    id: record.id,
    batch_id: record.batchId,
    status: record.status,
    payload: isRecord(record.payload) ? record.payload : {},
    result: isRecord(record.result) ? record.result : null,
    error: record.error,
  };
}

const maybeBatch = (record: BatchJobRecord | undefined) => (record ? batchOf(record) : undefined);
const maybeItem = (record: BatchJobItemRecord | undefined) => (record ? itemOf(record) : undefined);

export interface CreateBatchInput {
  subject: string;
  name: string;
  kind: string;
  config: Record<string, unknown>;
  /** Set when this run was spawned by a schedule firing, not a one-off start. */
  scheduleId?: string;
}

export async function createBatch(input: CreateBatchInput): Promise<BatchJobRow> {
  return batchOf(
    await getDataStore().batchJobs.create({
      subject: input.subject,
      name: input.name,
      kind: input.kind,
      config: input.config,
      scheduleId: input.scheduleId ?? null,
    })
  );
}

export async function getBatch(batchId: string): Promise<BatchJobRow | undefined> {
  return maybeBatch(await getDataStore().batchJobs.get(batchId));
}

export interface ListBatchesOptions {
  limit?: number;
  status?: string;
  /** Only batches spawned by this schedule — the schedule's "recent runs" view. */
  scheduleId?: string;
}

/** Newest first (ties by id). */
export async function listBatches(
  subject: string,
  options: ListBatchesOptions = {}
): Promise<BatchJobRow[]> {
  return (await getDataStore().batchJobs.list(subject, options)).map(batchOf);
}

/** 'queued' → 'discovering', the discovery handler's single-effective-attempt claim. */
export async function beginDiscovery(batchId: string): Promise<BatchJobRow | undefined> {
  return maybeBatch(await getDataStore().batchJobs.beginDiscovery(batchId));
}

/** The statuses a batch never leaves once it reaches them. */
export const TERMINAL_BATCH_STATUSES = ['succeeded', 'partial', 'failed', 'canceled'] as const;

export function isTerminalBatchStatus(status: string): boolean {
  return TERMINAL_BATCH_STATUSES.some((terminal) => terminal === status);
}

/**
 * Every terminal transition below resolves to the finalized row when THIS
 * call is the one that ended the batch, and undefined when the batch was
 * already terminal — the same "only the winner sees a row" shape as
 * `beginDiscovery`/`claimItem`. The caller that gets a row is the one that
 * announces the outcome (notifies the owner, publishes the domain event),
 * so a redelivered message or a concurrent finisher can never announce a
 * batch twice.
 */
export async function failBatch(
  batchId: string,
  message: string
): Promise<BatchJobRow | undefined> {
  return maybeBatch(await getDataStore().batchJobs.fail(batchId, message));
}

/**
 * Discovery created nothing to run — either it found no files, or every
 * file it found was skipped as already processed (`skipped` is how many).
 * Either way there is no item to land last, so the batch is done here.
 */
export async function completeEmptyBatch(
  batchId: string,
  skipped = 0
): Promise<BatchJobRow | undefined> {
  return maybeBatch(await getDataStore().batchJobs.completeEmpty(batchId, skipped));
}

/**
 * Discovery finished creating items — the batch is now live work. `total`
 * counts every item, including the `skipped` ones discovery recorded
 * without enqueueing (they are added to the counter, never assigned: an
 * item that already ran and was skipped at item time may have bumped it
 * first).
 *
 * Resolves to the finalized row in one narrow case: every enqueued item
 * already landed before this ran (items are enqueued before `total` is
 * known, and a fast item can beat the activation UPDATE). Without this
 * check nobody would ever flip such a batch — its last item found
 * `total` null and returned. The caller announces the row like any other
 * terminal transition.
 */
export async function activateBatch(
  batchId: string,
  total: number,
  skipped = 0
): Promise<BatchJobRow | undefined> {
  const row = maybeBatch(await getDataStore().batchJobs.activate(batchId, total, skipped));
  return row ? finalizeIfComplete(row) : undefined;
}

export interface InsertItemOptions {
  /** 'skipped' records an item discovery decided not to run — never enqueued. */
  status?: 'pending' | 'skipped';
  result?: Record<string, unknown>;
}

export async function insertItem(
  batchId: string,
  payload: Record<string, unknown>,
  options: InsertItemOptions = {}
): Promise<BatchJobItemRow> {
  return itemOf(
    await getDataStore().batchJobs.insertItem(batchId, {
      payload,
      status: options.status,
      result: options.result,
    })
  );
}

/** 'pending' → 'processing', the per-item single-effective-attempt claim. */
export async function claimItem(itemId: string): Promise<BatchJobItemRow | undefined> {
  return maybeItem(await getDataStore().batchJobs.claimItem(itemId));
}

export async function getItem(itemId: string): Promise<BatchJobItemRow | undefined> {
  return maybeItem(await getDataStore().batchJobs.getItem(itemId));
}

export interface ItemOutcome {
  ok: boolean;
  /**
   * The item was deliberately not processed (its file was already done by
   * an earlier batch). Only meaningful with `ok: true`; counts under
   * `skipped`, not `succeeded`.
   */
  skipped?: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

/** Terminal status from the counters: skipped items neither help nor hurt. */
function terminalStatusOf(batch: { succeeded: number; failed: number }): string {
  return batch.failed === 0 ? 'succeeded' : batch.succeeded > 0 ? 'partial' : 'failed';
}

/**
 * The guarded terminal flip, shared by every path that can be the one to
 * complete a batch. Resolves to the finalized row only when the counters
 * cover `total` AND this UPDATE is the one that changed the status —
 * every other concurrent caller's identical UPDATE affects zero rows.
 */
async function finalizeIfComplete(batch: BatchJobRow): Promise<BatchJobRow | undefined> {
  if (batch.total === null || batch.succeeded + batch.failed + batch.skipped < batch.total) {
    return undefined;
  }
  return maybeBatch(
    await getDataStore().batchJobs.finishRunning(batch.id, terminalStatusOf(batch))
  );
}

/**
 * Record one item's outcome and roll it into the batch's counters,
 * finalizing the batch when this is the last item to land. Safe under
 * concurrent completions — see the module doc comment.
 *
 * Resolves to the finalized batch row exactly once per batch: for the one
 * caller whose completion both reached the total AND won the guarded
 * terminal flip. Every other call — an item that was not the last, or a
 * concurrent finisher that lost the race — resolves to undefined.
 */
export async function recordItemOutcome(
  batchId: string,
  itemId: string,
  outcome: ItemOutcome
): Promise<BatchJobRow | undefined> {
  const skipped = outcome.ok && outcome.skipped === true;
  const batches = getDataStore().batchJobs;
  await batches.setItemOutcome(itemId, {
    status: skipped ? 'skipped' : outcome.ok ? 'succeeded' : 'failed',
    result: outcome.result ?? null,
    error: outcome.error ?? null,
  });

  const batch = maybeBatch(
    await batches.addCounts(batchId, {
      succeeded: outcome.ok && !skipped ? 1 : 0,
      failed: outcome.ok ? 0 : 1,
      skipped: skipped ? 1 : 0,
    })
  );
  return batch ? finalizeIfComplete(batch) : undefined;
}

export interface ListItemsOptions {
  status?: string;
  limit?: number;
}

/** Oldest first (ties by id). */
export async function listItems(
  batchId: string,
  options: ListItemsOptions = {}
): Promise<BatchJobItemRow[]> {
  return (await getDataStore().batchJobs.listItems(batchId, options)).map(itemOf);
}
