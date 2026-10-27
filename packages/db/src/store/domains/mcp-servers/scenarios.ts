import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import type { McpServerRecord } from './types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

function server(n: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    id: id(n),
    slug: `server-${n}`,
    name,
    url: `https://mcp${n}.example.test/mcp`,
    created_at: at(n),
    updated_at: at(n),
    ...extra,
  };
}

const fixture = {
  mcp_servers: [
    server(1, 'Linear', {
      auth_mode: 'none',
      oauth: JSON.stringify({ issuer: 'https://issuer.test', scopes: ['a'] }),
      client_id: 'cid',
      encrypted_client_secret: 'sealed',
      scopes: 'read write',
    }),
    server(2, 'atlas', { enabled: false, context: 'Docs search' }),
    server(4, 'Atlas'),
    server(3, 'Atlas'),
  ],
  mcp_user_tool_lists: [
    {
      server_id: id(3),
      subject: 'ann',
      tools: JSON.stringify([{ name: 'search', readOnly: true }]),
      fetched_at: at(10),
    },
    { server_id: id(1), subject: 'ann', tools: JSON.stringify([]), fetched_at: at(11) },
    {
      server_id: id(1),
      subject: 'bob',
      tools: JSON.stringify([{ name: 'x' }]),
      fetched_at: at(12),
    },
  ],
};

/** Without the timestamps now() picked. */
function stable(record: McpServerRecord | null) {
  if (!record) return null;
  const { createdAt: _c, updatedAt: _u, id: _id, ...rest } = record;
  return rest;
}

const fresh = {
  slug: 'fresh',
  name: 'Fresh',
  url: 'https://fresh.test/sse',
  transport: 'sse',
  authMode: 'oauth',
  context: 'ctx',
  scopes: null,
  clientId: null,
  encryptedClientSecret: null,
  enabled: true,
};

export const mcpServerScenarios: Scenario<DataStore>[] = [
  {
    method: 'mcpServers.list',
    name: 'by name under collation, ties by id',
    fixture,
    run: async (store) => store.mcpServers.list(),
  },
  {
    method: 'mcpServers.list',
    name: 'empty',
    run: async (store) => store.mcpServers.list(),
  },
  {
    method: 'mcpServers.get',
    name: 'by id, unknown is null, malformed refused',
    fixture,
    run: async (store) => [
      await store.mcpServers.get(id(1)),
      await store.mcpServers.get(id(1).toUpperCase()),
      await store.mcpServers.get(id(9)),
      await store.mcpServers.get('nope').then(
        () => 'accepted',
        (e: { code?: string }) => e.code
      ),
    ],
  },
  {
    method: 'mcpServers.getBySlug',
    name: 'exact slug only',
    fixture,
    run: async (store) => [
      (await store.mcpServers.getBySlug('server-2'))?.id,
      await store.mcpServers.getBySlug('SERVER-2'),
    ],
  },
  {
    method: 'mcpServers.create',
    name: 'defaults filled, a taken slug refused with 23505',
    fixture,
    run: async (store) => {
      const created = await store.mcpServers.create(fresh);
      const again = await store.mcpServers.create({ ...fresh, slug: 'server-1' }).then(
        () => 'accepted',
        (e: { code?: string }) => e.code
      );
      return {
        created: stable(created),
        read: stable(await store.mcpServers.get(created.id)),
        again,
        count: (await store.mcpServers.list()).length,
      };
    },
  },
  {
    method: 'mcpServers.update',
    name: 'patches given fields, clears to null, unknown id is null',
    fixture,
    run: async (store) => [
      stable(
        await store.mcpServers.update(id(1), {
          name: 'Linear 2',
          encryptedClientSecret: null,
          oauth: null,
          enabled: false,
        })
      ),
      stable(await store.mcpServers.update(id(2), { oauth: { issuer: 'x' }, scopes: 's' })),
      stable(await store.mcpServers.update(id(3), {})),
      await store.mcpServers.update(id(9), { name: 'x' }),
      (await store.mcpServers.list()).map((s) => s.name),
    ],
  },
  {
    method: 'mcpServers.delete',
    name: 'takes the tool lists with it',
    fixture,
    run: async (store) => [
      await store.mcpServers.delete(id(1)),
      await store.mcpServers.delete(id(1)),
      (await store.mcpServers.listToolLists('ann')).map((l) => l.serverId),
      await store.mcpServers.listToolLists('bob'),
    ],
  },
  {
    method: 'mcpServers.saveToolList',
    name: 'inserts and replaces; an unknown server is refused',
    fixture,
    run: async (store) => {
      await store.mcpServers.saveToolList(id(2), 'ann', [{ name: 'new' }]);
      await store.mcpServers.saveToolList(id(3), 'ann', [{ name: 'replaced' }]);
      const refused = await store.mcpServers.saveToolList(id(9), 'ann', []).then(
        () => 'accepted',
        (e: { code?: string }) => e.code
      );
      const lists = await store.mcpServers.listToolLists('ann');
      return { refused, lists: lists.map((l) => [l.serverId, l.tools]) };
    },
  },
  {
    method: 'mcpServers.listToolLists',
    name: 'own lists by server id',
    fixture,
    run: async (store) => [
      await store.mcpServers.listToolLists('ann'),
      await store.mcpServers.listToolLists('nobody'),
    ],
  },
  {
    method: 'mcpServers.clearToolListsForServer',
    name: 'everyone’s list for that server only',
    fixture,
    run: async (store) => [
      await store.mcpServers.clearToolListsForServer(id(1)),
      await store.mcpServers.clearToolListsForServer(id(1)),
      (await store.mcpServers.listToolLists('ann')).map((l) => l.serverId),
      await store.mcpServers.listToolLists('bob'),
    ],
  },
  {
    method: 'mcpServers.clearToolList',
    name: 'own list only',
    fixture,
    run: async (store) => [
      await store.mcpServers.clearToolList(id(1), 'ann'),
      await store.mcpServers.clearToolList(id(1), 'ann'),
      (await store.mcpServers.listToolLists('ann')).map((l) => l.serverId),
      (await store.mcpServers.listToolLists('bob')).map((l) => l.serverId),
    ],
  },
];
