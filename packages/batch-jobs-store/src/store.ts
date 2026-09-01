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
  kind: string;
  config: Record<string, unknown>;
  status: string;
  total: number | null;
  succeeded: number;
  failed: number;
}

export interface BatchJobItemRow {
  id: string;
  batch_id: string;
  status: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
}

const BATCH_COLUMNS = [
  'id',
  'tenant_id',
  'subject',
  'kind',
  'config',
  'status',
  'total',
  'succeeded',
  'failed',
] as const;

const ITEM_COLUMNS = ['id', 'batch_id', 'status', 'payload', 'result'] as const;

function batchOf(row: {
  id: string;
  tenant_id: string;
  subject: string;
  kind: string;
  config: unknown;
  status: string;
  total: number | null;
  succeeded: number;
  failed: number;
}): BatchJobRow {
  return { ...row, config: isRecord(row.config) ? row.config : {} };
}

function itemOf(row: {
  id: string;
  batch_id: string;
  status: string;
  payload: unknown;
  result: unknown;
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
  kind: string;
  config: Record<string, unknown>;
}

export async function createBatch(db: Kysely<DB>, input: CreateBatchInput): Promise<BatchJobRow> {
  const row = await db
    .insertInto('batch_jobs')
    .values({
      id: randomUUID(),
      tenant_id: input.tenantId,
      subject: input.subject,
      kind: input.kind,
      config: JSON.stringify(input.config),
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

export async function failBatch(db: Kysely<DB>, batchId: string, message: string): Promise<void> {
  await db
    .updateTable('batch_jobs')
    .set({ status: 'failed', last_error: message, finished_at: sql`NOW()`, updated_at: sql`NOW()` })
    .where('id', '=', batchId)
    .execute();
}

/** Discovery found zero items — nothing to run, the batch is trivially done. */
export async function completeEmptyBatch(db: Kysely<DB>, batchId: string): Promise<void> {
  await db
    .updateTable('batch_jobs')
    .set({ status: 'succeeded', total: 0, finished_at: sql`NOW()`, updated_at: sql`NOW()` })
    .where('id', '=', batchId)
    .execute();
}

/** Discovery finished creating items — the batch is now live work. */
export async function activateBatch(db: Kysely<DB>, batchId: string, total: number): Promise<void> {
  await db
    .updateTable('batch_jobs')
    .set({ status: 'running', total, updated_at: sql`NOW()` })
    .where('id', '=', batchId)
    .execute();
}

export async function insertItem(
  db: Kysely<DB>,
  batchId: string,
  payload: Record<string, unknown>
): Promise<BatchJobItemRow> {
  const row = await db
    .insertInto('batch_job_items')
    .values({ id: randomUUID(), batch_id: batchId, payload: JSON.stringify(payload) })
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
  result?: Record<string, unknown>;
  error?: string;
}

/**
 * Record one item's outcome and roll it into the batch's counters,
 * finalizing the batch when this is the last item to land. Safe under
 * concurrent completions — see the module doc comment.
 */
export async function recordItemOutcome(
  db: Kysely<DB>,
  batchId: string,
  itemId: string,
  outcome: ItemOutcome
): Promise<void> {
  await db
    .updateTable('batch_job_items')
    .set({
      status: outcome.ok ? 'succeeded' : 'failed',
      result: outcome.result ? JSON.stringify(outcome.result) : null,
      error: outcome.error ?? null,
      updated_at: sql`NOW()`,
    })
    .where('id', '=', itemId)
    .execute();

  const batch = await db
    .updateTable('batch_jobs')
    .set({
      succeeded: sql`succeeded + ${outcome.ok ? 1 : 0}`,
      failed: sql`failed + ${outcome.ok ? 0 : 1}`,
      updated_at: sql`NOW()`,
    })
    .where('id', '=', batchId)
    .returning(['succeeded', 'failed', 'total'])
    .executeTakeFirst();
  if (!batch || batch.total === null || batch.succeeded + batch.failed < batch.total) return;

  const status = batch.failed === 0 ? 'succeeded' : batch.succeeded > 0 ? 'partial' : 'failed';
  await db
    .updateTable('batch_jobs')
    .set({ status, finished_at: sql`NOW()`, updated_at: sql`NOW()` })
    .where('id', '=', batchId)
    .where('status', '=', 'running')
    .execute();
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
