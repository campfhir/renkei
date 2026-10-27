/**
 * A null cursor (the first batch of a run) used to reach the database as
 * `id > ''` — `id` is a uuid column, so Postgres rejected the empty string
 * before any row could be read. The cursor filter must be omitted entirely
 * on the first batch, not defaulted to an empty string. Runs on the memory
 * store, which refuses a malformed uuid the way Postgres does.
 */

jest.mock('@renkei/crypto', () => ({
  decryptContent: jest.fn((content: string) => ({ ok: true, val: content })),
}));

import { ok } from '@campfhir/safe-functions/helpers';
import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type MemoryDataStore,
} from '@renkei/db';
import { reembedBatch } from './reindex';
import type { EmbeddingProvider } from './embeddings';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function chunk(n: number, chunkCount: number) {
  return {
    id: id(n),
    provider: 'jira',
    ref_id: `ENG-${n}#000${n}`,
    content: `text ${n}`,
    embedding: '[1,0,0]',
    metadata: JSON.stringify({ chunkCount, title: `Issue ${n}` }),
  };
}

const embedder: EmbeddingProvider = {
  embed: jest.fn(async (texts: string[]) => ok(texts.map(() => [0, 1, 0]))),
};

let store: MemoryDataStore;

beforeEach(async () => {
  store = createMemoryDataStore();
  registerDataStore(store);
  await store.seed({ knowledge_chunks: [chunk(1, 2), chunk(2, 1), chunk(3, 3), chunk(4, 2)] });
});

afterEach(() => {
  resetDataStore();
});

describe('reembedBatch cursor filter', () => {
  it('omits the id filter on the first batch (cursor null)', async () => {
    const result = await reembedBatch(embedder, Buffer.alloc(32), null, 2);

    expect(result.ok && result.val).toMatchObject({
      processed: 2,
      done: false,
      cursor: id(3),
    });
  });

  it('continues after the cursor on a later batch, and re-embeds only multi-chunk rows', async () => {
    const result = await reembedBatch(embedder, Buffer.alloc(32), id(3), 64);

    expect(result.ok && result.val).toMatchObject({ processed: 1, done: true, cursor: id(4) });
    const vectors = store.tables
      .select('knowledge_chunks')
      .map((row) => [row.id, row.embedding] as const)
      .sort();
    expect(vectors).toEqual([
      [id(1), '[1,0,0]'],
      [id(2), '[1,0,0]'],
      [id(3), '[1,0,0]'],
      [id(4), '[0,1,0]'],
    ]);
  });
});
