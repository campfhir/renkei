/**
 * The data-store contract against a real, migrated Postgres (skipped
 * without DATABASE_URL; `pnpm --filter @renkei/db migrate` first). This is
 * what keeps the memory store honest: the same cases, the real database.
 */

import { getDatabase, closeDatabase } from '../client';
import { describeDataStoreContract } from './contract';
import { createPostgresDataStore } from './postgres';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('postgres', () => {
  describeDataStoreContract(
    'postgres',
    async () => {
      const db = getDatabase();
      if (!db.ok) throw new Error(db.err.type);
      const kysely = db.val;
      return {
        store: createPostgresDataStore(() => kysely),
        async cleanup({ subjects, settingKeys }) {
          if (subjects.length > 0) {
            for (const table of [
              'sessions',
              'identities',
              'user_preferences',
              'coach_mark_progress',
              'agent_notifications',
            ] as const) {
              await kysely.deleteFrom(table).where('subject', 'in', subjects).execute();
            }
          }
          if (settingKeys.length > 0) {
            await kysely.deleteFrom('settings').where('key', 'in', settingKeys).execute();
          }
        },
      };
    },
    closeDatabase
  );
});
