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
jest.mock('@/lib/tenant-slug', () => ({ tenantForSlug: jest.fn() }));
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/queue', () => ({ embeddingJobsQueue: jest.fn() }));
jest.mock('@renkei/settings', () => ({ getOrgSettings: jest.fn() }));
jest.mock('@renkei/knowledge', () => ({
  isReindexKind: (value: unknown) =>
    value === 'lexical' || value === 'embed' || value === 'keywords',
  REINDEX_KINDS: ['lexical', 'embed', 'keywords'],
  resolveEmbeddingProvider: jest.fn(async () => ({ embed: jest.fn() })),
}));

import { NextRequest } from 'next/server';
import { POST } from './route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);
const { tenantForSlug: mockTenantForSlug } = jest.requireMock<{ tenantForSlug: jest.Mock }>(
  '@/lib/tenant-slug'
);
const { embeddingJobsQueue: mockQueue } = jest.requireMock<{ embeddingJobsQueue: jest.Mock }>(
  '@renkei/queue'
);
const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>(
  '@renkei/db'
);

interface RunRow {
  id: string;
  tenant_id: string;
  kind: string;
  status: string;
  cursor: string | null;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

type Where = [string, string, unknown];

function matches(row: RunRow, wheres: Where[]): boolean {
  return wheres.every(([col, op, val]) => {
    const cell = Reflect.get(row, col);
    return op === 'in' ? Array.isArray(val) && val.includes(cell) : cell === val;
  });
}

/** A minimal in-memory `knowledge_reindex_runs` table over Kysely's shape. */
function fakeDb(seed: RunRow[]) {
  const rows = [...seed];
  const inserted: RunRow[] = [];

  function select() {
    const wheres: Where[] = [];
    const builder = {
      select: () => builder,
      where: (col: string, op: string, val: unknown) => {
        wheres.push([col, op, val]);
        return builder;
      },
      orderBy: () => builder,
      limit: () => builder,
      executeTakeFirst: async () => rows.find((row) => matches(row, wheres)),
      execute: async () => rows.filter((row) => matches(row, wheres)),
    };
    return builder;
  }

  function update() {
    const wheres: Where[] = [];
    let patch: Record<string, unknown> = {};
    const builder = {
      set: (values: Record<string, unknown>) => {
        patch = values;
        return builder;
      },
      where: (col: string, op: string, val: unknown) => {
        wheres.push([col, op, val]);
        return builder;
      },
      executeTakeFirst: async () => {
        let count = 0;
        for (const row of rows) {
          if (matches(row, wheres)) {
            Object.assign(row, patch);
            count += 1;
          }
        }
        return { numUpdatedRows: BigInt(count) };
      },
      execute: async function execute() {
        return this.executeTakeFirst();
      },
    };
    return builder;
  }

  return {
    rows,
    inserted,
    ok: true as const,
    val: {
      selectFrom: () => select(),
      updateTable: () => update(),
      insertInto: () => ({
        values: (values: Record<string, unknown>) => ({
          execute: async () => {
            const id = typeof values.id === 'string' ? values.id : '';
            const tenantId = typeof values.tenant_id === 'string' ? values.tenant_id : '';
            const kind = typeof values.kind === 'string' ? values.kind : '';
            const row: RunRow = {
              id,
              tenant_id: tenantId,
              kind,
              status: 'queued',
              cursor: null,
              last_error: null,
              created_at: new Date().toISOString(),
              started_at: null,
              finished_at: null,
            };
            rows.push(row);
            inserted.push(row);
          },
        }),
      }),
    },
  };
}

const TENANT = { id: 'tenant-1', slug: 'acme' };

function reqOf(body: unknown): NextRequest {
  return new NextRequest(
    new Request('http://x/api/admin/acme/connectors/embeddings/reindex', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
}
const paramsOf = () => Promise.resolve({ slug: 'acme' });

let mockEnqueue: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockTenantForSlug.mockResolvedValue(TENANT);
  mockCheckAccess.mockResolvedValue({ subject: 'auth0|alice' });
  mockEnqueue = jest.fn(async () => ({ ok: true }));
  mockQueue.mockReturnValue({ producer: { enqueue: mockEnqueue } });
});

describe('POST .../reindex', () => {
  it('starts a fresh run and enqueues the first link', async () => {
    const db = fakeDb([]);
    mockGetDatabase.mockReturnValue(db);

    const response = await POST(reqOf({ kind: 'lexical' }), { params: paramsOf() });

    expect(response.status).toBe(200);
    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0]).toMatchObject({ kind: 'lexical', status: 'queued' });
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ runId: db.inserted[0]!.id, kind: 'lexical' }),
      })
    );
  });

  it('refuses to start a second run of the same kind while one is active', async () => {
    const db = fakeDb([
      {
        id: 'run-1',
        tenant_id: 'tenant-1',
        kind: 'lexical',
        status: 'running',
        cursor: null,
        last_error: null,
        created_at: '',
        started_at: null,
        finished_at: null,
      },
    ]);
    mockGetDatabase.mockReturnValue(db);

    const response = await POST(reqOf({ kind: 'lexical' }), { params: paramsOf() });

    expect(response.status).toBe(409);
    expect(db.inserted).toHaveLength(0);
  });

  it('pauses an active run without touching its progress', async () => {
    const db = fakeDb([
      {
        id: 'run-1',
        tenant_id: 'tenant-1',
        kind: 'embed',
        status: 'running',
        cursor: 'row-50',
        last_error: null,
        created_at: '',
        started_at: null,
        finished_at: null,
      },
    ]);
    mockGetDatabase.mockReturnValue(db);

    const response = await POST(
      reqOf({ kind: 'embed', action: 'pause', runId: 'run-1' }),
      { params: paramsOf() }
    );

    expect(response.status).toBe(200);
    expect(db.rows[0]).toMatchObject({ status: 'paused', cursor: 'row-50' });
  });

  it('refuses to pause a run that is not active', async () => {
    const db = fakeDb([
      {
        id: 'run-1',
        tenant_id: 'tenant-1',
        kind: 'embed',
        status: 'done',
        cursor: null,
        last_error: null,
        created_at: '',
        started_at: null,
        finished_at: null,
      },
    ]);
    mockGetDatabase.mockReturnValue(db);

    const response = await POST(
      reqOf({ kind: 'embed', action: 'pause', runId: 'run-1' }),
      { params: paramsOf() }
    );

    expect(response.status).toBe(409);
    expect(db.rows[0]!.status).toBe('done');
  });

  it('resumes a failed run from its stored cursor instead of starting fresh', async () => {
    const db = fakeDb([
      {
        id: 'run-1',
        tenant_id: 'tenant-1',
        kind: 'embed',
        status: 'failed',
        cursor: 'row-3328',
        last_error: 'embeddings endpoint returned 500',
        created_at: '',
        started_at: null,
        finished_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    mockGetDatabase.mockReturnValue(db);

    const response = await POST(
      reqOf({ kind: 'embed', action: 'resume', runId: 'run-1' }),
      { params: paramsOf() }
    );

    expect(response.status).toBe(200);
    expect(db.rows[0]).toMatchObject({ status: 'queued', last_error: null, finished_at: null });
    // No second row — resume reuses the same run, it does not start a new one.
    expect(db.inserted).toHaveLength(0);
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ runId: 'run-1', kind: 'embed', cursor: 'row-3328' }),
      })
    );
  });

  it('resumes a paused run the same way', async () => {
    const db = fakeDb([
      {
        id: 'run-1',
        tenant_id: 'tenant-1',
        kind: 'embed',
        status: 'paused',
        cursor: 'row-42',
        last_error: null,
        created_at: '',
        started_at: null,
        finished_at: null,
      },
    ]);
    mockGetDatabase.mockReturnValue(db);

    const response = await POST(
      reqOf({ kind: 'embed', action: 'resume', runId: 'run-1' }),
      { params: paramsOf() }
    );

    expect(response.status).toBe(200);
    expect(db.rows[0]!.status).toBe('queued');
  });

  it('refuses to resume a run that is active or already done', async () => {
    const db = fakeDb([
      {
        id: 'run-1',
        tenant_id: 'tenant-1',
        kind: 'embed',
        status: 'done',
        cursor: 'row-999',
        last_error: null,
        created_at: '',
        started_at: null,
        finished_at: null,
      },
    ]);
    mockGetDatabase.mockReturnValue(db);

    const response = await POST(
      reqOf({ kind: 'embed', action: 'resume', runId: 'run-1' }),
      { params: paramsOf() }
    );

    expect(response.status).toBe(409);
    expect(db.rows[0]!.status).toBe('done');
  });

  it('requires runId for pause and resume', async () => {
    mockGetDatabase.mockReturnValue(fakeDb([]));
    const pause = await POST(reqOf({ kind: 'embed', action: 'pause' }), { params: paramsOf() });
    expect(pause.status).toBe(400);
    const resume = await POST(reqOf({ kind: 'embed', action: 'resume' }), { params: paramsOf() });
    expect(resume.status).toBe(400);
  });
});
