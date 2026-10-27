import { orderBy } from '../../memory/order';
import type { MemoryTables } from '../../memory/tables';
import { providerPatchValues, syncStateFromRow } from './postgres';
import type { WebhookSubscriptionStore } from './types';

export function memoryWebhookSubscriptions(tables: MemoryTables): WebhookSubscriptionStore {
  const idOf = (id: string) => tables.param('webhook_subscriptions', 'id', id);
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
    async insertIfMissing(row) {
      const inserted = tables.upsert(
        'webhook_subscriptions',
        {
          id: row.id,
          provider: row.provider,
          account_id: row.accountId,
          resource: row.resource,
          client_state: row.clientState,
        },
        ['provider', 'account_id', 'resource']
      );
      return inserted !== undefined;
    },
    async listSyncStates(provider, accountId) {
      const rows = tables.select(
        'webhook_subscriptions',
        (r) => r.provider === provider && r.account_id === accountId
      );
      return orderBy(rows, [(r) => r.resource], [(r) => r.id]).map(syncStateFromRow);
    },
    async findSyncStateBySubscriptionId(provider, accountId, subscriptionId) {
      const rows = tables.select(
        'webhook_subscriptions',
        (r) =>
          r.provider === provider &&
          r.account_id === accountId &&
          r.subscription_id === subscriptionId
      );
      const [row] = orderBy(rows, [(r) => r.id]);
      return row ? syncStateFromRow(row) : null;
    },
    async setProviderSubscription(id, patch) {
      const key = idOf(id);
      tables.update('webhook_subscriptions', (r) => r.id === key, {
        ...providerPatchValues(patch),
        updated_at: new Date(),
      });
    },
    async setProviderSubscriptionBySubscriptionId(provider, subscriptionId, patch) {
      return tables.update(
        'webhook_subscriptions',
        (r) => r.provider === provider && r.subscription_id === subscriptionId,
        { ...providerPatchValues(patch), updated_at: new Date() }
      ).length;
    },
    async restartDelta(id) {
      const key = idOf(id);
      tables.update('webhook_subscriptions', (r) => r.id === key, {
        delta_link: null,
        sync_status: 'syncing',
        updated_at: new Date(),
      });
    },
    async recordDeltaRound(id, round) {
      const key = idOf(id);
      const now = new Date();
      tables.update(
        'webhook_subscriptions',
        (r) => r.id === key,
        (r) => ({
          delta_link: round.cursor,
          last_synced_at: now,
          last_run_items: round.changed,
          total_items: r.total_items + round.changed,
          sync_status: round.syncStatus,
          updated_at: now,
        })
      );
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
