import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

function row(n: number, pattern: string, credential = false) {
  return {
    id: id(n),
    pattern,
    note: n % 2 ? `note ${n}` : null,
    registry_username: credential ? `user-${n}` : null,
    registry_sealed: credential ? `reg1.sealed-${n}` : null,
    created_at: at(n),
    updated_at: at(n),
  };
}

const fixture = {
  code_service_image_rules: [
    row(1, 'postgres:*'),
    row(2, 'ghcr.io/acme/*', true),
    row(3, 'Redis:*'),
  ],
};

export const codeServiceImageRuleScenarios: Scenario<DataStore>[] = [
  {
    method: 'codeServiceImageRules.list',
    name: 'by pattern',
    fixture,
    run: (store) => store.codeServiceImageRules.list(),
  },
  {
    method: 'codeServiceImageRules.list',
    name: 'none',
    run: (store) => store.codeServiceImageRules.list(),
  },
  {
    method: 'codeServiceImageRules.count',
    name: 'every rule',
    fixture,
    run: async (store) => store.codeServiceImageRules.count(),
  },
  {
    method: 'codeServiceImageRules.listForMatching',
    name: 'with the sealed credential, by pattern',
    fixture,
    run: (store) => store.codeServiceImageRules.listForMatching(),
  },
  {
    method: 'codeServiceImageRules.insert',
    name: 'a new pattern, read back',
    fixture,
    run: async (store) => {
      const {
        createdAt: _c,
        updatedAt: _u,
        ...inserted
      } = await store.codeServiceImageRules.insert({
        id: id(9),
        pattern: 'mysql:*',
        note: null,
        registryUsername: 'me',
        registrySealed: 'reg1.x',
      });
      return [inserted, await store.codeServiceImageRules.listForMatching()];
    },
  },
  {
    method: 'codeServiceImageRules.insert',
    name: 'a pattern already held is refused',
    fixture,
    run: (store) =>
      store.codeServiceImageRules
        .insert({
          pattern: 'postgres:*',
          note: null,
          registryUsername: null,
          registrySealed: null,
        })
        .catch((error: { code?: string }) => error.code ?? 'error'),
  },
  {
    method: 'codeServiceImageRules.update',
    name: 'pattern and note; credential replaced, cleared or kept',
    fixture,
    run: async (store) => [
      await store.codeServiceImageRules.update({
        id: id(1),
        pattern: 'postgres:16*',
        note: 'pinned',
        updatedAt: new Date(at(30)),
        credential: { registryUsername: 'u', registrySealed: 'reg1.u' },
      }),
      await store.codeServiceImageRules.update({
        id: id(2),
        pattern: 'ghcr.io/acme/*',
        note: null,
        updatedAt: new Date(at(31)),
        credential: null,
      }),
      await store.codeServiceImageRules.update({
        id: id(3),
        pattern: 'redis:*',
        note: null,
        updatedAt: new Date(at(32)),
      }),
      await store.codeServiceImageRules.update({
        id: id(99),
        pattern: 'gone:*',
        note: null,
        updatedAt: new Date(at(33)),
      }),
      await store.codeServiceImageRules.listForMatching(),
    ],
  },
  {
    method: 'codeServiceImageRules.update',
    name: 'onto a pattern already held is refused',
    fixture,
    run: (store) =>
      store.codeServiceImageRules
        .update({
          id: id(1),
          pattern: 'Redis:*',
          note: null,
          updatedAt: new Date(at(30)),
        })
        .catch((error: { code?: string }) => error.code ?? 'error'),
  },
  {
    method: 'codeServiceImageRules.delete',
    name: 'whether there was one',
    fixture,
    run: async (store) => [
      await store.codeServiceImageRules.delete(id(1)),
      await store.codeServiceImageRules.delete(id(1)),
      await store.codeServiceImageRules.count(),
    ],
  },
  {
    method: 'codeServiceImageRules.insertMissing',
    name: 'only the patterns missing',
    fixture,
    run: async (store) => [
      await store.codeServiceImageRules.insertMissing([
        { pattern: 'postgres:*', note: 'default' },
        { pattern: 'node:*', note: 'default' },
        { pattern: 'python:*', note: null },
      ]),
      (await store.codeServiceImageRules.list()).map((rule) => [rule.pattern, rule.note]),
    ],
  },
];
