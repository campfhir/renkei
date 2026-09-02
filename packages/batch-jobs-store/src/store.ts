/**
 * Postgres access for batch_jobs / batch_job_items — the read/write model
 * shared by whatever creates a batch (an MCP tool in apps/web) and
 * whatever runs it (the batch-jobs queue handlers in apps/worker; see
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
 * with a single atomic UPDATE...RETURNING (never read-then-write), and the
 * terminal-status flip is guarded by `WHERE status = 'running'` so only the
 * one caller that actually wins the race finalizes the batch — every other
 * concurrent finisher's same UPDATE affects zero rows.
 */

import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface BatchJobRow {
  id: string;
  tenant_id: string;
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

const BATCH_COLUMNS = [
  'id',
  'tenant_id',
  'subject',
  'name',
  'kind',
  'config',
  'status',
  'total',
  'succeeded',
  'failed',
  'skipped',
  'last_error',
  'schedule_id',
  'started_at',
  'finished_at',
  'created_at',
] as const;

const ITEM_COLUMNS = ['id', 'batch_id', 'status', 'payload', 'result', 'error'] as const;

function batchOf(row: {
  id: string;
  tenant_id: string;
  subject: string;
  name: string;
  kind: string;
  config: unknown;
  status: string;
  total: number | null;
  succeeded: number;
  failed: number;
  skipped: number;
  last_error: string | null;
  schedule_id: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}): BatchJobRow {
  return { ...row, config: isRecord(row.config) ? row.config : {} };
}

function itemOf(row: {
  id: string;
  batch_id: string;
  status: string;
  payload: unknown;
  result: unknown;
  error: string | null;
}): BatchJobItemRow {
  return {
    ...row,
    payload: isRecord(row.payload) ? row.payload : {},
    result: isRecord(row.result) ? row.result : null,
  };
}

export interface CreateBatchInput {
  tenantId: string;
  subject: string;
  name: string;
  kind: string;
  config: Record<string, unknown>;
  /** Set when this run was spawned by a schedule firing, not a one-off start. */
  scheduleId?: string;
}

export async function createBatch(db: Kysely<DB>, input: CreateBatchInput): Promise<BatchJobRow> {
  const row = await db
    .insertInto('batch_jobs')
    .values({
      id: randomUUID(),
      tenant_id: input.tenantId,
      subject: input.subject,
      name: input.name,
      kind: input.kind,
      config: JSON.stringify(input.config),
      schedule_id: input.scheduleId ?? null,
    })
    .returning(BATCH_COLUMNS)
    .executeTakeFirstOrThrow();
  return batchOf(row);
}

export async function getBatch(
  db: Kysely<DB>,
  batchId: string,
  tenantId: string
): Promise<BatchJobRow | undefined> {
  const row = await db
    .selectFrom('batch_jobs')
    .select(BATCH_COLUMNS)
    .where('id', '=', batchId)
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  return row ? batchOf(row) : undefined;
}

export interface ListBatchesOptions {
  limit?: number;
  status?: string;
  /** Only batches spawned by this schedule — the schedule's "recent runs" view. */
  scheduleId?: string;
}

export async function listBatches(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  options: ListBatchesOptions = {}
): Promise<BatchJobRow[]> {
  let query = db
    .selectFrom('batch_jobs')
    .select(BATCH_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', subject)
    .orderBy('created_at', 'desc');
  if (options.status) query = query.where('status', '=', options.status);
  if (options.scheduleId) query = query.where('schedule_id', '=', options.scheduleId);
  if (options.limit) query = query.limit(options.limit);
  const rows = await query.execute();
  return rows.map(batchOf);
}

/** 'queued' → 'discovering', the discovery handler's single-effective-attempt claim. */
export async function beginDiscovery(
  db: Kysely<DB>,
  batchId: string
): Promise<BatchJobRow | undefined> {
  const row = await db
    .updateTable('batch_jobs')
    .set({ status: 'discovering', started_at: sql`NOW()`, updated_at: sql`NOW()` })
    .where('id', '=', batchId)
    .where('status', '=', 'queued')
    .returning(BATCH_COLUMNS)
    .executeTakeFirst();
  return row ? batchOf(row) : undefined;
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
  db: Kysely<DB>,
  batchId: string,
  message: string
): Promise<BatchJobRow | undefined> {
  const row = await db
    .updateTable('batch_jobs')
    .set({ status: 'failed', last_error: message, finished_at: sql`NOW()`, updated_at: sql`NOW()` })
    .where('id', '=', batchId)
    .where('status', 'not in', [...TERMINAL_BATCH_STATUSES])
    .returning(BATCH_COLUMNS)
    .executeTakeFirst();
  return row ? batchOf(row) : undefined;
}

/**
 * Discovery created nothing to run — either it found no files, or every
 * file it found was skipped as already processed (`skipped` is how many).
 * Either way there is no item to land last, so the batch is done here.
 */
export async function completeEmptyBatch(
  db: Kysely<DB>,
  batchId: string,
  skipped = 0
): Promise<BatchJobRow | undefined> {
  const row = await db
    .updateTable('batch_jobs')
    .set({
      status: 'succeeded',
      total: skipped,
      skipped: sql`skipped + ${skipped}`,
      finished_at: sql`NOW()`,
      updated_at: sql`NOW()`,
    })
    .where('id', '=', batchId)
    .where('status', 'not in', [...TERMINAL_BATCH_STATUSES])
    .returning(BATCH_COLUMNS)
    .executeTakeFirst();
  return row ? batchOf(row) : undefined;
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
  db: Kysely<DB>,
  batchId: string,
  total: number,
  skipped = 0
): Promise<BatchJobRow | undefined> {
  const row = await db
    .updateTable('batch_jobs')
    .set({ status: 'running', total, skipped: sql`skipped + ${skipped}`, updated_at: sql`NOW()` })
    .where('id', '=', batchId)
    .returning(BATCH_COLUMNS)
    .executeTakeFirst();
  return row ? finalizeIfComplete(db, batchOf(row)) : undefined;
}

export interface InsertItemOptions {
  /** 'skipped' records an item discovery decided not to run — never enqueued. */
  status?: 'pending' | 'skipped';
  result?: Record<string, unknown>;
}

export async function insertItem(
  db: Kysely<DB>,
  batchId: string,
  payload: Record<string, unknown>,
  options: InsertItemOptions = {}
): Promise<BatchJobItemRow> {
  const row = await db
    .insertInto('batch_job_items')
    .values({
      id: randomUUID(),
      batch_id: batchId,
      payload: JSON.stringify(payload),
      ...(options.status ? { status: options.status } : {}),
      ...(options.result ? { result: JSON.stringify(options.result) } : {}),
    })
    .returning(ITEM_COLUMNS)
    .executeTakeFirstOrThrow();
  return itemOf(row);
}

/** 'pending' → 'processing', the per-item single-effective-attempt claim. */
export async function claimItem(
  db: Kysely<DB>,
  itemId: string
): Promise<BatchJobItemRow | undefined> {
  const row = await db
    .updateTable('batch_job_items')
    .set({ status: 'processing', updated_at: sql`NOW()` })
    .where('id', '=', itemId)
    .where('status', '=', 'pending')
    .returning(ITEM_COLUMNS)
    .executeTakeFirst();
  return row ? itemOf(row) : undefined;
}

export async function getItem(db: Kysely<DB>, itemId: string): Promise<BatchJobItemRow | undefined> {
  const row = await db
    .selectFrom('batch_job_items')
    .select(ITEM_COLUMNS)
    .where('id', '=', itemId)
    .executeTakeFirst();
  return row ? itemOf(row) : undefined;
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
async function finalizeIfComplete(
  db: Kysely<DB>,
  batch: BatchJobRow
): Promise<BatchJobRow | undefined> {
  if (batch.total === null || batch.succeeded + batch.failed + batch.skipped < batch.total) {
    return undefined;
  }
  const finalized = await db
    .updateTable('batch_jobs')
    .set({ status: terminalStatusOf(batch), finished_at: sql`NOW()`, updated_at: sql`NOW()` })
    .where('id', '=', batch.id)
    .where('status', '=', 'running')
    .returning(BATCH_COLUMNS)
    .executeTakeFirst();
  return finalized ? batchOf(finalized) : undefined;
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
  db: Kysely<DB>,
  batchId: string,
  itemId: string,
  outcome: ItemOutcome
): Promise<BatchJobRow | undefined> {
  const skipped = outcome.ok && outcome.skipped === true;
  await db
    .updateTable('batch_job_items')
    .set({
      status: skipped ? 'skipped' : outcome.ok ? 'succeeded' : 'failed',
      result: outcome.result ? JSON.stringify(outcome.result) : null,
      error: outcome.error ?? null,
      updated_at: sql`NOW()`,
    })
    .where('id', '=', itemId)
    .execute();

  const batch = await db
    .updateTable('batch_jobs')
    .set({
      succeeded: sql`succeeded + ${outcome.ok && !skipped ? 1 : 0}`,
      failed: sql`failed + ${outcome.ok ? 0 : 1}`,
      skipped: sql`skipped + ${skipped ? 1 : 0}`,
      updated_at: sql`NOW()`,
    })
    .where('id', '=', batchId)
    .returning(BATCH_COLUMNS)
    .executeTakeFirst();
  return batch ? finalizeIfComplete(db, batchOf(batch)) : undefined;
}

export interface ListItemsOptions {
  status?: string;
  limit?: number;
}

export async function listItems(
  db: Kysely<DB>,
  batchId: string,
  options: ListItemsOptions = {}
): Promise<BatchJobItemRow[]> {
  let query = db.selectFrom('batch_job_items').select(ITEM_COLUMNS).where('batch_id', '=', batchId);
  if (options.status) query = query.where('status', '=', options.status);
  query = query.orderBy('created_at', 'asc');
  if (options.limit) query = query.limit(options.limit);
  const rows = await query.execute();
  return rows.map(itemOf);
}
