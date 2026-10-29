import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-13${String(n).padStart(10, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

function grant(key: number, kind: string, holder: string, minute: number, wrapped = '') {
  return {
    resource_key_id: id(key),
    holder_kind: kind,
    holder,
    wrapped_key: wrapped || `w-${key}-${kind}-${holder}`,
    kek_version: minute,
    granted_by: kind === 'public' ? 'ann' : null,
    created_at: at(minute),
  };
}

const fixture = {
  chats: [{ id: id(51), owner_subject: 'ann' }],
  chat_projects: [{ id: id(52), owner_subject: 'ann', name: 'P' }],
  resource_keys: [
    { id: id(1), resource_kind: 'chat', resource_id: id(51) },
    { id: id(2), resource_kind: 'chat', resource_id: id(61) },
    { id: id(3), resource_kind: 'chat_project', resource_id: id(52) },
    { id: id(4), resource_kind: 'chat_project', resource_id: id(62) },
    { id: id(5), resource_kind: 'prompt_library', resource_id: id(63) },
    { id: id(6), resource_kind: 'artifact', resource_id: id(64) },
  ],
  resource_key_grants: [
    grant(1, 'user', 'ann', 2),
    grant(1, 'automation', 'ann', 2),
    grant(1, 'public', 'bob', 3),
    grant(1, 'resource', id(3), 1),
    grant(2, 'user', 'bob', 4),
    grant(3, 'user', 'ann', 5),
  ],
};

export const resourceKeyScenarios: Scenario<DataStore>[] = [
  {
    method: 'resourceKeys.find',
    name: 'by kind and resource; another kind or a keyless resource is null',
    fixture,
    run: async (store) => [
      await store.resourceKeys.find('chat', id(51)),
      await store.resourceKeys.find('chat_project', id(51)),
      await store.resourceKeys.find('chat', id(99)),
    ],
  },
  {
    method: 'resourceKeys.findMany',
    name: 'only resources with a key, by resource id; empty in, empty out',
    fixture,
    run: async (store) => [
      await store.resourceKeys.findMany('chat', [id(61), id(51), id(99)]),
      await store.resourceKeys.findMany('chat_project', [id(51)]),
      await store.resourceKeys.findMany('chat', []),
    ],
  },
  {
    method: 'resourceKeys.insertIfAbsent',
    name: 'a fresh resource gets a row; an existing one answers null',
    fixture,
    run: async (store) => {
      const fresh = await store.resourceKeys.insertIfAbsent('chat', id(70));
      return [
        fresh !== null,
        (await store.resourceKeys.find('chat', id(70))) === fresh,
        await store.resourceKeys.insertIfAbsent('chat', id(51)),
        await store.resourceKeys.insertIfAbsent('chat', id(70)),
      ];
    },
  },
  {
    method: 'resourceKeys.delete',
    name: 'the key and its wrappings go; nothing to delete is zero',
    fixture,
    run: async (store) => [
      await store.resourceKeys.delete('chat', id(51)),
      await store.resourceKeys.find('chat', id(51)),
      await store.resourceKeys.wrappings([id(1)]),
      await store.resourceKeys.delete('chat', id(51)),
      await store.resourceKeys.wrappings([id(2)]),
    ],
  },
  {
    method: 'resourceKeys.wrappings',
    name: 'every wrapping of the keys asked, by key, kind, holder',
    fixture,
    run: async (store) => [
      await store.resourceKeys.wrappings([id(2), id(1)]),
      await store.resourceKeys.wrappings([id(5)]),
      await store.resourceKeys.wrappings([]),
    ],
  },
  {
    method: 'resourceKeys.holdsWrapping',
    name: 'the kinds asked only, the holder asked only',
    fixture,
    run: async (store) => [
      await store.resourceKeys.holdsWrapping(id(1), 'ann', ['user', 'automation']),
      await store.resourceKeys.holdsWrapping(id(1), 'bob', ['user', 'automation']),
      await store.resourceKeys.holdsWrapping(id(1), 'bob', ['public']),
      await store.resourceKeys.holdsWrapping(id(2), 'ann', ['user']),
      await store.resourceKeys.holdsWrapping(id(1), 'ann', []),
    ],
  },
  {
    method: 'resourceKeys.upsertWrapping',
    name: 'inserts, then replaces the wrapping, version and granter in place',
    fixture,
    run: async (store) => {
      await store.resourceKeys.upsertWrapping({
        resourceKeyId: id(2),
        holderKind: 'public',
        holder: 'cy',
        wrappedKey: 'first',
        kekVersion: 1,
        grantedBy: 'bob',
      });
      await store.resourceKeys.upsertWrapping({
        resourceKeyId: id(1),
        holderKind: 'user',
        holder: 'ann',
        wrappedKey: 'rewrapped',
        kekVersion: 9,
        grantedBy: null,
      });
      return [
        await store.resourceKeys.wrappings([id(1), id(2)]),
        await store.resourceKeys.holders(id(1)),
      ];
    },
  },
  {
    method: 'resourceKeys.insertWrappingIfAbsent',
    name: 'writes a new wrapping; an existing one stays as it was',
    fixture,
    run: async (store) => [
      await store.resourceKeys.insertWrappingIfAbsent({
        resourceKeyId: id(3),
        holderKind: 'user',
        holder: 'bob',
        wrappedKey: 'new',
        kekVersion: 2,
        grantedBy: 'ann',
      }),
      await store.resourceKeys.insertWrappingIfAbsent({
        resourceKeyId: id(3),
        holderKind: 'user',
        holder: 'ann',
        wrappedKey: 'clobber',
        kekVersion: 2,
        grantedBy: null,
      }),
      await store.resourceKeys.wrappings([id(3)]),
    ],
  },
  {
    method: 'resourceKeys.deleteWrappings',
    name: "the holder's wrappings of the kinds asked; others stay",
    fixture,
    run: async (store) => [
      await store.resourceKeys.deleteWrappings(id(1), 'ann', ['user', 'public']),
      await store.resourceKeys.deleteWrappings(id(1), 'bob', ['user']),
      await store.resourceKeys.deleteWrappings(id(1), 'bob', []),
      await store.resourceKeys.wrappings([id(1)]),
    ],
  },
  {
    method: 'resourceKeys.holders',
    name: 'oldest first, ties by kind then holder; a key without wrappings is empty',
    fixture,
    run: async (store) => [
      await store.resourceKeys.holders(id(1)),
      await store.resourceKeys.holders(id(4)),
    ],
  },
  {
    method: 'resourceKeys.findWithWrapping',
    name: "the key with the holder's wrapping, without one, or no key",
    fixture,
    run: async (store) => [
      await store.resourceKeys.findWithWrapping('chat', id(51), 'user', 'ann'),
      await store.resourceKeys.findWithWrapping('chat', id(51), 'user', 'bob'),
      await store.resourceKeys.findWithWrapping('chat', id(51), 'public', 'bob'),
      await store.resourceKeys.findWithWrapping('chat', id(99), 'user', 'ann'),
    ],
  },
  {
    method: 'resourceKeys.pruneOrphans',
    name: 'keys of vanished resources go, with their wrappings; live ones stay',
    fixture,
    run: async (store) => [
      await store.resourceKeys.pruneOrphans(),
      await store.resourceKeys.findMany('chat', [id(51), id(61)]),
      await store.resourceKeys.findMany('chat_project', [id(52), id(62)]),
      await store.resourceKeys.find('prompt_library', id(63)),
      await store.resourceKeys.find('artifact', id(64)),
      await store.resourceKeys.wrappings([id(2)]),
      await store.resourceKeys.pruneOrphans(),
    ],
  },
];
