import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { SettingsStore } from './types';

export function postgresSettings(db: () => Kysely<DB>): SettingsStore {
  return {
    async all() {
      const rows = await db()
        .selectFrom('settings')
        .select(['key', 'value'])
        .orderBy('key')
        .execute();
      return new Map<string, unknown>(rows.map((row) => [row.key, row.value]));
    },
    async get(key) {
      const row = await db()
        .selectFrom('settings')
        .select('value')
        .where('key', '=', key)
        .executeTakeFirst();
      return row?.value;
    },
    async set(key, value) {
      const now = new Date().toISOString();
      const json = JSON.stringify(value);
      await db()
        .insertInto('settings')
        .values({ key, value: json, updated_at: now })
        .onConflict((oc) => oc.columns(['key']).doUpdateSet({ value: json, updated_at: now }))
        .execute();
    },
  };
}
