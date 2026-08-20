/**
 * The mail bulk job handler's contract: one search expands a filter
 * selection; per-action batches execute with progress written back to the
 * row; archive marks before it moves and never moves a mark-failure; a
 * redelivered 'running' job is finalized, never re-executed; and the
 * handler never throws once the job is marked running.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('kysely', () => ({ sql: Object.assign(() => 'sql-fragment', { raw: () => '' }) }));
jest.mock('@renkei/connector-microsoft', () => ({
  GRAPH_BASE_URL: 'https://graph.microsoft.com/v1.0',
  graphBatch: jest.fn(),
  graphRequest: jest.fn(),
  buildMailQueryPath: jest.requireActual('@renkei/connector-microsoft/src/mail-filter')
    .buildMailQueryPath,
  withCategoryChanges: jest.requireActual('@renkei/connector-microsoft/src/mail-batch')
    .withCategoryChanges,
}));
jest.mock('./microsoft-access', () => ({ resolveMicrosoftAccess: jest.fn() }));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { createMailBulkJobHandler, MAX_JOB_MESSAGES } from './mail-bulk-jobs';
import type { ClaimedEvent } from '../queue';

const { getDatabase: getDatabaseMock } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const { graphBatch: graphBatchMock, graphRequest: graphRequestMock } = jest.requireMock<{
  graphBatch: jest.Mock;
  graphRequest: jest.Mock;
}>('@renkei/connector-microsoft');
const { resolveMicrosoftAccess: resolveAccessMock } = jest.requireMock<{
  resolveMicrosoftAccess: jest.Mock;
}>('./microsoft-access');

/** The job row served to the handler; updates are recorded, not applied. */
let jobRow: Record<string, unknown> | undefined;
let updates: Record<string, unknown>[] = [];

function fakeDb() {
  return {
    selectFrom: () => ({
      selectAll: () => ({
        where: () => ({
          where: () => ({ executeTakeFirst: async () => jobRow }),
        }),
      }),
    }),
    updateTable: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: () => ({ execute: async () => undefined }) };
      },
    }),
  };
}

function claimedEvent(): ClaimedEvent {
  return {
    id: 'evt-1',
    tenant_id: 'tenant-1',
    source: 'mailjobs',
    type: 'bulk-action',
    payload: { jobId: 'job-1' },
    attempts: 1,
  };
}

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'job-1',
    tenant_id: 'tenant-1',
    subject: 'user-1',
    account_id: 'acct-1',
    action: 'markRead',
    params: {},
    selection: { messageIds: ['m1', 'm2', 'm3'] },
    status: 'queued',
    total: null,
    succeeded: 0,
    failed: 0,
    failures: [],
    ...overrides,
  };
}

const ok = (id: string) => ({ id, ok: true, body: {} });
const bad = (id: string, error: string) => ({ id, ok: false, body: null, error });

beforeEach(() => {
  jest.clearAllMocks();
  updates = [];
  jobRow = undefined;
  getDatabaseMock.mockReturnValue({ ok: true, val: fakeDb() });
  resolveAccessMock.mockResolvedValue({
    accessToken: 'token',
    accountId: 'acct-1',
    upn: 'u',
    scopes: [],
  });
  graphBatchMock.mockImplementation(
    async (
      _token: string,
      requests: { id: string }[],
      options?: { onChunk?: (results: readonly unknown[]) => void | Promise<void> }
    ) => {
      const results = requests.map((request) => ok(request.id));
      if (options?.onChunk) await options.onChunk(results);
      return { results };
    }
  );
});

