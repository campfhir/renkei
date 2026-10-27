import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { PlatformSettingStore } from './types';

export function postgresPlatformSettings(db: () => Kysely<DB>): PlatformSettingStore {
  return {
    async get(key) {
      const row = await db()
        .selectFrom('platform_settings')
        .select('value')
        .where('key', '=', key)
        .executeTakeFirst();
      return row ? { value: row.value } : null;
    },
    async insertIfAbsent(key, value) {
      const inserted = await db()
        .insertInto('platform_settings')
        .values({ key, value: JSON.stringify(value) })
        .onConflict((oc) => oc.column('key').doNothing())
        .returning('key')
        .executeTakeFirst();
      return inserted !== undefined;
    },
  };
}
