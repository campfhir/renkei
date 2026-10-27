import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-12${String(n).padStart(10, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const now = new Date(at(30));

function delegation(
  n: number,
  subject: string,
  instance: number,
  scope: string,
  created: number,
  expires: number,
  session: string | null = null
) {
  return {
    id: id(n),
    subject,
    instance_id: id(instance),
    scope,
    session_id: session,
    sealed_key: `sealed-${n}`,
    created_at: at(created),
    expires_at: at(expires),
  };
}

const fixture = {
  user_encryption_keys: [
    {
      subject: 'ann',
      salt: 's',
      mode: 'held',
      version: 2,
      public_key: 'pub-ann',
      wrapped_private_key: 'wp',
      wrapped_automation_key: 'wa',
      enrolled_at: at(1),
      verifier: 'v',
    },
    { subject: 'old', salt: 's', mode: 'managed' },
    { subject: 'bob', salt: 's', mode: 'held', public_key: 'pub-bob' },
  ],
  sessions: [
    { id: id(91), subject: 'ann', expires_at: at(60) },
    { id: id(92), subject: 'ann', expires_at: at(60) },
    { id: id(93), subject: 'bob', expires_at: at(60) },
  ],
  delegate_instances: [
    { id: id(1), public_key: 'i1', started_at: at(2), heartbeat_at: at(29) },
    { id: id(2), public_key: 'i2', started_at: at(1), heartbeat_at: at(29) },
    { id: id(3), public_key: 'i3', started_at: at(1), heartbeat_at: at(29) },
    { id: id(4), public_key: 'i4', started_at: at(0), heartbeat_at: at(10) },
  ],
  key_delegations: [
    delegation(11, 'ann', 1, 'session', 5, 60, id(91)),
    delegation(12, 'ann', 1, 'automation', 6, 90),
    delegation(13, 'ann', 1, 'automation', 6, 90),
    delegation(14, 'ann', 1, 'session', 7, 20, id(92)),
    delegation(15, 'ann', 2, 'session', 4, 60, id(91)),
    delegation(16, 'ann', 4, 'automation', 3, 60),
    delegation(17, 'bob', 1, 'session', 8, 60, id(93)),
  ],
};

export const userKeyScenarios: Scenario<DataStore>[] = [
  {
    method: 'userKeys.findKeyRow',
    name: 'held and legacy rows as stored; nobody reads null',
    fixture,
    run: async (store) => [
      await store.userKeys.findKeyRow('ann'),
      await store.userKeys.findKeyRow('old'),
      await store.userKeys.findKeyRow('nobody'),
    ],
  },
  {
    method: 'userKeys.liveDelegations',
    name: 'this instance, unexpired, newest first, ties by id descending',
    fixture,
    run: async (store) => [
      await store.userKeys.liveDelegations('ann', id(1), now),
      await store.userKeys.liveDelegations('ann', id(2), now),
      await store.userKeys.liveDelegations('ann', id(3), now),
      await store.userKeys.liveDelegations('bob', id(2), now),
    ],
  },
  {
    method: 'userKeys.delegationsOf',
    name: 'every unexpired delegation of the person, oldest first',
    fixture,
    run: async (store) => [
      await store.userKeys.delegationsOf('ann', now),
      await store.userKeys.delegationsOf('ann', new Date(at(70))),
      await store.userKeys.delegationsOf('nobody', now),
    ],
  },
  {
    method: 'userKeys.liveInstances',
    name: 'recent heartbeat only, by start time then id',
    fixture,
    run: async (store) => [
      await store.userKeys.liveInstances(new Date(at(28))),
      await store.userKeys.liveInstances(new Date(at(29))),
      await store.userKeys.liveInstances(new Date(at(0))),
    ],
  },
];
