import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { ciPipelineFromRow } from './record';
import type { CiPipelineStore } from './types';

export function postgresCiPipelines(db: () => Kysely<DB>): CiPipelineStore {
  return {
    async get(projectId, branch) {
      const row = await db()
        .selectFrom('ci_pipelines')
        .selectAll()
        .where('project_id', '=', projectId)
        .where('branch', '=', branch)
        .executeTakeFirst();
      return row ? ciPipelineFromRow(row) : null;
    },
    async listForProject(projectId) {
      const rows = await db()
        .selectFrom('ci_pipelines')
        .selectAll()
        .where('project_id', '=', projectId)
        .orderBy('branch')
        .execute();
      return rows.map(ciPipelineFromRow);
    },
    async findByRepoKey(host, repoKey) {
      const rows = await db()
        .selectFrom('ci_pipelines')
        .selectAll()
        .where('host', '=', host)
        .where('repo_key', '=', repoKey)
        .orderBy('updated_at', 'desc')
        .orderBy('project_id')
        .orderBy('branch')
        .execute();
      return rows.map(ciPipelineFromRow);
    },
    async setRepoKey(projectId, repoKey) {
      const result = await db()
        .updateTable('ci_pipelines')
        .set({ repo_key: repoKey })
        .where('project_id', '=', projectId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0) > 0;
    },
    async save(projectId, branch, input) {
      const spec = JSON.stringify(input.spec ?? null);
      await db()
        .insertInto('ci_pipelines')
        .values({
          project_id: projectId,
          branch,
          host: input.host,
          spec,
          updated_by: input.updatedBy,
        })
        .onConflict((oc) =>
          oc.columns(['project_id', 'branch']).doUpdateSet({
            host: input.host,
            spec,
            updated_by: input.updatedBy,
            updated_at: sql`NOW()`,
          })
        )
        .execute();
    },
    async markWritten(projectId, branch, input) {
      const result = await db()
        .updateTable('ci_pipelines')
        .set({
          written_text: input.text,
          written_at: sql`NOW()`,
          pull_request_url: input.pullRequestUrl,
        })
        .where('project_id', '=', projectId)
        .where('branch', '=', branch)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0) > 0;
    },
  };
}
