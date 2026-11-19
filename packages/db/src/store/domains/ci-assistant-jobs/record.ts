import type { Selectable } from 'kysely';
import type { CiAssistantJobs } from '../../../db.types';
import type { CiAssistantJobOutcome, CiAssistantJobRecord } from './types';

const STATUSES = ['running', 'succeeded', 'failed'] as const;

export function jobFromRow(row: Selectable<CiAssistantJobs>): CiAssistantJobRecord {
  return {
    id: row.id,
    subject: row.subject,
    projectId: row.project_id,
    status: STATUSES.find((s) => s === row.status) ?? 'failed',
    step: row.step,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

/** The columns an outcome writes, `result` as the JSON value itself. */
export function outcomeColumns(outcome: CiAssistantJobOutcome, at: Date) {
  return outcome.status === 'succeeded'
    ? { status: 'succeeded', result: outcome.result, error: null, finished_at: at, updated_at: at }
    : { status: 'failed', result: null, error: outcome.error, finished_at: at, updated_at: at };
}
