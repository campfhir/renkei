/**
 * The reindex chain: a batch records its progress, enqueues the next link
 * on the same ordering key until the batch reports done, marks the run
 * finished, and — the deliberate departure from the ingest handlers —
 * marks the run FAILED with its reason instead of throwing into retry.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('kysely', () => ({ sql: jest.fn(() => 'sql-fragment') }));
jest.mock('@renkei/crypto', () => ({
  contentEncryptionKey: jest.fn(() => ({ ok: true, val: Buffer.alloc(32) })),
}));
jest.mock('@renkei/knowledge', () => ({
  resolveEmbeddingProvider: jest.fn(),
  resolveKeywordExtractor: jest.fn(),
  reindexLexicalBatch: jest.fn(),
  reembedBatch: jest.fn(),
  extractKeywordsBatch: jest.fn(),
  isReindexKind: (value: unknown) =>
    value === 'lexical' || value === 'embed' || value === 'keywords',
}));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { ok, err } from '@campfhir/safe-functions/helpers';
import { createKnowledgeReindexBatchHandler } from './knowledge-reindex';
import type { ClaimedEvent } from '../queue';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const {
  resolveEmbeddingProvider: mockResolveEmbedder,
  resolveKeywordExtractor: mockResolveExtractor,
  reindexLexicalBatch: mockLexical,
  reembedBatch: mockEmbed,
  extractKeywordsBatch: mockKeywords,
} = jest.requireMock<{
  resolveEmbeddingProvider: jest.Mock;
  resolveKeywordExtractor: jest.Mock;
  reindexLexicalBatch: jest.Mock;
  reembedBatch: jest.Mock;
  extractKeywordsBatch: jest.Mock;
}>('@renkei/knowledge');

/** A run row and a db stub that records every update applied to it. */
function stubDb(status: string | null) {
  const updates: Record<string, unknown>[] = [];
  mockGetDatabase.mockReturnValue({
    ok: true,
    val: {
      selectFrom: () => ({
        select: () => ({
          where: function where() {
            return { where, executeTakeFirst: async () => (status ? { status } : undefined) };
          },
        }),
      }),
      updateTable: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return {
            where: function where() {
              return { where, execute: async () => [] };
            },
          };
        },
      }),
    },
  });
  return updates;
}

const event = (payload: Record<string, unknown>): ClaimedEvent => ({
  id: 'evt-1',
  tenant_id: 'tenant-1',
  source: 'knowledge:reindex',
  type: 'reindex.batch',
  payload: JSON.parse(JSON.stringify(payload)),
  attempts: 1,
});

