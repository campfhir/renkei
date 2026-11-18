import type { Selectable } from 'kysely';
import type { CiBlocks, CiBlockVersions } from '../../../db.types';
import type { CiBlockRecord, CiBlockVersionRecord } from './types';

const date = (value: Date | string) => new Date(value);

export function ciBlockFromRow(row: Selectable<CiBlocks>): CiBlockRecord {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    kind: row.kind,
    draft: row.draft ?? null,
    latestVersion: Number(row.latest_version),
    createdBy: row.created_by,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

export function ciBlockVersionFromRow(row: Selectable<CiBlockVersions>): CiBlockVersionRecord {
  return {
    blockId: row.block_id,
    version: Number(row.version),
    definition: row.definition,
    publishedBy: row.published_by,
    publishedAt: date(row.published_at),
  };
}

/** A JSON column's value as pg is handed it: JSON text (an array would go as a Postgres array). */
export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}
