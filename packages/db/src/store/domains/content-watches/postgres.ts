import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { contentWatchFromRow, REBUILD_RESET } from './record';
import type { ContentWatchStore } from './types';

export function postgresContentWatches(db: () => Kysely<DB>): ContentWatchStore {
  return {
    async listForSubject(subject) {
      const rows = await db()
        .selectFrom('content_watches')
        .selectAll()
        .where('subject', '=', subject)
        .orderBy('scope_key', 'asc')
        .orderBy('provider')
        .orderBy('id')
        .execute();
      return rows.map(contentWatchFromRow);
    },
    async findForSubject(subject, provider, scopeKey) {
      const row = await db()
        .selectFrom('content_watches')
        .selectAll()
        .where('subject', '=', subject)
        .where('provider', '=', provider)
        .where('scope_key', '=', scopeKey)
        .orderBy('created_at')
        .orderBy('id')
        .executeTakeFirst();
      return row ? contentWatchFromRow(row) : null;
    },
    async resetForRebuild(id) {
      const result = await db()
        .updateTable('content_watches')
        .set({ ...REBUILD_RESET, updated_at: sql<Date>`NOW()` })
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
  };
}