const outcome = (over: Partial<Record<string, unknown>> = {}) => ({
  processed: 10,
  skipped: 0,
  failed: 0,
  done: false,
  cursor: null,
  skip: [],
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('reindex.batch', () => {
  it('records progress and enqueues the next link on the run ordering key', async () => {
    const updates = stubDb('queued');
    mockLexical.mockResolvedValue(ok(outcome()));
    const enqueue = jest.fn(async () => undefined);

    await createKnowledgeReindexBatchHandler({ enqueue })(
      event({ runId: 'run-1', kind: 'lexical' })
    );

    // queued → running, then the tallies.
    expect(updates[0]).toMatchObject({ status: 'running' });
    expect(updates[1]).not.toHaveProperty('status');
    expect(enqueue).toHaveBeenCalledWith(
      'tenant-1',
      'reindex.batch',
      { provider: 'reindex', runId: 'run-1', kind: 'lexical' },
      'reindex/tenant-1/run-1',
      { strict: true }
    );
  });

  it('carries the cursor forward for embed and marks the run done at the end', async () => {
    const updates = stubDb('running');
    mockResolveEmbedder.mockResolvedValue({ embed: jest.fn() });
    mockEmbed.mockResolvedValue(ok(outcome({ done: true, cursor: 'row-99' })));
    const enqueue = jest.fn(async () => undefined);

    await createKnowledgeReindexBatchHandler({ enqueue })(
      event({ runId: 'run-2', kind: 'embed', cursor: 'row-50' })
    );

    expect(mockEmbed).toHaveBeenCalledWith(
      'tenant-1',
      expect.anything(),
      expect.anything(),
      'row-50',
      expect.any(Number)
    );
    expect(updates[updates.length - 1]).toMatchObject({ status: 'done', cursor: 'row-99' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('carries the keyword skip list between links', async () => {
    stubDb('running');
    mockResolveExtractor.mockResolvedValue({ extract: jest.fn() });
    mockKeywords.mockResolvedValue(ok(outcome({ processed: 3, failed: 1, skip: ['jira X-1'] })));
    const enqueue = jest.fn(async () => undefined);

    await createKnowledgeReindexBatchHandler({ enqueue })(
      event({ runId: 'run-3', kind: 'keywords', skip: ['jira X-0'] })
    );

    // The handler hands its own skip set to the batch and grows it after,
    // so what the batch saw is asserted through the next link's payload.
    expect(mockKeywords).toHaveBeenCalledWith(
      'tenant-1',
      expect.anything(),
      expect.anything(),
      expect.any(Number),
      expect.any(Set)
    );
    expect(enqueue).toHaveBeenCalledWith(
      'tenant-1',
      'reindex.batch',
      expect.objectContaining({ skip: ['jira X-0', 'jira X-1'] }),
      'reindex/tenant-1/run-3',
      { strict: true }
    );
  });

  it('marks the run failed with the reason instead of throwing', async () => {
    const updates = stubDb('running');
    mockResolveEmbedder.mockResolvedValue({ embed: jest.fn() });
    mockEmbed.mockResolvedValue(
      err('EMBEDDING_FAILED' as const, { message: 'endpoint returned 502' })
    );
    const enqueue = jest.fn(async () => undefined);

    await expect(
      createKnowledgeReindexBatchHandler({ enqueue })(event({ runId: 'run-4', kind: 'embed' }))
    ).resolves.toBeUndefined();
    expect(updates[updates.length - 1]).toMatchObject({
      status: 'failed',
      last_error: expect.stringContaining('502'),
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('throws on a 429 instead of failing the run, so the queue retries the same link', async () => {
    const updates = stubDb('running');
    mockResolveEmbedder.mockResolvedValue({ embed: jest.fn() });
    mockEmbed.mockResolvedValue(
      err('EMBEDDING_FAILED' as const, { message: 'endpoint returned 429', cause: 429 })
    );
    const enqueue = jest.fn(async () => undefined);

    await expect(
      createKnowledgeReindexBatchHandler({ enqueue })(event({ runId: 'run-4b', kind: 'embed' }))
    ).rejects.toThrow('429');
    // Only the queued→running transition landed — no failure recorded, no
    // progress overwritten, no next link enqueued. The thrown error is what
    // gets this link redelivered with backoff.
    expect(updates.every((update) => update.status !== 'failed')).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('fails plainly when the org has no embedder or enrichment is off', async () => {
    let updates = stubDb('queued');
    mockResolveEmbedder.mockResolvedValue(null);
    await createKnowledgeReindexBatchHandler({ enqueue: jest.fn() })(
      event({ runId: 'run-5', kind: 'embed' })
    );
    expect(updates[updates.length - 1]).toMatchObject({ status: 'failed' });

    updates = stubDb('queued');
    mockResolveExtractor.mockResolvedValue(null);
    await createKnowledgeReindexBatchHandler({ enqueue: jest.fn() })(
      event({ runId: 'run-6', kind: 'keywords' })
    );
    expect(updates[updates.length - 1]).toMatchObject({
      status: 'failed',
      last_error: expect.stringContaining('enrichment is off'),
    });
  });

  it('skips a link whose run no longer exists or already ended', async () => {
    stubDb(null);
    const enqueue = jest.fn();
    expect(
      await createKnowledgeReindexBatchHandler({ enqueue })(
        event({ runId: 'gone', kind: 'lexical' })
      )
    ).toBe('skipped');
    stubDb('failed');
    expect(
      await createKnowledgeReindexBatchHandler({ enqueue })(
        event({ runId: 'old', kind: 'lexical' })
      )
    ).toBe('skipped');
    expect(mockLexical).not.toHaveBeenCalled();
  });

  it('dead-letters a malformed payload', async () => {
    await expect(
      createKnowledgeReindexBatchHandler()(event({ runId: 'x', kind: 'everything' }))
    ).rejects.toThrow('runId/kind');
  });
});
