import type { Selectable } from 'kysely';
import type { CiEnvironments } from '../../../db.types';
import type { CiEnvironmentRecord } from './types';

export function ciEnvironmentFromRow(row: Selectable<CiEnvironments>): CiEnvironmentRecord {
  return {
    projectId: row.project_id,
    name: row.name,
    production: row.production,
    branches: Array.isArray(row.branches)
      ? row.branches.filter((branch): branch is string => typeof branch === 'string')
      : [],
    updatedBy: row.updated_by,
    updatedAt: new Date(row.updated_at),
  };
}
