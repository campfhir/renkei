import type { Selectable } from 'kysely';
import type { CiDeployments } from '../../../db.types';
import type { CiDeploymentRecord } from './types';

export function ciDeploymentFromRow(row: Selectable<CiDeployments>): CiDeploymentRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    environment: row.environment,
    status: row.status,
    commitSha: row.commit_sha,
    branch: row.branch,
    target: row.target,
    runId: row.run_id,
    runUrl: row.run_url,
    detail: row.detail,
    actor: row.actor,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at === null ? null : new Date(row.finished_at),
  };
}
