import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { UserPreferenceStore } from './types';

export function postgresUserPreferences(db: () => Kysely<DB>): UserPreferenceStore {
  return {
    async get(subject, key) {
      const row = await db()
        .selectFrom('user_preferences')
        .select('value')
        .where('subject', '=', subject)
        .where('key', '=', key)
        .executeTakeFirst();
      return row?.value;
    },
    async set(subject, key, value) {
      const now = new Date().toISOString();
      const json = JSON.stringify(value);
      await db()
        .insertInto('user_preferences')
        .values({ subject, key, value: json, updated_at: now })
        .onConflict((oc) =>
          oc.columns(['subject', 'key']).doUpdateSet({ value: json, updated_at: now })
        )
        .execute();
    },
    async merge(subject, key, patch) {
      const now = new Date().toISOString();
      const json = JSON.stringify(patch);
      // One statement: the merge happens on the stored row, so two patches
      // of different fields landing together both survive.
      await db()
        .insertInto('user_preferences')
        .values({ subject, key, value: json, updated_at: now })
        .onConflict((oc) =>
          oc.columns(['subject', 'key']).doUpdateSet({
            value: sql`CASE WHEN jsonb_typeof(user_preferences.value) = 'object'
              THEN user_preferences.value || excluded.value
              ELSE excluded.value END`,
            updated_at: now,
          })
        )
        .execute();
    },
    async delete(subject, key) {
      await db()
        .deleteFrom('user_preferences')
        .where('subject', '=', subject)
        .where('key', '=', key)
        .execute();
    },
    async listBySubject(subject) {
      return db()
        .selectFrom('user_preferences')
        .select(['key', 'value'])
        .where('subject', '=', subject)
        .orderBy('key')
        .execute();
    },
    async listByKey(key) {
      return db()
        .selectFrom('user_preferences')
        .select(['subject', 'value'])
        .where('key', '=', key)
        .orderBy('subject')
        .execute();
    },
  };
}
