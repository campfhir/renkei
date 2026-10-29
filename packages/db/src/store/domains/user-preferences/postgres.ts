import type { Kysely } from 'kysely';
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
    async delete(subject, key) {
      await db()
        .deleteFrom('user_preferences')
        .where('subject', '=', subject)
        .where('key', '=', key)
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
