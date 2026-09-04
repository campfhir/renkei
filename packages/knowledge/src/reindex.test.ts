/**
 * A null cursor (the first batch of a run) used to reach the database as
 * `id > ''` — `id` is a uuid column, so Postgres rejected the empty string
 * before any row could be read. The cursor filter must be omitted entirely
 * on the first batch, not defaulted to an empty string.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/crypto', () => ({ decryptContent: jest.fn() }));

import { reembedBatch } from './reindex';
import type { EmbeddingProvider } from './embeddings';

const { getDatabase: mockGetDatabase } =
  jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');

interface FakeBuilder {
  select: () => FakeBuilder;
  where: (...args: unknown[]) => FakeBuilder;
  orderBy: () => FakeBuilder;
  limit: () => FakeBuilder;
  execute: () => Promise<unknown[]>;
}

function fakeSelect(rows: unknown[], wheres: unknown[][]): FakeBuilder {
  const builder: FakeBuilder = {
    select: () => builder,
    where: (...args: unknown[]) => {
      wheres.push(args);
      return builder;
    },
    orderBy: () => builder,
    limit: () => builder,
    execute: async () => rows,
  };
  return builder;
}

const noopEmbedder: EmbeddingProvider = { embed: jest.fn() };

describe('reembedBatch cursor filter', () => {
  it('omits the id filter on the first batch (cursor null)', async () => {
    const wheres: unknown[][] = [];
    mockGetDatabase.mockReturnValue({
      ok: true,
      val: { selectFrom: () => fakeSelect([], wheres) },
    });

    const result = await reembedBatch('tenant-1', noopEmbedder, Buffer.alloc(32), null, 64);

    expect(result.ok).toBe(true);
    expect(wheres.some((args) => args[0] === 'id')).toBe(false);
  });

  it('filters by id on a later batch (cursor set)', async () => {
    const wheres: unknown[][] = [];
    mockGetDatabase.mockReturnValue({
      ok: true,
      val: { selectFrom: () => fakeSelect([], wheres) },
    });

    const result = await reembedBatch(
      'tenant-1',
      noopEmbedder,
      Buffer.alloc(32),
      'row-50',
      64
    );

    expect(result.ok).toBe(true);
    expect(wheres).toContainEqual(['id', '>', 'row-50']);
  });
});
