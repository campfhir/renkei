import type { Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import type { WebhookSubscriptionStore } from './types';

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
    async listForProvider(provider) {
      const rows = await db()
        .selectFrom('webhook_subscriptions')
        .select(['id', 'provider', 'account_id', 'resource', 'subscription_id', 'client_state'])
        .where('provider', '=', provider)
        .orderBy('account_id')
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
    async delete(id) {
      const result = await db()
        .deleteFrom('webhook_subscriptions')
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async listStale(provider, accountId, updatedBefore) {
      const rows = await db()
        .selectFrom('webhook_subscriptions')
        .select(['id', 'resource', 'subscription_id', 'client_state', 'expires_at', 'delta_link'])
        .where('provider', '=', provider)
        .where('account_id', '=', accountId)
        .where('updated_at', '<', updatedBefore)
        .orderBy('resource')
        .orderBy('id')
        .execute();
      return rows.map((row) => ({
        id: row.id,
        resource: row.resource,
        subscriptionId: row.subscription_id,
        clientState: row.client_state,
        expiresAt: row.expires_at ? new Date(row.expires_at) : null,
        deltaLink: row.delta_link,
      }));
    },
  };
}
