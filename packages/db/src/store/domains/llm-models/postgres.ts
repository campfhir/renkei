import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { isLabelConflict, llmModelFromRow, llmModelValues } from './record';
import type { LlmModelStore } from './types';

export function postgresLlmModels(db: () => Kysely<DB>): LlmModelStore {
  return {
    async list() {
      const rows = await db()
        .selectFrom('llm_model_configs')
        .selectAll()
        .orderBy('label')
        .orderBy('id')
        .execute();
      return rows.map(llmModelFromRow);
    },
    async get(id) {
      const row = await db()
        .selectFrom('llm_model_configs')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? llmModelFromRow(row) : null;
    },
    async create(id, input) {
      try {
        await db()
          .transaction()
          .execute(async (trx) => {
            if (input.isDefault) {
              await trx
                .updateTable('llm_model_configs')
                .set({ is_default: false, updated_at: sql`NOW()` })
                .where('is_default', '=', true)
                .execute();
            }
            await trx
              .insertInto('llm_model_configs')
              .values({ id, ...llmModelValues(input) })
              .execute();
          });
        return 'created';
      } catch (error) {
        if (isLabelConflict(error)) return 'duplicate-label';
        throw error;
      }
    },
    async update(id, input) {
      try {
        return await db()
          .transaction()
          .execute(async (trx) => {
            if (input.isDefault) {
              await trx
                .updateTable('llm_model_configs')
                .set({ is_default: false, updated_at: sql`NOW()` })
                .where('is_default', '=', true)
                .where('id', '!=', id)
                .execute();
            }
            const result = await trx
              .updateTable('llm_model_configs')
              .set({ ...llmModelValues(input), updated_at: sql`NOW()` })
              .where('id', '=', id)
              .executeTakeFirst();
            if (Number(result.numUpdatedRows ?? 0) === 0) {
              // Nothing to point the default at: undo the clearing above.
              throw new NotFound();
            }
            return 'updated' as const;
          });
      } catch (error) {
        if (error instanceof NotFound) return 'not-found';
        if (isLabelConflict(error)) return 'duplicate-label';
        throw error;
      }
    },
    async delete(id) {
      const result = await db()
        .deleteFrom('llm_model_configs')
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0) > 0;
    },
  };
}

class NotFound extends Error {}