describe('createMailBulkJobHandler', () => {
  it('runs an explicit-ids markRead job to succeeded with counts on the row', async () => {
    jobRow = job();
    await createMailBulkJobHandler()(claimedEvent());

    expect(graphBatchMock).toHaveBeenCalledTimes(1);
    const [, requests] = graphBatchMock.mock.calls[0];
    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({
      method: 'PATCH',
      url: '/me/messages/m1',
      body: { isRead: true },
    });
    const final = updates[updates.length - 1];
    expect(final.status).toBe('succeeded');
    const progress = updates.find((update) => 'succeeded' in update && !('status' in update));
    expect(progress?.succeeded).toBe(3);
  });

  it('expands a filter selection with one paged search, subjectContains client-side', async () => {
    jobRow = job({
      selection: { filters: { isRead: false, subjectContains: 'invoice' }, maxMessages: 10 },
    });
    graphRequestMock.mockResolvedValue({
      ok: true,
      val: {
        value: [
          { id: 'a', subject: 'Invoice #1' },
          { id: 'b', subject: 'lunch?' },
          { id: 'c', subject: 'Re: invoice overdue' },
        ],
      },
    });

    await createMailBulkJobHandler()(claimedEvent());

    expect(graphRequestMock).toHaveBeenCalledTimes(1);
    const [, path] = graphRequestMock.mock.calls[0];
    expect(path).toContain('isRead%20eq%20false');
    expect(path).not.toContain('invoice');
    const [, requests] = graphBatchMock.mock.calls[0];
    expect(requests.map((request: { id: string }) => request.id)).toEqual(['a', 'c']);
    expect(updates.some((update) => update.total === 2)).toBe(true);
  });

  it('marks archive jobs read first and never moves a mark-failure', async () => {
    jobRow = job({ action: 'archive', params: {}, selection: { messageIds: ['m1', 'm2'] } });
    graphBatchMock
      .mockImplementationOnce(async () => ({ results: [ok('m1'), bad('m2', 'gone')] }))
      .mockImplementationOnce(
        async (
          _token: string,
          requests: { id: string }[],
          options?: { onChunk?: (results: readonly unknown[]) => void | Promise<void> }
        ) => {
          const results = requests.map((request) => ok(request.id));
          if (options?.onChunk) await options.onChunk(results);
          return { results };
        }
      );

    await createMailBulkJobHandler()(claimedEvent());

    const [, moveRequests] = graphBatchMock.mock.calls[1];
    expect(moveRequests).toHaveLength(1);
    expect(moveRequests[0]).toMatchObject({
      id: 'm1',
      method: 'POST',
      url: '/me/messages/m1/move',
      body: { destinationId: 'archive' },
    });
    expect(updates[updates.length - 1].status).toBe('partial');
  });

  it('finalizes a redelivered running job WITHOUT touching Graph', async () => {
    jobRow = job({ status: 'running', succeeded: 5, total: 10 });
    await createMailBulkJobHandler()(claimedEvent());

    expect(graphBatchMock).not.toHaveBeenCalled();
    expect(graphRequestMock).not.toHaveBeenCalled();
    expect(resolveAccessMock).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0].status).toBe('partial');
    expect(String(updates[0].last_error)).toContain('worker restarted mid-job');
  });

  it('is an idempotent no-op on a terminal job', async () => {
    jobRow = job({ status: 'succeeded' });
    await createMailBulkJobHandler()(claimedEvent());
    expect(updates).toHaveLength(0);
    expect(graphBatchMock).not.toHaveBeenCalled();
  });

  it('never throws after marking running — access failures land on the row', async () => {
    jobRow = job();
    resolveAccessMock.mockRejectedValue(new Error('no microsoft grant for account acct-1'));

    await expect(createMailBulkJobHandler()(claimedEvent())).resolves.toBeUndefined();
    const final = updates[updates.length - 1];
    expect(final.status).toBe('failed');
    expect(String(final.last_error)).toContain('no microsoft grant');
  });

  it('caps explicit selections at the job ceiling', async () => {
    jobRow = job({
      selection: { messageIds: Array.from({ length: 1500 }, (_u, index) => `m${index}`) },
    });
    await createMailBulkJobHandler()(claimedEvent());
    const [, requests] = graphBatchMock.mock.calls[0];
    expect(requests).toHaveLength(MAX_JOB_MESSAGES);
  });
});
