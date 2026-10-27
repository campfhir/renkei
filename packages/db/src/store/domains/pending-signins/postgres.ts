import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { pendingSigninFromRow, pendingSigninValues } from './record';
import type { PendingSigninStore } from './types';

export function postgresPendingSignins(db: () => Kysely<DB>): PendingSigninStore {
  return {
    async create(pending) {
      await db().insertInto('pending_oidc_signin').values(pendingSigninValues(pending)).execute();
    },
    async findByState(state) {
      const row = await db()
        .selectFrom('pending_oidc_signin')
        .selectAll()
        .where('state', '=', state)
        .orderBy('id')
        .executeTakeFirst();
      return row ? pendingSigninFromRow(row) : null;
    },
    async deleteByState(state) {
      const result = await db()
        .deleteFrom('pending_oidc_signin')
        .where('state', '=', state)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
  };
}
