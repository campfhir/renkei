import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { ContentWatchRecord, ContentWatchStore } from './types';

export function watchFromRow(row: {
  provider: string;
  scope_type: string;
  scope_key: string;
  scope_label: string | null;
  enabled: boolean;
  last_synced_at: Date | null;
  last_run_items: number;
  total_items: number;
  sync_status: string;
  last_error: string | null;
}): ContentWatchRecord {
  return {
    provider: row.provider,
    scopeType: row.scope_type,
    scopeKey: row.scope_key,
    scopeLabel: row.scope_label,
    enabled: row.enabled,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at) : null,
    lastRunItems: row.last_run_items,
    totalItems: row.total_items,
    syncStatus: row.sync_status,
    lastError: row.last_error,
  };
}

export function postgresContentWatches(db: () => Kysely<DB>): ContentWatchStore {
  return {
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
          id: randomUUID(),
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
        .select([
          'provider',
          'scope_type',
          'scope_key',
          'scope_label',
          'enabled',
          'last_synced_at',
          'last_run_items',
          'total_items',
          'sync_status',
          'last_error',
        ])
        .where('provider', '=', provider)
        .where('subject', '=', subject)
        .orderBy('scope_key', 'asc')
        .orderBy('scope_type', 'asc')
        .execute();
      return rows.map(watchFromRow);
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
  };
}
