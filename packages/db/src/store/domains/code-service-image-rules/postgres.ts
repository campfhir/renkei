import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { imageRuleFromRow, imageRuleMatchFromRow, imageRulePatch, imageRuleValues } from './record';
import type { CodeServiceImageRuleStore } from './types';

export function postgresCodeServiceImageRules(db: () => Kysely<DB>): CodeServiceImageRuleStore {
  return {
    async list() {
      const rows = await db()
        .selectFrom('code_service_image_rules')
        .selectAll()
        .orderBy('pattern')
        .execute();
      return rows.map(imageRuleFromRow);
    },
    async count() {
      const row = await db()
        .selectFrom('code_service_image_rules')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .executeTakeFirst();
      return row?.count ? Number(row.count) : 0;
    },
    async listForMatching() {
      const rows = await db()
        .selectFrom('code_service_image_rules')
        .selectAll()
        .orderBy('pattern')
        .execute();
      return rows.map(imageRuleMatchFromRow);
    },
    async insert(rule) {
      const row = await db()
        .insertInto('code_service_image_rules')
        .values(imageRuleValues(rule))
        .returningAll()
        .executeTakeFirstOrThrow();
      return imageRuleFromRow(row);
    },
    async update(rule) {
      const row = await db()
        .updateTable('code_service_image_rules')
        .set(imageRulePatch(rule))
        .where('id', '=', rule.id)
        .returningAll()
        .executeTakeFirst();
      return row ? imageRuleFromRow(row) : null;
    },
    async delete(id) {
      const result = await db()
        .deleteFrom('code_service_image_rules')
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0) > 0;
    },
    async insertMissing(rules) {
      let added = 0;
      for (const rule of rules) {
        const result = await db()
          .insertInto('code_service_image_rules')
          .values({ pattern: rule.pattern, note: rule.note })
          .onConflict((oc) => oc.columns(['pattern']).doNothing())
          .executeTakeFirst();
        added += Number(result.numInsertedOrUpdatedRows ?? 0);
      }
      return added;
    },
  };
}
