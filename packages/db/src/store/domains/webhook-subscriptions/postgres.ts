import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type {
  WebhookSubscriptionProviderPatch,
  WebhookSubscriptionStore,
  WebhookSubscriptionSyncRecord,
} from './types';

export const SYNC_COLUMNS = [
  'id',
  'resource',
  'subscription_id',
  'client_state',
  'expires_at',
  'delta_link',
  'sync_status',
  'last_synced_at',
  'last_run_items',
  'total_items',
] as const;

export function syncStateFromRow(row: {
  id: string;
  resource: string;
  subscription_id: string | null;
  client_state: string;
  expires_at: Date | null;
  delta_link: string | null;
  sync_status: string;
  last_synced_at: Date | null;
  last_run_items: number;
  total_items: number;
}): WebhookSubscriptionSyncRecord {
  return {
    id: row.id,
    resource: row.resource,
    subscriptionId: row.subscription_id,
    clientState: row.client_state,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    deltaLink: row.delta_link,
    syncStatus: row.sync_status,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at) : null,
    lastRunItems: row.last_run_items,
    totalItems: row.total_items,
  };
}

/** The columns a provider patch sets; absent fields stay. */
export function providerPatchValues(patch: WebhookSubscriptionProviderPatch): {
  subscription_id?: string | null;
  expires_at?: Date | null;
} {
  return {
    ...(patch.subscriptionId !== undefined ? { subscription_id: patch.subscriptionId } : {}),
    ...(patch.expiresAt !== undefined ? { expires_at: patch.expiresAt } : {}),
  };
}

export function postgresWebhookSubscriptions(db: () => Kysely<DB>): WebhookSubscriptionStore {
  return {
    async listForAccount(provider, accountId) {
      const rows = await db()
        .selectFrom('webhook_subscriptions')
        .select(['id', 'provider', 'account_id', 'resource', 'subscription_id', 'client_state'])
        .where('provider', '=', provider)
        .where('account_id', '=', accountId)
        .orderBy('resource')
        .orderBy('id')
        .execute();
      return rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        accountId: row.account_id,
        resource: row.resource,
        subscriptionId: row.subscription_id,
        clientState: row.client_state,
      }));
    },
    async deleteForAccount(provider, accountId) {
      const result = await db()
        .deleteFrom('webhook_subscriptions')
        .where('provider', '=', provider)
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async insertIfMissing(row) {
      const inserted = await db()
        .insertInto('webhook_subscriptions')
        .values({
          id: row.id,
          provider: row.provider,
          account_id: row.accountId,
          resource: row.resource,
          client_state: row.clientState,
        })
        .onConflict((oc) => oc.columns(['provider', 'account_id', 'resource']).doNothing())
        .returning('id')
        .executeTakeFirst();
      return inserted !== undefined;
    },
    async listSyncStates(provider, accountId) {
      const rows = await db()
        .selectFrom('webhook_subscriptions')
        .select(SYNC_COLUMNS)
        .where('provider', '=', provider)
        .where('account_id', '=', accountId)
        .orderBy('resource')
        .orderBy('id')
        .execute();
      return rows.map(syncStateFromRow);
    },
    async findSyncStateBySubscriptionId(provider, accountId, subscriptionId) {
      const row = await db()
        .selectFrom('webhook_subscriptions')
        .select(SYNC_COLUMNS)
        .where('provider', '=', provider)
        .where('account_id', '=', accountId)
        .where('subscription_id', '=', subscriptionId)
        .orderBy('id')
        .executeTakeFirst();
      return row ? syncStateFromRow(row) : null;
    },
    async setProviderSubscription(id, patch) {
      await db()
        .updateTable('webhook_subscriptions')
        .set({ ...providerPatchValues(patch), updated_at: sql`NOW()` })
        .where('id', '=', id)
        .execute();
    },
    async setProviderSubscriptionBySubscriptionId(provider, subscriptionId, patch) {
      const result = await db()
        .updateTable('webhook_subscriptions')
        .set({ ...providerPatchValues(patch), updated_at: sql`NOW()` })
        .where('provider', '=', provider)
        .where('subscription_id', '=', subscriptionId)
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0);
    },
    async restartDelta(id) {
      await db()
        .updateTable('webhook_subscriptions')
        .set({ delta_link: null, sync_status: 'syncing', updated_at: sql`NOW()` })
        .where('id', '=', id)
        .execute();
    },
    async recordDeltaRound(id, round) {
      await db()
        .updateTable('webhook_subscriptions')
        .set({
          delta_link: round.cursor,
          last_synced_at: sql<Date>`NOW()`,
          last_run_items: round.changed,
          total_items: sql<number>`total_items + ${round.changed}`,
          sync_status: round.syncStatus,
          updated_at: sql`NOW()`,
        })
        .where('id', '=', id)
        .execute();
    },
  };
}
