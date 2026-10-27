import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

function row(n: number, subject: string, name: string) {
  return {
    id: id(n),
    subject,
    name,
    sealed: `env1.${n}`,
    created_at: at(n).toISOString(),
    updated_at: at(n).toISOString(),
    last_used_at: null,
  };
}

const fixture = {
  sandbox_env_secrets: [
    row(1, 'ann', 'TOKEN'),
    row(2, 'ann', 'api_key'),
    row(3, 'ann', 'DB_URL'),
    row(4, 'bob', 'TOKEN'),
  ],
};

export const sandboxEnvSecretScenarios: Scenario<DataStore>[] = [
  {
    method: 'sandboxEnvSecrets.upsert',
    name: 'a new name inserts; a held name replaces the value',
    fixture,
    run: async (store) => {
      const {
        createdAt: _c,
        updatedAt: _u,
        ...created
      } = await store.sandboxEnvSecrets.upsert({
        id: id(9),
        subject: 'ann',
        name: 'NEW',
        sealed: 'env1.new',
        updatedAt: at(40),
      });
      const replaced = await store.sandboxEnvSecrets.upsert({
        id: id(10),
        subject: 'ann',
        name: 'TOKEN',
        sealed: 'env1.replaced',
        updatedAt: at(50),
      });
      return [
        created,
        replaced,
        await store.sandboxEnvSecrets.listSealed('ann'),
        await store.sandboxEnvSecrets.listSealed('bob'),
      ];
    },
  },
  {
    method: 'sandboxEnvSecrets.list',
    name: 'by name, the subject’s only',
    fixture,
    run: async (store) => [
      await store.sandboxEnvSecrets.list('ann'),
      await store.sandboxEnvSecrets.list('nobody'),
    ],
  },
  {
    method: 'sandboxEnvSecrets.count',
    name: 'per subject',
    fixture,
    run: async (store) => [
      await store.sandboxEnvSecrets.count('ann'),
      await store.sandboxEnvSecrets.count('nobody'),
    ],
  },
  {
    method: 'sandboxEnvSecrets.has',
    name: 'the subject’s own names only, exactly',
    fixture,
    run: async (store) => [
      await store.sandboxEnvSecrets.has('ann', 'TOKEN'),
      await store.sandboxEnvSecrets.has('ann', 'token'),
      await store.sandboxEnvSecrets.has('bob', 'DB_URL'),
    ],
  },
  {
    method: 'sandboxEnvSecrets.listSealed',
    name: 'by name',
    fixture,
    run: async (store) => [
      await store.sandboxEnvSecrets.listSealed('ann'),
      await store.sandboxEnvSecrets.listSealed('nobody'),
    ],
  },
  {
    method: 'sandboxEnvSecrets.touchUsed',
    name: 'every id given, nothing for none',
    fixture,
    run: async (store) => {
      await store.sandboxEnvSecrets.touchUsed([id(1), id(4)], at(60));
      await store.sandboxEnvSecrets.touchUsed([], at(70));
      return [await store.sandboxEnvSecrets.list('ann'), await store.sandboxEnvSecrets.list('bob')];
    },
  },
  {
    method: 'sandboxEnvSecrets.delete',
    name: 'by name, the subject’s own only',
    fixture,
    run: async (store) => [
      await store.sandboxEnvSecrets.delete('bob', 'DB_URL'),
      await store.sandboxEnvSecrets.delete('ann', 'DB_URL'),
      await store.sandboxEnvSecrets.delete('ann', 'DB_URL'),
      await store.sandboxEnvSecrets.count('ann'),
      await store.sandboxEnvSecrets.count('bob'),
    ],
  },
];
