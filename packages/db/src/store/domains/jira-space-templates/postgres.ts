import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { JIRA_SPACE_TEMPLATES as TABLE, templateFromRow, templateValues } from './record';
import type { JiraSpaceTemplateStore } from './types';

export function postgresJiraSpaceTemplates(db: () => Kysely<DB>): JiraSpaceTemplateStore {
  return {
    async save(input, { overwrite }) {
      const values = templateValues(input);
      const insert = db().insertInto(TABLE).values(values);
      const target = ['cloud_id', 'name_key'] as const;
      const row = overwrite
        ? await insert
            .onConflict((conflict) =>
              conflict.columns([...target]).doUpdateSet({
                name: values.name,
                description: values.description,
                source_space_key: values.source_space_key,
                site_url: values.site_url,
                document: values.document,
                updated_by: input.subject,
                updated_at: sql<Date>`NOW()`,
              })
            )
            .returningAll()
            .executeTakeFirst()
        : await insert
            .onConflict((conflict) => conflict.columns([...target]).doNothing())
            .returningAll()
            .executeTakeFirst();
      return row ? templateFromRow(row) : null;
    },
    async find(cloudId, reference) {
      const base = db().selectFrom(TABLE).selectAll();
      const query =
        'id' in reference
          ? base.where('id', '=', reference.id)
          : base.where('name_key', '=', reference.nameKey);
      const rows = await query.orderBy('id').execute();
      // This site's first; the rest keep their id order.
      const here = rows.filter((row) => row.cloud_id === cloudId);
      const elsewhere = rows.filter((row) => row.cloud_id !== cloudId);
      return [...here, ...elsewhere].map(templateFromRow);
    },
    async list(limit) {
      const rows = await db()
        .selectFrom(TABLE)
        .selectAll()
        .orderBy('name_key')
        .orderBy('id')
        .limit(limit)
        .execute();
      return rows.map(templateFromRow);
    },
    async delete(id) {
      const result = await db().deleteFrom(TABLE).where('id', '=', id).executeTakeFirst();
      return Number(result.numDeletedRows ?? 0) > 0;
    },
  };
}
