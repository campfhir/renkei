import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { CiRepoKeyStore } from './types';

export function postgresCiRepoKeys(db: () => Kysely<DB>): CiRepoKeyStore {
  return {
    async set(projectId, host, repoKey) {
      await db()
        .insertInto('ci_repo_keys')
        .values({ project_id: projectId, host, repo_key: repoKey })
        .onConflict((oc) =>
          oc.column('project_id').doUpdateSet({ host, repo_key: repoKey, updated_at: sql`NOW()` })
        )
        .execute();
    },
    async projectsFor(host, repoKey) {
      const rows = await db()
        .selectFrom('ci_repo_keys')
        .select('project_id')
        .where('host', '=', host)
        .where('repo_key', '=', repoKey)
        .orderBy('updated_at', 'desc')
        .orderBy('project_id')
        .execute();
      return rows.map((row) => row.project_id);
    },
  };
}
