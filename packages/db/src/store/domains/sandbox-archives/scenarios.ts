import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

const SANDBOX = {
  ann: '00000000-0000-4000-8000-000000000011',
  agent: '00000000-0000-4000-8000-000000000012',
  project: '00000000-0000-4000-8000-000000000013',
  next: '00000000-0000-4000-8000-000000000014',
};

const fixture = {
  sandbox_archives: [
    {
      route_key: 'ann',
      sandbox_id: SANDBOX.ann,
      blob_key: 'sandbox-archives/a/one.tar.zst',
      size_bytes: '1024',
      created_at: at(10),
    },
    {
      route_key: 'agent:a1',
      sandbox_id: SANDBOX.agent,
      blob_key: 'sandbox-archives/b/two.tar.zst',
      size_bytes: '5000000000',
      created_at: at(5),
    },
    {
      route_key: 'code-project:p1',
      sandbox_id: SANDBOX.project,
      blob_key: 'sandbox-archives/c/three.tar.zst',
      size_bytes: '0',
      created_at: at(10),
    },
  ],
};

export const sandboxArchiveScenarios: Scenario<DataStore>[] = [
  {
    method: 'sandboxArchives.get',
    name: 'a scope’s archive, one larger than an int4 included; nothing for a scope without one',
    fixture,
    run: async (store) => [
      await store.sandboxArchives.get('ann'),
      await store.sandboxArchives.get('agent:a1'),
      await store.sandboxArchives.get('nobody'),
    ],
  },
  {
    method: 'sandboxArchives.put',
    name: 'the first archive of a scope replaces nothing; the next replaces it and answers the one it replaced',
    fixture,
    run: async (store) => [
      await store.sandboxArchives.put({
        routeKey: 'bob',
        sandboxId: SANDBOX.next,
        blobKey: 'sandbox-archives/d/four.tar.zst',
        sizeBytes: 7,
        createdAt: at(20),
      }),
      await store.sandboxArchives.put({
        routeKey: 'ann',
        sandboxId: SANDBOX.next,
        blobKey: 'sandbox-archives/a/five.tar.zst',
        sizeBytes: 2048,
        createdAt: at(21),
      }),
      await store.sandboxArchives.get('bob'),
      await store.sandboxArchives.get('ann'),
    ],
  },
  {
    method: 'sandboxArchives.remove',
    name: 'answers what was there, once',
    fixture,
    run: async (store) => [
      await store.sandboxArchives.remove('ann'),
      await store.sandboxArchives.remove('ann'),
      await store.sandboxArchives.get('ann'),
      await store.sandboxArchives.get('agent:a1'),
    ],
  },
  {
    method: 'sandboxArchives.listOlderThan',
    name: 'strictly before the cut, oldest first then by scope, capped',
    fixture,
    run: async (store) => [
      await store.sandboxArchives.listOlderThan(at(5), 10),
      await store.sandboxArchives.listOlderThan(at(10), 10),
      await store.sandboxArchives.listOlderThan(at(11), 10),
      await store.sandboxArchives.listOlderThan(at(11), 2),
    ],
  },
];
