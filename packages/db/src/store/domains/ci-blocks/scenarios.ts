import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { uid } from '../chats/fixtures';

const at = new Date('2026-11-01T10:00:00.000Z');
const deploy = { kind: 'deploy', runsOn: { type: 'target' }, commands: 'echo deploy' };
const fixture = {
  ci_blocks: [
    {
      id: uid(1401),
      key: 'node-test',
      name: 'Node test',
      description: 'npm test',
      kind: 'test',
      draft: null,
      latest_version: 1,
      created_by: 'renkei',
      created_at: at,
      updated_at: at,
    },
    {
      id: uid(1402),
      key: 'deploy-systemd',
      name: 'Deploy systemd',
      description: null,
      kind: 'deploy',
      draft: { ...deploy, commands: 'echo deploy v3' },
      latest_version: 2,
      created_by: 'ada@example.com',
      created_at: at,
      updated_at: at,
    },
    {
      id: uid(1403),
      key: 'draft-only',
      name: 'Draft only',
      description: null,
      kind: 'check',
      draft: { kind: 'check', commands: 'true' },
      latest_version: 0,
      created_by: 'ada@example.com',
      created_at: at,
      updated_at: at,
    },
  ],
  ci_block_versions: [
    {
      block_id: uid(1401),
      version: 1,
      definition: { kind: 'test' },
      published_by: 'renkei',
      published_at: at,
    },
    {
      block_id: uid(1402),
      version: 1,
      definition: deploy,
      published_by: 'ada@example.com',
      published_at: at,
    },
    {
      block_id: uid(1402),
      version: 2,
      definition: { ...deploy, commands: 'echo deploy v2' },
      published_by: 'ada@example.com',
      published_at: at,
    },
  ],
};
const code = (error: { code?: string }) => error.code ?? 'refused';
/** What a record says, less the clock's own stamps. */
const shape = (block: { updatedAt?: Date } | null) => {
  if (!block) return null;
  const { updatedAt: _updatedAt, ...rest } = block;
  return rest;
};

export const ciBlockScenarios: Scenario<DataStore>[] = [
  {
    method: 'ciBlocks.list',
    name: 'every block, by name',
    fixture,
    run: async (store) => (await store.ciBlocks.list()).map(shape),
  },
  {
    method: 'ciBlocks.get',
    name: 'one, and none',
    fixture,
    run: async (store) => [await store.ciBlocks.get(uid(1402)), await store.ciBlocks.get(uid(1))],
  },
  {
    method: 'ciBlocks.getByKey',
    name: 'by key, and none',
    fixture,
    run: async (store) => [
      (await store.ciBlocks.getByKey('node-test'))?.id,
      await store.ciBlocks.getByKey('nope'),
    ],
  },
  {
    method: 'ciBlocks.create',
    name: 'a draft at version 0, then a taken key refused',
    fixture,
    run: async (store) => {
      const id = await store.ciBlocks.create({
        key: 'go-build',
        name: 'Go build',
        description: null,
        kind: 'build',
        draft: { kind: 'build', commands: 'go build' },
        createdBy: 'ada@example.com',
      });
      const created = await store.ciBlocks.get(id);
      const taken = await store.ciBlocks
        .create({
          key: 'node-test',
          name: 'x',
          description: null,
          kind: 'test',
          draft: {},
          createdBy: 'a',
        })
        .then(() => 'accepted', code);
      return {
        created: {
          key: created?.key,
          draft: created?.draft,
          latestVersion: created?.latestVersion,
        },
        taken,
      };
    },
  },
  {
    method: 'ciBlocks.saveDraft',
    name: 'replaces the draft and the name; missing is false',
    fixture,
    run: async (store) => [
      await store.ciBlocks.saveDraft(uid(1401), {
        name: 'Node: test',
        description: null,
        kind: 'test',
        draft: { kind: 'test', commands: 'npm test --silent' },
      }),
      await store.ciBlocks.saveDraft(uid(1), {
        name: 'x',
        description: null,
        kind: 'test',
        draft: {},
      }),
      shape(await store.ciBlocks.get(uid(1401))),
    ],
  },
  {
    method: 'ciBlocks.discardDraft',
    name: 'once; a block without one is false',
    fixture,
    run: async (store) => [
      await store.ciBlocks.discardDraft(uid(1402)),
      await store.ciBlocks.discardDraft(uid(1402)),
      await store.ciBlocks.discardDraft(uid(1401)),
      (await store.ciBlocks.get(uid(1402)))?.draft,
    ],
  },
  {
    method: 'ciBlocks.publish',
    name: 'the draft becomes the next version; nothing to publish, or no block, is null',
    fixture,
    run: async (store) => {
      const third = await store.ciBlocks.publish(uid(1402), 'grace@example.com');
      const first = await store.ciBlocks.publish(uid(1403), 'grace@example.com');
      const again = await store.ciBlocks.publish(uid(1402), 'grace@example.com');
      const missing = await store.ciBlocks.publish(uid(1), 'grace@example.com');
      const block = await store.ciBlocks.get(uid(1402));
      const version = await store.ciBlocks.getVersion(uid(1402), 3);
      return {
        third,
        first,
        again,
        missing,
        block: { draft: block?.draft, latestVersion: block?.latestVersion },
        version: { definition: version?.definition, publishedBy: version?.publishedBy },
      };
    },
  },
  {
    method: 'ciBlocks.listVersions',
    name: 'newest first; none for a draft-only block',
    fixture,
    run: async (store) => [
      (await store.ciBlocks.listVersions(uid(1402))).map((v) => [v.version, v.definition]),
      await store.ciBlocks.listVersions(uid(1403)),
    ],
  },
  {
    method: 'ciBlocks.getVersion',
    name: 'one, and one that does not exist',
    fixture,
    run: async (store) => [
      await store.ciBlocks.getVersion(uid(1402), 1),
      await store.ciBlocks.getVersion(uid(1402), 9),
    ],
  },
  {
    method: 'ciBlocks.delete',
    name: 'takes its versions with it; twice is false',
    fixture,
    run: async (store) => [
      await store.ciBlocks.delete(uid(1402)),
      await store.ciBlocks.delete(uid(1402)),
      await store.ciBlocks.listVersions(uid(1402)),
      (await store.ciBlocks.list()).map((b) => b.key),
    ],
  },
];
