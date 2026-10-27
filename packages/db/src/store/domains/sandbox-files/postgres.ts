import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { sandboxFileFromRow, sandboxFileValues } from './record';
import type { SandboxFileStore } from './types';

export function postgresSandboxFiles(db: () => Kysely<DB>): SandboxFileStore {
  return {
    async insert(file) {
      const row = await db()
        .insertInto('sandbox_files')
        .values(sandboxFileValues(file))
        .returningAll()
        .executeTakeFirstOrThrow();
      return sandboxFileFromRow(row);
    },
    async list(subject, batchId) {
      let query = db().selectFrom('sandbox_files').selectAll().where('subject', '=', subject);
      if (batchId) query = query.where('batch_id', '=', batchId);
      const rows = await query.orderBy('created_at', 'desc').orderBy('id').execute();
      return rows.map(sandboxFileFromRow);
    },
    async countForSubject(subject) {
      const row = await db()
        .selectFrom('sandbox_files')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('subject', '=', subject)
        .executeTakeFirst();
      return row?.count ? Number(row.count) : 0;
    },
    async totalBytesForSubject(subject) {
      const row = await db()
        .selectFrom('sandbox_files')
        .select((eb) => eb.fn.sum<string>('size_bytes').as('total'))
        .where('subject', '=', subject)
        .executeTakeFirst();
      return row?.total ? Number(row.total) : 0;
    },
    async countForBatch(batchId) {
      const row = await db()
        .selectFrom('sandbox_files')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('batch_id', '=', batchId)
        .executeTakeFirst();
      return row?.count ? Number(row.count) : 0;
    },
    async totalBytesForBatch(batchId) {
      const row = await db()
        .selectFrom('sandbox_files')
        .select((eb) => eb.fn.sum<string>('size_bytes').as('total'))
        .where('batch_id', '=', batchId)
        .executeTakeFirst();
      return row?.total ? Number(row.total) : 0;
    },
    async get(subject, id) {
      const row = await db()
        .selectFrom('sandbox_files')
        .selectAll()
        .where('subject', '=', subject)
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? sandboxFileFromRow(row) : null;
    },
    async delete(subject, id) {
      const row = await db()
        .deleteFrom('sandbox_files')
        .where('subject', '=', subject)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      return row ? sandboxFileFromRow(row) : null;
    },
    async listExpired(before, limit) {
      const rows = await db()
        .selectFrom('sandbox_files')
        .selectAll()
        .where('expires_at', '<', before)
        .orderBy('expires_at')
        .orderBy('id')
        .limit(limit)
        .execute();
      return rows.map(sandboxFileFromRow);
    },
    async deleteById(id) {
      await db().deleteFrom('sandbox_files').where('id', '=', id).execute();
    },
  };
}
