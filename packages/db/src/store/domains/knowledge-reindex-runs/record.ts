import type { Selectable } from 'kysely';
import type { KnowledgeReindexRuns } from '../../../db.types';
import type { KnowledgeReindexRunRecord } from './types';

export function reindexRunFromRow(
  row: Selectable<KnowledgeReindexRuns>
): KnowledgeReindexRunRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    processed: row.processed,
    skipped: row.skipped,
    failed: row.failed,
    lastError: row.last_error,
    cursor: row.cursor,
    requestedBy: row.requested_by,
    createdAt: new Date(row.created_at),
    startedAt: row.started_at ? new Date(row.started_at) : null,
    finishedAt: row.finished_at ? new Date(row.finished_at) : null,
  };
}

export const ACTIVE = ['queued', 'running'];
export const RESUMABLE = ['paused', 'failed'];
