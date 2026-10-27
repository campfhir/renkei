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
];
