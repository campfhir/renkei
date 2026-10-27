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
    async watch(owner, { provider, scopeType, scopeKey, scopeLabel }) {
      const existing = await db()
        .selectFrom('content_watches')
        .select(['id', 'enabled'])
        .where('provider', '=', provider)
        .where('subject', '=', owner.subject)
        .where('scope_type', '=', scopeType)
        .where('scope_key', '=', scopeKey)
        .executeTakeFirst();

      if (existing) {
        await db()
          .updateTable('content_watches')
          .set({
            enabled: true,
            scope_label: scopeLabel,
            last_error: null,
            sync_status: 'idle',
            account_id: owner.accountId,
            updated_at: sql<Date>`NOW()`,
          })
          .where('id', '=', existing.id)
          .execute();
        return { created: !existing.enabled };
      }

      const sibling = await db()
        .selectFrom('content_watches')
        .select('cursor')
        .where('provider', '=', provider)
        .where('scope_type', '=', scopeType)
        .where('scope_key', '=', scopeKey)
        .where('cursor', 'is not', null)
        .orderBy('updated_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();

      await db()
        .insertInto('content_watches')
        .values({
          id: globalThis.crypto.randomUUID(),
          provider,
          account_id: owner.accountId,
          subject: owner.subject,
          scope_type: scopeType,
          scope_key: scopeKey,
          scope_label: scopeLabel,
          cursor: sibling?.cursor ?? null,
        })
        .execute();
      return { created: true };
    },
    async repair(owner, { provider, scopeType, scopeKey }) {
      const result = await db()
        .updateTable('content_watches')
        .set({
          subject: owner.subject,
          account_id: owner.accountId,
          enabled: true,
          last_error: null,
          sync_status: 'idle',
          last_synced_at: null,
          updated_at: sql<Date>`NOW()`,
        })
        .where('provider', '=', provider)
        .where('scope_type', '=', scopeType)
        .where('scope_key', '=', scopeKey)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async disable(subject, { provider, scopeType, scopeKey }) {
      const result = await db()
        .updateTable('content_watches')
        .set({ enabled: false, sync_status: 'idle', updated_at: sql<Date>`NOW()` })
        .where('provider', '=', provider)
        .where('subject', '=', subject)
        .where('scope_type', '=', scopeType)
        .where('scope_key', '=', scopeKey)
        .where('enabled', '=', true)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async list(subject, provider) {
      const rows = await db()
        .selectFrom('content_watches')
        .selectAll()
        .where('provider', '=', provider)
        .where('subject', '=', subject)
        .orderBy('scope_key', 'asc')
        .orderBy('scope_type', 'asc')
        .orderBy('id', 'asc')
        .execute();
      return rows.map(contentWatchFromRow);
    },
    async objectCounts(provider, metadataKey) {
      // GROUP BY the output ALIAS, never a repeat of the expression: each
      // `${metadataKey}` becomes its own bound parameter, so Postgres sees
      // `->> $2` against `->> $3`, calls them different expressions, and
      // rejects the query. Naming it once removes the possibility.
      const indexed = await db()
        .selectFrom('knowledge_chunks')
        .select([
          sql<string | null>`metadata ->> ${metadataKey}`.as('scope'),
          sql<string>`count(DISTINCT split_part(ref_id, '#', 1))`.as('objects'),
        ])
        .where('provider', '=', provider)
        .groupBy(sql`scope`)
        .orderBy(sql`scope`)
        .execute();
      const queued = await db()
        .selectFrom('embedding_jobs')
        .select([
          sql<string | null>`payload -> 'metadata' ->> ${metadataKey}`.as('scope'),
          sql<string>`count(*)`.as('objects'),
        ])
        .where('status', '=', 'pending')
        .where(sql<boolean>`payload ->> 'provider' = ${provider}`)
        .groupBy(sql`scope`)
        .orderBy(sql`scope`)
        .execute();
      const counts = (rows: { scope: string | null; objects: string }[]) =>
        rows.map((row) => ({ scope: row.scope, objects: Number(row.objects) }));
      return { indexed: counts(indexed), queued: counts(queued) };
    },
    async listDue(dueBefore, limit) {
      const rows = await db()
        .selectFrom('content_watches')
        .select([
          'id',
          'provider',
          'account_id',
          'scope_type',
          'scope_key',
          'scope_label',
          'cursor',
          'last_synced_at',
        ])
        .where('enabled', '=', true)
        // Never-synced rows (NULL) come first — a watch just created should
        // start indexing without waiting out a full interval.
        .where((eb) =>
          eb.or([eb('last_synced_at', 'is', null), eb('last_synced_at', '<', dueBefore)])
        )
        .orderBy('last_synced_at', (ob) => ob.asc().nullsFirst())
        .orderBy('id')
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        accountId: row.account_id,
        scopeType: row.scope_type,
        scopeKey: row.scope_key,
        scopeLabel: row.scope_label,
        cursor: row.cursor,
        lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at) : null,
      }));
    },
    async recordSyncFailure(id, message) {
      await db()
        .updateTable('content_watches')
        .set({
          sync_status: 'error',
          last_error: message,
          last_synced_at: sql<Date>`NOW()`,
          updated_at: sql<Date>`NOW()`,
        })
        .where('id', '=', id)
        .execute();
    },
  };
}
