import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { ciEnvironmentFromRow } from './record';
import type { CiEnvironmentStore } from './types';

export function postgresCiEnvironments(db: () => Kysely<DB>): CiEnvironmentStore {
  return {
    async list(projectId) {
      const rows = await db()
        .selectFrom('ci_environments')
        .selectAll()
        .where('project_id', '=', projectId)
        .orderBy('position')
        .execute();
      return rows.map(ciEnvironmentFromRow);
    },
    async replace(projectId, environments, updatedBy) {
      await db()
        .transaction()
        .execute(async (trx) => {
          await trx.deleteFrom('ci_environments').where('project_id', '=', projectId).execute();
          if (environments.length === 0) return;
          await trx
            .insertInto('ci_environments')
            .values(
              environments.map((environment, position) => ({
                project_id: projectId,
                position,
                name: environment.name,
                production: environment.production,
                branches: JSON.stringify(environment.branches),
                updated_by: updatedBy,
              }))
            )
            .execute();
        });
    },
  };
}
