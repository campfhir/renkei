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
  };
}
