import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import type { FileShareInput } from './types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

function share(n: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    id: id(n),
    name,
    protocol: n % 2 ? 'smb' : 'sftp',
    host: `host${n}.test`,
    port: n % 2 ? null : 22,
    share_name: n % 2 ? `share${n}` : null,
    case_insensitive: n % 2 === 1,
    created_at: at(n),
    updated_at: at(n),
    ...extra,
  };
}

function connection(n: number, subject: string, extra: Record<string, unknown> = {}) {
  return {
    share_id: id(n),
    subject,
    encrypted_credentials: `sealed-${n}-${subject}`,
    username: `${subject}-account`,
    tool_access: 'read',
    created_at: at(20),
    updated_at: at(20),
    ...extra,
  };
}

const fixture = {
  file_shares: [
    share(1, 'Finance', { root_path: '/reports', settings: JSON.stringify({ k: 1 }) }),
    share(2, 'archive', { host_key_fingerprint: 'SHA256:abc' }),
    share(3, 'Archive', { enabled: false }),
    share(4, 'Zeta'),
  ],
  file_share_connections: [
    connection(1, 'ann', { tool_access: 'read_write', allow_delete: true }),
    connection(2, 'ann'),
    connection(3, 'ann', { tool_access: 'read_write' }),
    connection(1, 'bob'),
  ],
};

const input: FileShareInput = {
  name: 'New share',
  protocol: 'sftp',
  host: 'new.test',
  port: 2222,
  shareName: null,
  rootPath: '/',
  caseInsensitive: false,
  enabled: true,
  hostKeyFingerprint: null,
};

export const fileShareScenarios: Scenario<DataStore>[] = [
  {
    method: 'fileShares.listWithConnection',
    name: 'enabled shares by name, this person’s connection only',
    fixture,
    run: async (store) => [
      await store.fileShares.listWithConnection('ann'),
      (await store.fileShares.listWithConnection('bob')).map((e) => [
        e.share.name,
        e.connection?.username ?? null,
      ]),
      (await store.fileShares.listWithConnection('nobody')).map((e) => e.connection),
    ],
  },
  {
    method: 'fileShares.listWithConnection',
    name: 'empty',
    run: async (store) => store.fileShares.listWithConnection('ann'),
  },
  {
    method: 'fileShares.getConnection',
    name: 'own connection, null otherwise, malformed id refused',
    fixture,
    run: async (store) => [
      await store.fileShares.getConnection(id(1), 'ann'),
      await store.fileShares.getConnection(id(4), 'ann'),
      await store.fileShares.getConnection(id(1), 'carol'),
      await store.fileShares.getConnection('bad', 'ann').then(
        () => 'accepted',
        (e: { code?: string }) => e.code
      ),
    ],
  },
  {
    method: 'fileShares.upsertConnection',
    name: 'inserts, replaces, refuses an unknown share',
    fixture,
    run: async (store) => {
      const next = {
        username: 'ann2',
        toolAccess: 'read_write',
        allowDelete: false,
        encryptedCredentials: 'sealed-new',
      };
      await store.fileShares.upsertConnection(id(4), 'ann', next);
      await store.fileShares.upsertConnection(id(1), 'ann', { ...next, username: 'ann3' });
      const refused = await store.fileShares.upsertConnection(id(9), 'ann', next).then(
        () => 'accepted',
        (e: { code?: string }) => e.code
      );
      return {
        refused,
        four: await store.fileShares.getConnection(id(4), 'ann'),
        one: await store.fileShares.getConnection(id(1), 'ann'),
        bob: await store.fileShares.getConnection(id(1), 'bob'),
      };
    },
  },
  {
    method: 'fileShares.updateConnectionExposure',
    name: 'own row only, counted',
    fixture,
    run: async (store) => [
      await store.fileShares.updateConnectionExposure(id(2), 'ann', {
        toolAccess: 'read_write',
        allowDelete: true,
      }),
      await store.fileShares.updateConnectionExposure(id(4), 'ann', {
        toolAccess: 'read',
        allowDelete: false,
      }),
      await store.fileShares.getConnection(id(2), 'ann'),
      await store.fileShares.getConnection(id(1), 'bob'),
    ],
  },
  {
    method: 'fileShares.deleteConnection',
    name: 'own row only, counted',
    fixture,
    run: async (store) => [
      await store.fileShares.deleteConnection(id(1), 'ann'),
      await store.fileShares.deleteConnection(id(1), 'ann'),
      await store.fileShares.getConnection(id(1), 'bob'),
    ],
  },
  {
    method: 'fileShares.connectionExposures',
    name: 'enabled shares only, by share id',
    fixture,
    run: async (store) => [
      await store.fileShares.connectionExposures('ann'),
      await store.fileShares.connectionExposures('bob'),
      await store.fileShares.connectionExposures('nobody'),
    ],
  },
  {
    method: 'fileShares.list',
    name: 'every share by name',
    fixture,
    run: async (store) => store.fileShares.list(),
  },
  {
    method: 'fileShares.get',
    name: 'by id, null when missing',
    fixture,
    run: async (store) => [await store.fileShares.get(id(3)), await store.fileShares.get(id(9))],
  },
  {
    method: 'fileShares.create',
    name: 'defaults filled; a taken name refused with 23505',
    fixture,
    run: async (store) => {
      const created = await store.fileShares.create(input);
      const share = await store.fileShares.get(created);
      const taken = await store.fileShares.create({ ...input, name: 'Finance' }).then(
        () => 'accepted',
        (e: { code?: string }) => e.code
      );
      return {
        share: share && { ...share, id: null, createdAt: null, updatedAt: null },
        taken,
        names: (await store.fileShares.list()).map((s) => s.name),
      };
    },
  },
  {
    method: 'fileShares.update',
    name: 'replaces fields, counts, refuses a taken name',
    fixture,
    run: async (store) => {
      const changed = await store.fileShares.update(id(4), { ...input, name: 'Zeta 2' });
      const missing = await store.fileShares.update(id(9), input);
      const taken = await store.fileShares.update(id(4), { ...input, name: 'archive' }).then(
        () => 'accepted',
        (e: { code?: string }) => e.code
      );
      const share = await store.fileShares.get(id(4));
      return { changed, missing, taken, share: share && { ...share, updatedAt: null } };
    },
  },
  {
    method: 'fileShares.recordHostKeyFingerprint',
    name: 'only where none is pinned',
    fixture,
    run: async (store) => [
      await store.fileShares.recordHostKeyFingerprint(id(2), 'SHA256:new'),
      await store.fileShares.recordHostKeyFingerprint(id(4), 'SHA256:first'),
      await store.fileShares.recordHostKeyFingerprint(id(4), 'SHA256:second'),
      (await store.fileShares.list()).map((s) => s.hostKeyFingerprint),
    ],
  },
  {
    method: 'fileShares.delete',
    name: 'takes its connections with it',
    fixture,
    run: async (store) => [
      await store.fileShares.delete(id(1)),
      await store.fileShares.delete(id(1)),
      await store.fileShares.getConnection(id(1), 'bob'),
      (await store.fileShares.listWithConnection('ann')).map((e) => e.share.name),
    ],
  },
];
