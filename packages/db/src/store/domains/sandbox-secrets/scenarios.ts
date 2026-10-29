import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

function row(n: number, subject: string, name: string, expires: number) {
  return {
    id: id(n),
    subject,
    name,
    field_names: ['username', 'password'],
    hosts: n === 1 ? ['example.com', 7] : ['*.test'],
    sealed: `sealed-${n}`,
    created_at: at(n),
    expires_at: at(expires),
    last_used_at: n === 2 ? at(20) : null,
  };
}

const fixture = {
  sandbox_secrets: [
    row(1, 'ann', 'mirth', 105),
    row(2, 'ann', 'Admin', 103),
    row(3, 'ann', 'beta', 103),
    row(4, 'bob', 'mirth', 101),
  ],
};

export const sandboxSecretScenarios: Scenario<DataStore>[] = [
  {
    method: 'sandboxSecrets.insert',
    name: 'stores the sealed blob, read back by name',
    fixture,
    run: async (store) => {
      const { createdAt: _c, ...inserted } = await store.sandboxSecrets.insert({
        id: id(9),
        subject: 'ann',
        name: 'zeta',
        fields: ['token'],
        hosts: ['api.test'],
        sealed: 'sealed-9',
        expiresAt: at(300),
      });
      return [inserted, (await store.sandboxSecrets.getByName('ann', 'zeta'))?.id];
    },
  },
  {
    method: 'sandboxSecrets.list',
    name: 'by name, non-strings dropped from the arrays',
    fixture,
    run: async (store) => [
      await store.sandboxSecrets.list('ann'),
      await store.sandboxSecrets.list('nobody'),
    ],
  },
  {
    method: 'sandboxSecrets.count',
    name: 'per subject',
    fixture,
    run: async (store) => [
      await store.sandboxSecrets.count('ann'),
      await store.sandboxSecrets.count('nobody'),
    ],
  },
  {
    method: 'sandboxSecrets.get',
    name: 'the subject’s own only',
    fixture,
    run: async (store) => [
      await store.sandboxSecrets.get('ann', id(1)),
      await store.sandboxSecrets.get('bob', id(1)),
    ],
  },
  {
    method: 'sandboxSecrets.getByName',
    name: 'the subject’s own only',
    fixture,
    run: async (store) => [
      (await store.sandboxSecrets.getByName('bob', 'mirth'))?.id,
      await store.sandboxSecrets.getByName('bob', 'beta'),
    ],
  },
  {
    method: 'sandboxSecrets.touchUsed',
    name: 'stamps one row',
    fixture,
    run: async (store) => {
      await store.sandboxSecrets.touchUsed(id(3), at(40));
      return (await store.sandboxSecrets.list('ann')).map((s) => [s.id, s.lastUsedAt]);
    },
  },
  {
    method: 'sandboxSecrets.delete',
    name: 'the subject’s own only',
    fixture,
    run: async (store) => [
      await store.sandboxSecrets.delete('bob', id(1)),
      await store.sandboxSecrets.delete('ann', id(1)),
      await store.sandboxSecrets.count('ann'),
    ],
  },
  {
    method: 'sandboxSecrets.listExpiredIds',
    name: 'soonest first, ties by id, bounded',
    fixture,
    run: async (store) => [
      await store.sandboxSecrets.listExpiredIds(at(104), 10),
      await store.sandboxSecrets.listExpiredIds(at(200), 2),
      await store.sandboxSecrets.listExpiredIds(at(0), 10),
    ],
  },
  {
    method: 'sandboxSecrets.deleteById',
    name: 'whoever holds it',
    fixture,
    run: async (store) => {
      await store.sandboxSecrets.deleteById(id(4));
      return [await store.sandboxSecrets.count('bob'), await store.sandboxSecrets.count('ann')];
    },
  },
];
