/**
 * The reindex chain: a batch records its progress, enqueues the next link
 * on the same ordering key until the batch reports done, marks the run
 * finished, and — the deliberate departure from the ingest handlers —
 * marks the run FAILED with its reason instead of throwing into retry.
 */

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
import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type KnowledgeReindexRunRecord,
  type MemoryDataStore,
} from '@renkei/db';
import { createKnowledgeReindexBatchHandler } from './knowledge-reindex';
import type { ClaimedEvent } from '../queue';

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

const RUN = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let store: MemoryDataStore;

/**
 * A run row in a memory store, of any kind, with this status (none at all
 * for null). `run()` reads it back as the admin would; `pause()` lands an
 * admin's pause the way the route does — used to simulate one arriving
 * between this link's start-of-handler check and its end-of-handler
 * recheck.
 */
function seedRun(runId: string, status: string | null) {
  if (status) {
    void store.seed({
      knowledge_reindex_runs: [{ id: runId, kind: 'lexical', status, requested_by: 'op' }],
    });
  }
  return {
    run: async (): Promise<KnowledgeReindexRunRecord | null> =>
      store.knowledgeReindexRuns.get(runId),
    pause: async () => {
      await store.knowledgeReindexRuns.pause(runId, 'lexical');
    },
  };
}

const event = (payload: Record<string, unknown>): ClaimedEvent => ({
  id: 'evt-1',
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
  store = createMemoryDataStore();
  registerDataStore(store);
});

afterEach(() => {
  resetDataStore();
});

describe('reindex.batch', () => {
  it('records progress and enqueues the next link on the run ordering key', async () => {
    const { run } = seedRun(RUN(1), 'queued');
    mockLexical.mockResolvedValue(ok(outcome()));
    const enqueue = jest.fn(async () => undefined);

    await createKnowledgeReindexBatchHandler({ enqueue })(
      event({ runId: RUN(1), kind: 'lexical' })
    );

    // queued → running, then the tallies.
    expect(await run()).toMatchObject({ status: 'running', processed: 10, finishedAt: null });
    expect((await run())?.startedAt).not.toBeNull();
    expect(enqueue).toHaveBeenCalledWith(
      'reindex.batch',
      { provider: 'reindex', runId: RUN(1), kind: 'lexical' },
      `reindex/${RUN(1)}`,
      { strict: true }
    );
  });

  it('stops the chain without enqueuing when a pause lands mid-batch', async () => {
    const { run, pause } = seedRun(RUN(2), 'running');
    mockLexical.mockImplementation(async () => {
      // Simulate an admin's POST { action: 'pause' } landing while this
      // batch is in flight — the handler's status recheck runs AFTER this.
      await pause();
      return ok(outcome());
    });
    const enqueue = jest.fn(async () => undefined);

    await createKnowledgeReindexBatchHandler({ enqueue })(
      event({ runId: RUN(2), kind: 'lexical' })
    );

    // The batch's own progress still landed, nothing marked the run failed
    // or done, and the chain stops.
    expect(await run()).toMatchObject({ status: 'paused', processed: 10, finishedAt: null });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('carries the cursor forward for embed and marks the run done at the end', async () => {
    const { run } = seedRun(RUN(3), 'running');
    mockResolveEmbedder.mockResolvedValue({ embed: jest.fn() });
    mockEmbed.mockResolvedValue(ok(outcome({ done: true, cursor: 'row-99' })));
    const enqueue = jest.fn(async () => undefined);

    await createKnowledgeReindexBatchHandler({ enqueue })(
      event({ runId: RUN(3), kind: 'embed', cursor: 'row-50' })
    );

    expect(mockEmbed).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'row-50',
      expect.any(Number)
    );
    expect(await run()).toMatchObject({ status: 'done', cursor: 'row-99' });
    expect((await run())?.finishedAt).not.toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('carries the keyword skip list between links', async () => {
    seedRun(RUN(4), 'running');
    mockResolveExtractor.mockResolvedValue({ extract: jest.fn() });
    mockKeywords.mockResolvedValue(ok(outcome({ processed: 3, failed: 1, skip: ['jira X-1'] })));
    const enqueue = jest.fn(async () => undefined);

    await createKnowledgeReindexBatchHandler({ enqueue })(
      event({ runId: RUN(4), kind: 'keywords', skip: ['jira X-0'] })
    );

    // The handler hands its own skip set to the batch and grows it after,
    // so what the batch saw is asserted through the next link's payload.
    expect(mockKeywords).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(Number),
      expect.any(Set)
    );
    expect(enqueue).toHaveBeenCalledWith(
      'reindex.batch',
      expect.objectContaining({ skip: ['jira X-0', 'jira X-1'] }),
      `reindex/${RUN(4)}`,
      { strict: true }
    );
  });

  it('marks the run failed with the reason instead of throwing', async () => {
    const { run } = seedRun(RUN(5), 'running');
    mockResolveEmbedder.mockResolvedValue({ embed: jest.fn() });
    mockEmbed.mockResolvedValue(
      err('EMBEDDING_FAILED' as const, { message: 'endpoint returned 502' })
    );
    const enqueue = jest.fn(async () => undefined);

    await expect(
      createKnowledgeReindexBatchHandler({ enqueue })(event({ runId: RUN(5), kind: 'embed' }))
    ).resolves.toBeUndefined();
    expect(await run()).toMatchObject({
      status: 'failed',
      lastError: expect.stringContaining('502'),
    });
    expect((await run())?.finishedAt).not.toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('throws on a 429 instead of failing the run, so the queue retries the same link', async () => {
    const { run } = seedRun(RUN(6), 'running');
    mockResolveEmbedder.mockResolvedValue({ embed: jest.fn() });
    mockEmbed.mockResolvedValue(
      err('EMBEDDING_FAILED' as const, { message: 'endpoint returned 429', cause: 429 })
    );
    const enqueue = jest.fn(async () => undefined);

    await expect(
      createKnowledgeReindexBatchHandler({ enqueue })(event({ runId: RUN(6), kind: 'embed' }))
    ).rejects.toThrow('429');
    // No failure recorded, no progress written, no next link enqueued. The
    // thrown error is what gets this link redelivered with backoff.
    expect(await run()).toMatchObject({ status: 'running', processed: 0, lastError: null });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('fails plainly when the org has no embedder or enrichment is off', async () => {
    const embedRun = seedRun(RUN(7), 'queued');
    mockResolveEmbedder.mockResolvedValue(null);
    await createKnowledgeReindexBatchHandler({ enqueue: jest.fn() })(
      event({ runId: RUN(7), kind: 'embed' })
    );
    expect(await embedRun.run()).toMatchObject({ status: 'failed' });

    const keywordRun = seedRun(RUN(8), 'queued');
    mockResolveExtractor.mockResolvedValue(null);
    await createKnowledgeReindexBatchHandler({ enqueue: jest.fn() })(
      event({ runId: RUN(8), kind: 'keywords' })
    );
    expect(await keywordRun.run()).toMatchObject({
      status: 'failed',
      lastError: expect.stringContaining('enrichment is off'),
    });
  });

  it('skips a link whose run no longer exists or already ended', async () => {
    seedRun(RUN(9), null);
    const enqueue = jest.fn();
    expect(
      await createKnowledgeReindexBatchHandler({ enqueue })(
        event({ runId: RUN(9), kind: 'lexical' })
      )
    ).toBe('skipped');
    seedRun(RUN(10), 'failed');
    expect(
      await createKnowledgeReindexBatchHandler({ enqueue })(
        event({ runId: RUN(10), kind: 'lexical' })
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
