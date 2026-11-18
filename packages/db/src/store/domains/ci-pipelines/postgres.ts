import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { ciPipelineFromRow } from './record';
import type { CiPipelineStore } from './types';

export function postgresCiPipelines(db: () => Kysely<DB>): CiPipelineStore {
  return {
    async get(projectId) {
      const row = await db()
        .selectFrom('ci_pipelines')
        .selectAll()
        .where('project_id', '=', projectId)
        .executeTakeFirst();
      return row ? ciPipelineFromRow(row) : null;
    },
    async list() {
      const rows = await db()
        .selectFrom('ci_pipelines')
        .selectAll()
        .orderBy('project_id')
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
    async save(projectId, input) {
      const spec = JSON.stringify(input.spec ?? null);
      await db()
        .insertInto('ci_pipelines')
        .values({ project_id: projectId, host: input.host, spec, updated_by: input.updatedBy })
        .onConflict((oc) =>
          oc.column('project_id').doUpdateSet({
            host: input.host,
            spec,
            updated_by: input.updatedBy,
            updated_at: sql`NOW()`,
          })
        )
        .execute();
    },
    async markWritten(projectId, input) {
      const result = await db()
        .updateTable('ci_pipelines')
        .set({
          written_text: input.text,
          written_at: sql`NOW()`,
          pull_request_url: input.pullRequestUrl,
        })
        .where('project_id', '=', projectId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0) > 0;
    },
  };
}
