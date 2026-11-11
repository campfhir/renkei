import { sql, type Kysely, type SqlBool } from 'kysely';
import type { DB } from '../../../db.types';
import { isLabelConflict, llmModelFromRow, llmModelValues } from './record';
import type { LlmModelStore, LlmModelUse } from './types';

// The twins of @renkei/agent-llm's chat/image split.
const imageSurface = sql<SqlBool>`coalesce(settings->>'apiSurface', '') in ('images', 'flux')`;
const chatSurface = sql<SqlBool>`coalesce(settings->>'apiSurface', '') not in ('images', 'flux')`;

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
    async findEnabledChatModel(id) {
      let query = db()
        .selectFrom('llm_model_configs')
        .selectAll()
        .where('enabled', '=', true)
        .where(chatSurface);
      query = id ? query.where('id', '=', id) : query.where('is_default', '=', true);
      const row = await query.orderBy('id').executeTakeFirst();
      return row ? llmModelFromRow(row) : null;
    },
    async findEnabledImageModel(id) {
      let query = db()
        .selectFrom('llm_model_configs')
        .selectAll()
        .where('enabled', '=', true)
        .where(imageSurface);
      if (id) query = query.where('id', '=', id);
      const row = await query.orderBy('label', 'asc').orderBy('id').executeTakeFirst();
      return row ? llmModelFromRow(row) : null;
    },
    async delete(id, replacementId) {
      return db()
        .transaction()
        .execute(async (trx) => {
          if (replacementId) {
            // Before the delete: its foreign keys would null these first.
            for (const table of ['chat_projects', 'chats', 'agents'] as const) {
              await trx
                .updateTable(table)
                .set({ llm_model_id: replacementId })
                .where('llm_model_id', '=', id)
                .execute();
            }
          }
          const result = await trx
            .deleteFrom('llm_model_configs')
            .where('id', '=', id)
            .executeTakeFirst();
          return Number(result.numDeletedRows ?? 0) > 0;
        });
    },
    async usedBy(id) {
      const [projects, chats, agents] = await Promise.all(
        (['chat_projects', 'chats', 'agents'] as const).map((table) =>
          db()
            .selectFrom(table)
            .select(['owner_subject', (eb) => eb.fn.countAll<string>().as('count')])
            .where('llm_model_id', '=', id)
            .groupBy('owner_subject')
            .execute()
        )
      );
      const uses = new Map<string, LlmModelUse>();
      const use = (subject: string) => {
        const found = uses.get(subject) ?? { subject, projects: 0, chats: 0, agents: 0 };
        uses.set(subject, found);
        return found;
      };
      for (const row of projects ?? []) use(row.owner_subject).projects = Number(row.count);
      for (const row of chats ?? []) use(row.owner_subject).chats = Number(row.count);
      for (const row of agents ?? []) use(row.owner_subject).agents = Number(row.count);
      return [...uses.values()].sort((a, b) =>
        a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0
      );
    },
  };
}

class NotFound extends Error {}
