import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { CodeTemplateStore } from './types';

export function postgresCodeTemplates(db: () => Kysely<DB>): CodeTemplateStore {
  return {
    async listProjectTemplates() {
      return db()
        .selectFrom('code_project_templates')
        .select(['id', 'name', 'description', 'instructions'])
        .orderBy('name')
        .orderBy('id')
        .execute();
    },
    async createProjectTemplate(input) {
      const inserted = await db()
        .insertInto('code_project_templates')
        .values(input)
        .returning('id')
        .executeTakeFirstOrThrow();
      return inserted.id;
    },
    async updateProjectTemplate(id, input) {
      const result = await db()
        .updateTable('code_project_templates')
        .set({ ...input, updated_at: sql`NOW()` })
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0) > 0;
    },
    async deleteProjectTemplate(id) {
      const result = await db()
        .deleteFrom('code_project_templates')
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0) > 0;
    },
  };
}
