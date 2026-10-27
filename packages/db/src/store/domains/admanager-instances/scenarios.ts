import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import type { AdManagerInstanceInput } from './types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

function instance(n: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    id: id(n),
    name,
    base_url: `https://adManager${n}.test:8443`,
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
    technician_name: `${subject}-adManager`,
    permissions,
    created_at: at(20),
    updated_at: at(20),
  };
}

const fixture = {
  admanager_instances: [
    instance(1, 'Prod', { ca_pem: '-----BEGIN CERTIFICATE-----', environment: 'prod' }),
    instance(2, 'dev', { environment: 'dev', tls_verify: false, allow_insecure_http: true }),
    instance(3, 'Dev', { enabled: false, settings: JSON.stringify({ a: 1 }) }),
    instance(5, 'Other', {
      settings: JSON.stringify({ resetPasswordTemplateName: 'Old', keep: true }),
    }),
    instance(4, 'Test'),
  ],
  admanager_instance_connections: [
    connection(1, 'ann', ['channels.read', 'messages.read']),
    connection(2, 'ann', []),
    connection(3, 'ann', ['channels.deploy']),
    connection(1, 'bob', ['channels.read']),
  ],
};

const input: AdManagerInstanceInput = {
  name: 'New',
  environment: 'staging',
  baseUrl: 'https://new.test',
  tlsVerify: true,
  caPem: undefined,
  allowInsecureHttp: false,
  enabled: true,
  settings: {
    ownedKeys: ['resetPasswordTemplateName'],
    values: { resetPasswordTemplateName: 'Std' },
  },
};

export const adManagerInstanceScenarios: Scenario<DataStore>[] = [
  {
    method: 'adManagerInstances.listWithConnection',
    name: 'enabled instances by name, this person’s connection only',
    fixture,
    run: async (store) => [
      await store.adManagerInstances.listWithConnection('ann'),
      (await store.adManagerInstances.listWithConnection('bob')).map((e) => [
        e.instance.name,
        e.connection?.permissions ?? null,
      ]),
      await store.adManagerInstances.listWithConnection('nobody').then((l) => l.length),
    ],
  },
  {
    method: 'adManagerInstances.getConnection',
    name: 'own connection, null otherwise, malformed id refused',
    fixture,
    run: async (store) => [
      await store.adManagerInstances.getConnection(id(1), 'ann'),
      await store.adManagerInstances.getConnection(id(4), 'ann'),
      await store.adManagerInstances.getConnection('bad', 'ann').then(
        () => 'accepted',
        (e: { code?: string }) => e.code
      ),
    ],
  },
  {
    method: 'adManagerInstances.upsertConnection',
    name: 'inserts, replaces, refuses an unknown instance',
    fixture,
    run: async (store) => {
      const next = {
        technicianName: 'u',
        permissions: ['a', 'b'],
        encryptedCredentials: 'sealed-x',
      };
      await store.adManagerInstances.upsertConnection(id(4), 'ann', next);
      await store.adManagerInstances.upsertConnection(id(1), 'ann', { ...next, permissions: [] });
      const refused = await store.adManagerInstances.upsertConnection(id(9), 'ann', next).then(
        () => 'accepted',
        (e: { code?: string }) => e.code
      );
      return {
        refused,
        four: await store.adManagerInstances.getConnection(id(4), 'ann'),
        one: await store.adManagerInstances.getConnection(id(1), 'ann'),
        bob: await store.adManagerInstances.getConnection(id(1), 'bob'),
      };
    },
  },
  {
    method: 'adManagerInstances.updateConnectionPermissions',
    name: 'own row only, counted',
    fixture,
    run: async (store) => [
      await store.adManagerInstances.updateConnectionPermissions(id(2), 'ann', ['x']),
      await store.adManagerInstances.updateConnectionPermissions(id(4), 'ann', ['x']),
      await store.adManagerInstances.getConnection(id(2), 'ann'),
    ],
  },
  {
    method: 'adManagerInstances.deleteConnection',
    name: 'own row only, counted',
    fixture,
    run: async (store) => [
      await store.adManagerInstances.deleteConnection(id(1), 'ann'),
      await store.adManagerInstances.deleteConnection(id(1), 'ann'),
      await store.adManagerInstances.getConnection(id(1), 'bob'),
    ],
  },
  {
    method: 'adManagerInstances.connectionPermissions',
    name: 'enabled instances only, by instance id',
    fixture,
    run: async (store) => [
      await store.adManagerInstances.connectionPermissions('ann'),
      await store.adManagerInstances.connectionPermissions('nobody'),
    ],
  },
  {
    method: 'adManagerInstances.list',
    name: 'every instance by name',
    fixture,
    run: async (store) => store.adManagerInstances.list(),
  },
  {
    method: 'adManagerInstances.get',
    name: 'by id, null when missing',
    fixture,
    run: async (store) => [
      await store.adManagerInstances.get(id(3)),
      await store.adManagerInstances.get(id(9)),
    ],
  },
  {
    method: 'adManagerInstances.create',
    name: 'defaults filled; a taken name refused with 23505',
    fixture,
    run: async (store) => {
      const created = await store.adManagerInstances.create(input);
      const row = await store.adManagerInstances.get(created);
      const taken = await store.adManagerInstances.create({ ...input, name: 'Prod' }).then(
        () => 'accepted',
        (e: { code?: string }) => e.code
      );
      return { row: row && { ...row, id: null, createdAt: null, updatedAt: null }, taken };
    },
  },
  {
    method: 'adManagerInstances.update',
    name: 'keeps an unstated CA, clears a null one, refuses a taken name',
    fixture,
    run: async (store) => {
      const kept = await store.adManagerInstances.update(id(1), { ...input, name: 'Prod 2' });
      const cleared = await store.adManagerInstances.update(id(4), { ...input, caPem: null });
      const missing = await store.adManagerInstances.update(id(9), input);
      const merged = await store.adManagerInstances.update(id(5), {
        ...input,
        name: 'Other',
        settings: { ownedKeys: ['resetPasswordTemplateName'], values: {} },
      });
      const taken = await store.adManagerInstances.update(id(4), { ...input, name: 'dev' }).then(
        () => 'accepted',
        (e: { code?: string }) => e.code
      );
      const rows = await store.adManagerInstances.list();
      return {
        counts: [kept, cleared, missing, merged],
        taken,
        rows: rows.map((r) => [r.name, r.caPem, r.environment, r.settings]),
      };
    },
  },
  {
    method: 'adManagerInstances.delete',
    name: 'takes its connections with it',
    fixture,
    run: async (store) => [
      await store.adManagerInstances.delete(id(1)),
      await store.adManagerInstances.delete(id(1)),
      await store.adManagerInstances.getConnection(id(1), 'bob'),
    ],
  },
];
