import type { Selectable } from 'kysely';
import type { CiTargets } from '../../../db.types';
import type { CiTargetRecord } from './types';

export function ciTargetFromRow(row: Selectable<CiTargets>): CiTargetRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    labels: row.labels,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/** A JSON column's value as pg is handed it. */
export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}
