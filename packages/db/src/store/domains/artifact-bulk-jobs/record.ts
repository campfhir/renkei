import type { Selectable } from 'kysely';
import type { ArtifactBulkJobs } from '../../../db.types';
import type { ArtifactBulkJobRecord, ArtifactBulkResult } from './types';

export const ARTIFACT_BULK_JOBS = 'artifact_bulk_jobs' as const;

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The ids as written: strings only. */
function idsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** The answers as written: each an object with a string id. */
function resultsOf(value: unknown): ArtifactBulkResult[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const fields = new Map(Object.entries(entry));
    const id = text(fields.get('id'));
    return id === null
      ? []
      : [{ id, filename: text(fields.get('filename')), error: text(fields.get('error')) }];
  });
}

const date = (value: Date | string) => (value instanceof Date ? value : new Date(value));
const dateOrNull = (value: Date | string | null) => (value === null ? null : date(value));

export function artifactBulkJobFromRow(row: Selectable<ArtifactBulkJobs>): ArtifactBulkJobRecord {
  return {
    id: row.id,
    subject: row.subject,
    action: row.action,
    projectId: row.project_id,
    mode: row.mode,
    artifactIds: idsOf(row.artifact_ids),
    results: resultsOf(row.results),
    status: row.status,
    lastError: row.last_error,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    finishedAt: dateOrNull(row.finished_at),
    dismissedAt: dateOrNull(row.dismissed_at),
  };
}

/** The answers as stored: only the three fields, in order. */
export const resultsValue = (results: readonly ArtifactBulkResult[]) =>
  results.map((result) => ({ id: result.id, filename: result.filename, error: result.error }));
