import type { Selectable } from 'kysely';
import type { CiPipelines } from '../../../db.types';
import type { CiPipelineRecord } from './types';

export function ciPipelineFromRow(row: Selectable<CiPipelines>): CiPipelineRecord {
  return {
    projectId: row.project_id,
    host: row.host,
    spec: row.spec,
    writtenText: row.written_text,
    writtenAt: row.written_at === null ? null : new Date(row.written_at),
    pullRequestUrl: row.pull_request_url,
    repoKey: row.repo_key,
    updatedBy: row.updated_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}
