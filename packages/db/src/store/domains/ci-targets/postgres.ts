import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { ciTargetFromRow, json } from './record';
import type { CiTargetStore } from './types';

export function postgresCiTargets(db: () => Kysely<DB>): CiTargetStore {
  return {
    async list() {
      const rows = await db()
        .selectFrom('ci_targets')
        .selectAll()
        .orderBy('name')
        .orderBy('id')
        .execute();
      return rows.map(ciTargetFromRow);
    },
    async get(id) {
      const row = await db()
        .selectFrom('ci_targets')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? ciTargetFromRow(row) : null;
    },
    async create(input) {
      const inserted = await db()
        .insertInto('ci_targets')
        .values({
          name: input.name,
          description: input.description,
          kind: input.kind,
          labels: json(input.labels),
          created_by: input.createdBy,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return inserted.id;
    },
    async update(id, input) {
      const result = await db()
        .updateTable('ci_targets')
        .set({
          name: input.name,
          description: input.description,
          kind: input.kind,
          labels: json(input.labels),
          updated_at: sql`NOW()`,
        })
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0) > 0;
    },
    async delete(id) {
      const result = await db().deleteFrom('ci_targets').where('id', '=', id).executeTakeFirst();
      return Number(result.numDeletedRows ?? 0) > 0;
    },
  };
}
