import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

function row(n: number, subject: string, name: string, expires: number, container: string | null) {
  return {
    id: id(n),
    subject,
    name,
    image: 'postgres:16',
    container_id: container,
    status: 'running',
    error: null,
    host: container ? `10.0.0.${n}` : null,
    ports: JSON.stringify(n === 1 ? [5432, 'x', 1.5] : [5432]),
    exports: JSON.stringify(n === 1 ? { DATABASE_URL: 'postgres://{host}', bad: 3 } : {}),
    created_at: at(n).toISOString(),
    last_used_at: at(n).toISOString(),
    expires_at: at(expires).toISOString(),
  };
}

const fixture = {
  sandbox_services: [
    row(1, 'ann', 'db', 105, 'c-b'),
    row(2, 'ann', 'cache', 103, null),
    row(3, 'ann', 'Broker', 103, 'c-a'),
    row(4, 'bob', 'db', 101, 'c-c'),
  ],
};

export const sandboxServiceScenarios: Scenario<DataStore>[] = [
  {
    method: 'sandboxServices.insert',
    name: 'starting, exports kept, read back',
    fixture,
    run: async (store) => {
      const {
        createdAt: _c,
        lastUsedAt: _l,
        ...inserted
      } = await store.sandboxServices.insert({
        id: id(9),
        subject: 'ann',
        name: 'search',
        image: 'opensearch:2',
        exports: { URL: 'http://{host}:9200' },
        expiresAt: at(300),
      });
      return [inserted, (await store.sandboxServices.getByName('ann', 'search'))?.status];
    },
  },
  {
    method: 'sandboxServices.list',
    name: 'by name, malformed ports and exports dropped',
    fixture,
    run: async (store) => [
      await store.sandboxServices.list('ann'),
      await store.sandboxServices.list('nobody'),
    ],
  },
  {
    method: 'sandboxServices.getByName',
    name: 'the subject’s own only',
    fixture,
    run: async (store) => [
      (await store.sandboxServices.getByName('bob', 'db'))?.id,
      await store.sandboxServices.getByName('bob', 'cache'),
    ],
  },
  {
    method: 'sandboxServices.update',
    name: 'only the fields given',
    fixture,
    run: async (store) => {
      await store.sandboxServices.update(id(2), {
        status: 'running',
        containerId: 'c-z',
        host: '10.0.0.9',
        ports: [6379],
      });
      await store.sandboxServices.update(id(1), { error: 'oom', containerId: null });
      await store.sandboxServices.update(id(3), {});
      return store.sandboxServices.list('ann');
    },
  },
  {
    method: 'sandboxServices.touch',
    name: 'every id given, nothing for none',
    fixture,
    run: async (store) => {
      await store.sandboxServices.touch([id(1), id(4)], { lastUsedAt: at(50), expiresAt: at(900) });
      await store.sandboxServices.touch([], { lastUsedAt: at(60), expiresAt: at(990) });
      return [
        (await store.sandboxServices.list('ann')).map((s) => [s.id, s.lastUsedAt, s.expiresAt]),
        (await store.sandboxServices.list('bob')).map((s) => [s.id, s.lastUsedAt, s.expiresAt]),
      ];
    },
  },
  {
    method: 'sandboxServices.deleteById',
    name: 'whoever holds it',
    fixture,
    run: async (store) => {
      await store.sandboxServices.deleteById(id(1));
      return (await store.sandboxServices.list('ann')).map((s) => s.name);
    },
  },
  {
    method: 'sandboxServices.listExpired',
    name: 'soonest first, ties by id, bounded',
    fixture,
    run: async (store) => [
      (await store.sandboxServices.listExpired(at(104), 10)).map((s) => s.id),
      (await store.sandboxServices.listExpired(at(200), 2)).map((s) => s.id),
      await store.sandboxServices.listExpired(at(0), 10),
    ],
  },
  {
    method: 'sandboxServices.listClaimedContainerIds',
    name: 'non-null container ids, sorted',
    fixture,
    run: async (store) => store.sandboxServices.listClaimedContainerIds(),
  },
];
