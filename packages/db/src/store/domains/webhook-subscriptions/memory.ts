import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import type { WebhookSubscriptionStore } from './types';

export function memoryWebhookSubscriptions(tables: MemoryTables): WebhookSubscriptionStore {
  return {
    async listForAccount(provider, accountId) {
      const rows = tables.select(
        'webhook_subscriptions',
        (r) => r.provider === provider && r.account_id === accountId
      );
      return orderBy(rows, [(r) => r.resource], [(r) => r.id]).map((row) => ({
        id: row.id,
        provider: row.provider,
        accountId: row.account_id,
        resource: row.resource,
        subscriptionId: row.subscription_id,
        clientState: row.client_state,
      }));
    },
    async deleteForAccount(provider, accountId) {
      return tables.delete(
        'webhook_subscriptions',
        (r) => r.provider === provider && r.account_id === accountId
      ).length;
    },
    async listForProvider(provider) {
      const rows = tables.select('webhook_subscriptions', (r) => r.provider === provider);
      return orderBy(rows, [(r) => r.account_id], [(r) => r.resource], [(r) => r.id]).map(
        (row) => ({
          id: row.id,
          provider: row.provider,
          accountId: row.account_id,
          resource: row.resource,
          subscriptionId: row.subscription_id,
          clientState: row.client_state,
        })
      );
    },
    async delete(id) {
      const key = tables.param('webhook_subscriptions', 'id', id);
      return tables.delete('webhook_subscriptions', (r) => r.id === key).length;
    },
    async listStale(provider, accountId, updatedBefore) {
      const cutoff = updatedBefore.getTime();
      const rows = tables.select(
        'webhook_subscriptions',
        (r) =>
          r.provider === provider && r.account_id === accountId && r.updated_at.getTime() < cutoff
      );
      return orderBy(rows, [(r) => r.resource], [(r) => r.id]).map((row) => ({
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
