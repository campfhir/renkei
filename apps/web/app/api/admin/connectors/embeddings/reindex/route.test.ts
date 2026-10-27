/**
 * Pause/resume/start on the admin reindex route. The state machine lives
 * here (guarded status transitions, cursor passthrough on resume), so it is
 * worth pinning at the HTTP seam rather than trusting tsc alone — unlike
 * the worker handler's own tests (which cover the queue-chain side of the
 * same feature), nothing here previously exercised this route at all.
 */

jest.mock('@/lib/access', () => ({
  checkAccess: jest.fn(),
  ROLE_OPERATOR: 'renkei-operator',
}));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@renkei/queue', () => ({ embeddingJobsQueue: jest.fn() }));
jest.mock('@renkei/settings', () => ({ getOrgSettings: jest.fn() }));
jest.mock('@renkei/knowledge', () => ({
  isReindexKind: (value: unknown) =>
    value === 'lexical' || value === 'embed' || value === 'keywords',
  REINDEX_KINDS: ['lexical', 'embed', 'keywords'],
  resolveEmbeddingProvider: jest.fn(async () => ({ embed: jest.fn() })),
}));

import { NextRequest } from 'next/server';
import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type MemoryDataStore,
} from '@renkei/db';
import { POST } from './route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);
const { embeddingJobsQueue: mockQueue } = jest.requireMock<{ embeddingJobsQueue: jest.Mock }>(
  '@renkei/queue'
);

const RUN = '00000000-0000-4000-8000-000000000001';

interface RunSeed {
  kind: string;
  status: string;
  cursor?: string | null;
  last_error?: string | null;
  finished_at?: string | null;
}

/** A memory store holding one reindex run (or none), registered as the data store. */
async function storeWith(run?: RunSeed): Promise<MemoryDataStore> {
  const store = createMemoryDataStore();
  if (run) await store.seed({ knowledge_reindex_runs: [{ id: RUN, ...run }] });
  registerDataStore(store);
  return store;
}

const theRun = (store: MemoryDataStore, kind: string) => store.knowledgeReindexRuns.find(RUN, kind);

function reqOf(body: unknown): NextRequest {
  return new NextRequest(
    new Request('http://x/api/admin/acme/connectors/embeddings/reindex', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
}

let mockEnqueue: jest.Mock;

afterEach(() => resetDataStore());

beforeEach(() => {
  jest.clearAllMocks();
  mockCheckAccess.mockResolvedValue({ subject: 'auth0|alice' });
  mockEnqueue = jest.fn(async () => ({ ok: true }));
  mockQueue.mockReturnValue({ producer: { enqueue: mockEnqueue } });
});

describe('POST .../reindex', () => {
  it('starts a fresh run and enqueues the first link', async () => {
    const store = await storeWith();

    const response = await POST(reqOf({ kind: 'lexical' }));

    expect(response.status).toBe(200);
    const runs = await store.knowledgeReindexRuns.listRecent(10);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      kind: 'lexical',
      status: 'queued',
      requestedBy: 'auth0|alice',
    });
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ runId: runs[0]!.id, kind: 'lexical' }),
      })
    );
  });

  it('refuses to start a second run of the same kind while one is active', async () => {
    const store = await storeWith({ kind: 'lexical', status: 'running', cursor: null });

    const response = await POST(reqOf({ kind: 'lexical' }));

    expect(response.status).toBe(409);
    expect(await store.knowledgeReindexRuns.listRecent(10)).toHaveLength(1);
  });

  it('pauses an active run without touching its progress', async () => {
    const store = await storeWith({ kind: 'embed', status: 'running', cursor: 'row-50' });

    const response = await POST(reqOf({ kind: 'embed', action: 'pause', runId: RUN }));

    expect(response.status).toBe(200);
    expect(await theRun(store, 'embed')).toMatchObject({ status: 'paused', cursor: 'row-50' });
  });

  it('refuses to pause a run that is not active', async () => {
    const store = await storeWith({ kind: 'embed', status: 'done', cursor: null });

    const response = await POST(reqOf({ kind: 'embed', action: 'pause', runId: RUN }));

    expect(response.status).toBe(409);
    expect((await theRun(store, 'embed'))?.status).toBe('done');
  });

  it('resumes a failed run from its stored cursor instead of starting fresh', async () => {
    const store = await storeWith({
      kind: 'embed',
      status: 'failed',
      cursor: 'row-3328',
      last_error: 'embeddings endpoint returned 500',
      finished_at: '2026-01-01T00:00:00.000Z',
    });

    const response = await POST(reqOf({ kind: 'embed', action: 'resume', runId: RUN }));

    expect(response.status).toBe(200);
    expect(await theRun(store, 'embed')).toMatchObject({
      status: 'queued',
      lastError: null,
      finishedAt: null,
    });
    // No second row — resume reuses the same run, it does not start a new one.
    expect(await store.knowledgeReindexRuns.listRecent(10)).toHaveLength(1);
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ runId: RUN, kind: 'embed', cursor: 'row-3328' }),
      })
    );
  });

  it('resumes a paused run the same way', async () => {
    const store = await storeWith({ kind: 'embed', status: 'paused', cursor: 'row-42' });

    const response = await POST(reqOf({ kind: 'embed', action: 'resume', runId: RUN }));

    expect(response.status).toBe(200);
    expect((await theRun(store, 'embed'))?.status).toBe('queued');
  });

  it('refuses to resume a run that is active or already done', async () => {
    const store = await storeWith({ kind: 'embed', status: 'done', cursor: 'row-999' });

    const response = await POST(reqOf({ kind: 'embed', action: 'resume', runId: RUN }));

    expect(response.status).toBe(409);
    expect((await theRun(store, 'embed'))?.status).toBe('done');
  });

  it('requires runId for pause and resume', async () => {
    await storeWith();
    const pause = await POST(reqOf({ kind: 'embed', action: 'pause' }));
    expect(pause.status).toBe(400);
    const resume = await POST(reqOf({ kind: 'embed', action: 'resume' }));
    expect(resume.status).toBe(400);
  });
});
