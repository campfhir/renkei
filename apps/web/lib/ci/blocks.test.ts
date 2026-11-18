/**
 * The building blocks catalogue: a draft saved as it stands, published
 * only when it reads whole, each version kept; what the list shows of a
 * block; a taken key refused.
 */

import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import {
  createBlock,
  deleteBlock,
  discardBlockDraft,
  getBlock,
  listBlocks,
  parseBlockPayload,
  publishBlock,
  saveBlockDraft,
  type BlockPayload,
} from './blocks';

const definition = {
  runsOn: { type: 'target' },
  inputs: [{ name: 'service_name', type: 'text' }],
  variables: [
    { name: 'DEPLOY_TOKEN', secured: true },
    { name: 'REGION', secured: false },
  ],
  consumes: [],
  produces: [],
  caches: [],
  commands: 'sudo systemctl restart ${input.service_name}',
};
const payload = (overrides: Partial<BlockPayload> = {}): BlockPayload => {
  const parsed = parseBlockPayload(
    {
      key: 'deploy-systemd',
      name: 'Deploy with systemd',
      kind: 'deploy',
      definition,
      ...overrides,
    },
    { create: true }
  );
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
};

beforeEach(() => registerDataStore(createMemoryDataStore()));
afterEach(() => resetDataStore());

describe('a block’s life', () => {
  it('starts as a draft, publishes as v1, and lists what it needs', async () => {
    const created = await createBlock(payload(), 'ada@example.com');
    if (!created.ok) throw new Error('not created');
    expect(await listBlocks()).toMatchObject([
      {
        key: 'deploy-systemd',
        kind: 'deploy',
        latestVersion: 0,
        hasDraft: true,
        runsOn: 'target',
        needs: ['DEPLOY_TOKEN (secured)', 'REGION'],
      },
    ]);
    expect(await publishBlock(created.id, 'ada@example.com')).toEqual({ ok: true, version: 1 });
    const block = await getBlock(created.id);
    expect(block).toMatchObject({
      latestVersion: 1,
      draft: null,
      versions: [{ version: 1, publishedBy: 'ada@example.com' }],
    });
    // The definition's kind follows the block's.
    expect(block?.published).toMatchObject({ kind: 'deploy' });
  });

  it('saves a half-finished draft, but will not publish it, naming each problem', async () => {
    const created = await createBlock(payload(), 'ada@example.com');
    if (!created.ok) throw new Error('not created');
    await saveBlockDraft(
      created.id,
      payload({ definition: { ...definition, commands: 'echo ${input.nope}' } })
    );
    expect(await publishBlock(created.id, 'ada@example.com')).toEqual({
      ok: false,
      error: 'invalid',
      problems: ['The commands use ${input.nope}, but the block has no input “nope”.'],
    });
  });

  it('keeps v1 when v2 is published, and goes back to it when a draft is discarded', async () => {
    const created = await createBlock(payload(), 'ada@example.com');
    if (!created.ok) throw new Error('not created');
    await publishBlock(created.id, 'ada@example.com');
    await saveBlockDraft(
      created.id,
      payload({ definition: { ...definition, commands: 'echo two' } })
    );
    expect(await discardBlockDraft(created.id)).toBe(true);
    expect(await publishBlock(created.id, 'ada@example.com')).toEqual({
      ok: false,
      error: 'nothing-to-publish',
    });
    await saveBlockDraft(
      created.id,
      payload({ definition: { ...definition, commands: 'echo two' } })
    );
    await publishBlock(created.id, 'grace@example.com');
    expect((await getBlock(created.id))?.versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it('refuses a taken key, and deletes a block whole', async () => {
    const created = await createBlock(payload(), 'ada@example.com');
    expect(await createBlock(payload(), 'ada@example.com')).toEqual({ ok: false, error: 'taken' });
    if (!created.ok) throw new Error('not created');
    expect(await deleteBlock(created.id)).toEqual({ name: 'Deploy with systemd' });
    expect(await listBlocks()).toEqual([]);
  });
});

describe('what a create or save body may be', () => {
  it('names what is wrong', () => {
    expect(
      parseBlockPayload({ key: 'Bad Key', name: 'x', kind: 'deploy', definition }, { create: true })
    ).toEqual({
      error:
        'The key is how pipelines name the block: lower case letters, digits and -, starting with a letter.',
    });
    expect(parseBlockPayload({ name: ' ', kind: 'deploy', definition }, { create: false })).toEqual(
      {
        error: 'Give the block a name (up to 200 characters).',
      }
    );
    expect(parseBlockPayload({ name: 'x', kind: 'ship', definition }, { create: false })).toEqual({
      error: 'Kind must be one of build, test, package, deploy, check.',
    });
  });
});
