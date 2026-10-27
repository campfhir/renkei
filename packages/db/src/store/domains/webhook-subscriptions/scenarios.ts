import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function subscription(n: number, account: string, resource: string, subscriptionId: string | null) {
  return {
    id: id(n),
    provider: n === 6 ? 'zoom' : 'microsoft',
    account_id: account,
    resource,
    subscription_id: subscriptionId,
    client_state: `state-${n}`,
    subject: 'ann',
  };
}

const fixture = {
  webhook_subscriptions: [
    subscription(3, 'acct-a', 'me/messages', 'sub-3'),
    subscription(1, 'acct-a', 'me/events', 'sub-1'),
    subscription(2, 'acct-a', 'me/contacts', null),
    subscription(4, 'acct-b', 'me/messages', 'sub-4'),
    subscription(6, 'acct-a', 'me/messages', 'sub-6'),
  ],
};

export const webhookSubscriptionScenarios: Scenario<DataStore>[] = [
  {
    method: 'webhookSubscriptions.listForAccount',
    name: 'one account on one provider, by resource then id',
    fixture,
    run: async (store) => [
      await store.webhookSubscriptions.listForAccount('microsoft', 'acct-a'),
      await store.webhookSubscriptions.listForAccount('microsoft', 'acct-b'),
      await store.webhookSubscriptions.listForAccount('zoom', 'acct-a'),
      await store.webhookSubscriptions.listForAccount('microsoft', 'nobody'),
    ],
  },
  {
    method: 'webhookSubscriptions.deleteForAccount',
    name: 'that account on that provider only',
    fixture,
    run: async (store) => [
      await store.webhookSubscriptions.deleteForAccount('microsoft', 'acct-a'),
      await store.webhookSubscriptions.deleteForAccount('microsoft', 'acct-a'),
      await store.webhookSubscriptions.listForAccount('microsoft', 'acct-a'),
      (await store.webhookSubscriptions.listForAccount('microsoft', 'acct-b')).map((s) => s.id),
      (await store.webhookSubscriptions.listForAccount('zoom', 'acct-a')).map((s) => s.id),
    ],
  },
  {
    method: 'webhookSubscriptions.listForProvider',
    name: 'every account on one provider, by account, resource, id; none',
    fixture,
    run: async (store) => [
      await store.webhookSubscriptions.listForProvider('microsoft'),
      await store.webhookSubscriptions.listForProvider('nobody'),
    ],
  },
  {
    method: 'webhookSubscriptions.delete',
    name: 'one row by id; unknown ids delete nothing; malformed refused',
    fixture,
    run: async (store) => [
      await store.webhookSubscriptions.delete(id(1)),
      await store.webhookSubscriptions.delete(id(1)),
      await store.webhookSubscriptions.delete(id(99)),
      (await store.webhookSubscriptions.listForAccount('microsoft', 'acct-a')).map((s) => s.id),
      await store.webhookSubscriptions
        .delete('nope')
        .catch((error: { code?: string }) => error.code),
    ],
  },
  {
    method: 'webhookSubscriptions.listStale',
    name: 'one account, untouched since the cutoff, by resource then id',
    fixture: {
      webhook_subscriptions: [
        {
          ...subscription(3, 'acct-a', 'me/messages', 'sub-3'),
          updated_at: '2026-01-01T00:00:00Z',
        },
        {
          ...subscription(1, 'acct-a', 'me/events', 'sub-1'),
          updated_at: '2026-01-01T00:00:00Z',
          expires_at: '2026-01-03T00:00:00Z',
          delta_link: 'https://graph.test/delta?token=1',
        },
        { ...subscription(2, 'acct-a', 'me/contacts', null), updated_at: '2026-02-01T00:00:00Z' },
        {
          ...subscription(4, 'acct-b', 'me/messages', 'sub-4'),
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    },
    run: async (store) => [
      await store.webhookSubscriptions.listStale(
        'microsoft',
        'acct-a',
        new Date('2026-01-15T00:00:00Z')
      ),
      await store.webhookSubscriptions.listStale('microsoft', 'acct-a', new Date('2025-01-01')),
    ],
  },
];
