import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import type { MirthInstanceInput } from './types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

function instance(n: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    id: id(n),
    name,
    base_url: `https://mirth${n}.test:8443`,
    created_at: at(n),
    updated_at: at(n),
    ...extra,
  };
}

function connection(n: number, subject: string, permissions: string[]) {
  return {
    instance_id: id(n),
    subject,
    encrypted_credentials: `sealed-${n}-${subject}`,
    username: `${subject}-mirth`,
    permissions,
    created_at: at(20),
    updated_at: at(20),
  };
}

const fixture = {
  mirth_instances: [
    instance(1, 'Prod', { ca_pem: '-----BEGIN CERTIFICATE-----', environment: 'prod' }),
    instance(2, 'dev', { environment: 'dev', tls_verify: false, allow_insecure_http: true }),
    instance(3, 'Dev', { enabled: false, settings: JSON.stringify({ a: 1 }) }),
    instance(4, 'Test'),
  ],
  mirth_instance_connections: [
    connection(1, 'ann', ['channels.read', 'messages.read']),
    connection(2, 'ann', []),
    connection(3, 'ann', ['channels.deploy']),
    connection(1, 'bob', ['channels.read']),
  ],
};

const input: MirthInstanceInput = {
  name: 'New',
  environment: 'staging',
  baseUrl: 'https://new.test',
  tlsVerify: true,
  caPem: undefined,
  allowInsecureHttp: false,
  enabled: true,
};

export const mirthInstanceScenarios: Scenario<DataStore>[] = [
  {
    method: 'mirthInstances.listWithConnection',
    name: 'enabled instances by name, this person’s connection only',
    fixture,
    run: async (store) => [
      await store.mirthInstances.listWithConnection('ann'),
      (await store.mirthInstances.listWithConnection('bob')).map((e) => [
        e.instance.name,
        e.connection?.permissions ?? null,
      ]),
      await store.mirthInstances.listWithConnection('nobody').then((l) => l.length),
    ],
  },
  {
    method: 'mirthInstances.getConnection',
    name: 'own connection, null otherwise, malformed id refused',
    fixture,
    run: async (store) => [
      await store.mirthInstances.getConnection(id(1), 'ann'),
      await store.mirthInstances.getConnection(id(4), 'ann'),
      await store.mirthInstances.getConnection('bad', 'ann').then(
        () => 'accepted',
        (e: { code?: string }) => e.code
      ),
    ],
  },
  {
    method: 'mirthInstances.upsertConnection',
    name: 'inserts, replaces, refuses an unknown instance',
    fixture,
    run: async (store) => {
      const next = { username: 'u', permissions: ['a', 'b'], encryptedCredentials: 'sealed-x' };
      await store.mirthInstances.upsertConnection(id(4), 'ann', next);
      await store.mirthInstances.upsertConnection(id(1), 'ann', { ...next, permissions: [] });
      const refused = await store.mirthInstances.upsertConnection(id(9), 'ann', next).then(
        () => 'accepted',
        (e: { code?: string }) => e.code
      );
      return {
        refused,
        four: await store.mirthInstances.getConnection(id(4), 'ann'),
        one: await store.mirthInstances.getConnection(id(1), 'ann'),
        bob: await store.mirthInstances.getConnection(id(1), 'bob'),
      };
    },
  },
  {
    method: 'mirthInstances.updateConnectionPermissions',
    name: 'own row only, counted',
    fixture,
    run: async (store) => [
      await store.mirthInstances.updateConnectionPermissions(id(2), 'ann', ['x']),
      await store.mirthInstances.updateConnectionPermissions(id(4), 'ann', ['x']),
      await store.mirthInstances.getConnection(id(2), 'ann'),
    ],
  },
  {
    method: 'mirthInstances.deleteConnection',
    name: 'own row only, counted',
    fixture,
    run: async (store) => [
      await store.mirthInstances.deleteConnection(id(1), 'ann'),
      await store.mirthInstances.deleteConnection(id(1), 'ann'),
      await store.mirthInstances.getConnection(id(1), 'bob'),
    ],
  },
  {
    method: 'mirthInstances.connectionPermissions',
    name: 'enabled instances only, by instance id',
    fixture,
    run: async (store) => [
      await store.mirthInstances.connectionPermissions('ann'),
      await store.mirthInstances.connectionPermissions('nobody'),
    ],
  },
  {
    method: 'mirthInstances.list',
    name: 'every instance by name',
    fixture,
    run: async (store) => store.mirthInstances.list(),
  },
  {
    method: 'mirthInstances.get',
    name: 'by id, null when missing',
    fixture,
    run: async (store) => [
      await store.mirthInstances.get(id(3)),
      await store.mirthInstances.get(id(9)),
    ],
  },
  {
    method: 'mirthInstances.create',
    name: 'defaults filled; a taken name refused with 23505',
    fixture,
    run: async (store) => {
      const created = await store.mirthInstances.create(input);
      const row = await store.mirthInstances.get(created);
      const taken = await store.mirthInstances.create({ ...input, name: 'Prod' }).then(
        () => 'accepted',
        (e: { code?: string }) => e.code
      );
      return { row: row && { ...row, id: null, createdAt: null, updatedAt: null }, taken };
    },
  },
  {
    method: 'mirthInstances.update',
    name: 'keeps an unstated CA, clears a null one, refuses a taken name',
    fixture,
    run: async (store) => {
      const kept = await store.mirthInstances.update(id(1), { ...input, name: 'Prod 2' });
      const cleared = await store.mirthInstances.update(id(4), { ...input, caPem: null });
      const missing = await store.mirthInstances.update(id(9), input);
      const taken = await store.mirthInstances.update(id(4), { ...input, name: 'dev' }).then(
        () => 'accepted',
        (e: { code?: string }) => e.code
      );
      const rows = await store.mirthInstances.list();
      return {
        counts: [kept, cleared, missing],
        taken,
        rows: rows.map((r) => [r.name, r.caPem, r.environment]),
      };
    },
  },
  {
    method: 'mirthInstances.delete',
    name: 'takes its connections with it',
    fixture,
    run: async (store) => [
      await store.mirthInstances.delete(id(1)),
      await store.mirthInstances.delete(id(1)),
      await store.mirthInstances.getConnection(id(1), 'bob'),
    ],
  },
];
