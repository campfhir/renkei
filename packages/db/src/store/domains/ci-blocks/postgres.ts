import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { ciBlockFromRow, ciBlockVersionFromRow, json } from './record';
import type { CiBlockStore } from './types';

export function postgresCiBlocks(db: () => Kysely<DB>): CiBlockStore {
  return {
    async list() {
      const rows = await db()
        .selectFrom('ci_blocks')
        .selectAll()
        .orderBy('name')
        .orderBy('id')
        .execute();
      return rows.map(ciBlockFromRow);
    },
    async get(id) {
      const row = await db()
        .selectFrom('ci_blocks')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? ciBlockFromRow(row) : null;
    },
    async getByKey(key) {
      const row = await db()
        .selectFrom('ci_blocks')
        .selectAll()
        .where('key', '=', key)
        .executeTakeFirst();
      return row ? ciBlockFromRow(row) : null;
    },
    async create(input) {
      const inserted = await db()
        .insertInto('ci_blocks')
        .values({
          key: input.key,
          name: input.name,
          description: input.description,
          kind: input.kind,
          draft: json(input.draft),
          created_by: input.createdBy,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return inserted.id;
    },
    async saveDraft(id, input) {
      const result = await db()
        .updateTable('ci_blocks')
        .set({
          name: input.name,
          description: input.description,
          kind: input.kind,
          draft: json(input.draft),
          updated_at: sql`NOW()`,
        })
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0) > 0;
    },
    async discardDraft(id) {
      const result = await db()
        .updateTable('ci_blocks')
        .set({ draft: null, updated_at: sql`NOW()` })
        .where('id', '=', id)
        .where('draft', 'is not', null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0) > 0;
    },
    async publish(id, publishedBy) {
      return db()
        .transaction()
        .execute(async (trx) => {
          const block = await trx
            .selectFrom('ci_blocks')
            .select(['draft', 'latest_version'])
            .where('id', '=', id)
            .forUpdate()
            .executeTakeFirst();
          if (!block || block.draft === null) return null;
          const version = Number(block.latest_version) + 1;
          await trx
            .insertInto('ci_block_versions')
            .values({
              block_id: id,
              version,
              definition: json(block.draft),
              published_by: publishedBy,
            })
            .execute();
          await trx
            .updateTable('ci_blocks')
            .set({ draft: null, latest_version: version, updated_at: sql`NOW()` })
            .where('id', '=', id)
            .execute();
          return version;
        });
    },
    async listVersions(id) {
      const rows = await db()
        .selectFrom('ci_block_versions')
        .selectAll()
        .where('block_id', '=', id)
        .orderBy('version', 'desc')
        .execute();
      return rows.map(ciBlockVersionFromRow);
    },
    async getVersion(id, version) {
      const row = await db()
        .selectFrom('ci_block_versions')
        .selectAll()
        .where('block_id', '=', id)
        .where('version', '=', version)
        .executeTakeFirst();
      return row ? ciBlockVersionFromRow(row) : null;
    },
    async delete(id) {
      const result = await db().deleteFrom('ci_blocks').where('id', '=', id).executeTakeFirst();
      return Number(result.numDeletedRows ?? 0) > 0;
    },
  };
}
