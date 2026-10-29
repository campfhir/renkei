import type { Selectable } from 'kysely';
import type { BatchJobItems, BatchJobs } from '../../../db.types';
import type { BatchJobItemRecord, BatchJobRecord, NewBatchJob, NewBatchJobItem } from './types';

/** The statuses a batch never leaves once it reaches them. */
export const TERMINAL_STATUSES = ['succeeded', 'partial', 'failed', 'canceled'];

export const BATCH_COLUMNS = [
  'id',
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

export const ITEM_COLUMNS = ['id', 'batch_id', 'status', 'payload', 'result', 'error'] as const;

type BatchRow = Pick<Selectable<BatchJobs>, (typeof BATCH_COLUMNS)[number]>;
type ItemRow = Pick<Selectable<BatchJobItems>, (typeof ITEM_COLUMNS)[number]>;

const dateOrNull = (value: Date | string | null): Date | null =>
  value === null ? null : new Date(value);

export function batchFromRow(row: BatchRow): BatchJobRecord {
  return {
    id: row.id,
    subject: row.subject,
    name: row.name,
    kind: row.kind,
    config: row.config ?? null,
    status: row.status,
    total: row.total,
    succeeded: row.succeeded,
    failed: row.failed,
    skipped: row.skipped,
    lastError: row.last_error,
    scheduleId: row.schedule_id,
    startedAt: dateOrNull(row.started_at),
    finishedAt: dateOrNull(row.finished_at),
    createdAt: new Date(row.created_at),
  };
}

export function itemFromRow(row: ItemRow): BatchJobItemRecord {
  return {
    id: row.id,
    batchId: row.batch_id,
    status: row.status,
    payload: row.payload ?? null,
    result: row.result ?? null,
    error: row.error,
  };
}

export function json(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

export function batchValues(batch: NewBatchJob) {
  return {
    id: batch.id ?? globalThis.crypto.randomUUID(),
    subject: batch.subject,
    name: batch.name,
    kind: batch.kind,
    config: json(batch.config) ?? '{}',
    schedule_id: batch.scheduleId ?? null,
  };
}

export function itemValues(batchId: string, item: NewBatchJobItem) {
  return {
    id: item.id ?? globalThis.crypto.randomUUID(),
    batch_id: batchId,
    payload: json(item.payload) ?? '{}',
    ...(item.status ? { status: item.status } : {}),
    ...(item.result !== undefined && item.result !== null ? { result: json(item.result) } : {}),
  };
}
