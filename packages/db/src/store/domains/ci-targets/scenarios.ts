import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { uid } from '../chats/fixtures';

const at = new Date('2026-11-01T10:00:00.000Z');
const fixture = {
  ci_targets: [
    {
      id: uid(1501),
      name: 'onprem-workers',
      description: 'Background workers',
      kind: 'runners',
      labels: { bitbucket: ['self.hosted', 'onprem-workers'], github: [] },
      created_by: 'ada@example.com',
      created_at: at,
      updated_at: at,
    },
    {
      id: uid(1502),
      name: 'onprem-app',
      description: null,
      kind: 'runners',
      labels: { bitbucket: ['self.hosted', 'onprem-app'], github: ['self-hosted', 'onprem-app'] },
      created_by: 'ada@example.com',
      created_at: at,
      updated_at: at,
    },
  ],
};
const code = (error: { code?: string }) => error.code ?? 'refused';
const labels = { bitbucket: [], github: ['self-hosted', 'build'] };

export const ciTargetScenarios: Scenario<DataStore>[] = [
  {
    method: 'ciTargets.list',
    name: 'by name',
    fixture,
    run: async (store) => store.ciTargets.list(),
  },
  {
    method: 'ciTargets.get',
    name: 'one, and none',
    fixture,
    run: async (store) => [await store.ciTargets.get(uid(1501)), await store.ciTargets.get(uid(1))],
  },
  {
    method: 'ciTargets.create',
    name: 'new, then a taken name refused',
    fixture,
    run: async (store) => {
      const id = await store.ciTargets.create({
        name: 'gh-build',
        description: null,
        kind: 'runners',
        labels,
        createdBy: 'ada@example.com',
      });
      const created = await store.ciTargets.get(id);
      const taken = await store.ciTargets
        .create({ name: 'onprem-app', description: null, kind: 'runners', labels, createdBy: 'a' })
        .then(() => 'accepted', code);
      return {
        created: { name: created?.name, labels: created?.labels, kind: created?.kind },
        taken,
      };
    },
  },
  {
    method: 'ciTargets.update',
    name: 'rewrite, missing, and a taken name refused',
    fixture,
    run: async (store) => [
      await store.ciTargets.update(uid(1501), {
        name: 'workers',
        description: null,
        kind: 'runners',
        labels,
      }),
      await store.ciTargets.update(uid(1), {
        name: 'x',
        description: null,
        kind: 'runners',
        labels,
      }),
      await store.ciTargets
        .update(uid(1501), { name: 'onprem-app', description: null, kind: 'runners', labels })
        .then(() => 'accepted', code),
      (await store.ciTargets.list()).map((t) => [t.name, t.labels]),
    ],
  },
  {
    method: 'ciTargets.delete',
    name: 'once',
    fixture,
    run: async (store) => [
      await store.ciTargets.delete(uid(1502)),
      await store.ciTargets.delete(uid(1502)),
      (await store.ciTargets.list()).map((t) => t.name),
    ],
  },
];
