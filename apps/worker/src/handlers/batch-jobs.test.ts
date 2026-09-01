/**
 * The batch-job handlers' own contract: discovery claims 'queued' →
 * 'discovering' and never re-runs a redelivered mid-discovery job; items
 * claim 'pending' → 'processing' and never re-run a redelivered mid-item
 * one (both would double an external, possibly-billed call); an unknown
 * kind fails cleanly; and a successful discovery creates + enqueues one
 * item per discovered payload, in order.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('../batch-jobs/store', () => ({
  getBatch: jest.fn(),
  beginDiscovery: jest.fn(),
  failBatch: jest.fn(),
  completeEmptyBatch: jest.fn(),
  activateBatch: jest.fn(),
  insertItem: jest.fn(),
  getItem: jest.fn(),
  claimItem: jest.fn(),
  recordItemOutcome: jest.fn(),
}));
jest.mock('../batch-jobs/kinds', () => ({ getBatchJobKind: jest.fn() }));
jest.mock('../batch-jobs/enqueue', () => ({ enqueueItem: jest.fn(), BATCH_JOB_SOURCE: 'batch' }));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { createBatchDiscoverHandler, createBatchItemHandler } from './batch-jobs';
import type { ClaimedEvent } from '../queue';

const { getDatabase: getDatabaseMock } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');
const store = jest.requireMock<{
  getBatch: jest.Mock;
  beginDiscovery: jest.Mock;
  failBatch: jest.Mock;
  completeEmptyBatch: jest.Mock;
  activateBatch: jest.Mock;
  insertItem: jest.Mock;
  getItem: jest.Mock;
  claimItem: jest.Mock;
  recordItemOutcome: jest.Mock;
}>('../batch-jobs/store');
const { getBatchJobKind } = jest.requireMock<{ getBatchJobKind: jest.Mock }>('../batch-jobs/kinds');
const { enqueueItem } = jest.requireMock<{ enqueueItem: jest.Mock }>('../batch-jobs/enqueue');

const FAKE_DB = {};

function event(type: string, payload: Record<string, string>): ClaimedEvent {
  return { id: 'evt-1', tenant_id: 'tenant-1', source: 'batch', type, payload, attempts: 1 };
}

function batch(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'batch-1',
    tenant_id: 'tenant-1',
    subject: 'auth0|alice',
    kind: 'document-ocr-pipeline',
    config: {},
    status: 'queued',
    total: null,
    succeeded: 0,
    failed: 0,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  getDatabaseMock.mockReturnValue({ ok: true, val: FAKE_DB });
});

describe('discover handler', () => {
  const handler = createBatchDiscoverHandler({ enqueue: jest.fn() });

  it('drops silently when the batch does not exist', async () => {
    store.getBatch.mockResolvedValue(undefined);
    await handler(event('discover', { batchJobId: 'batch-1' }));
    expect(store.beginDiscovery).not.toHaveBeenCalled();
  });

  it('finalizes as failed, without re-running, when redelivered mid-discovery', async () => {
    store.getBatch.mockResolvedValue(batch({ status: 'discovering' }));
    await handler(event('discover', { batchJobId: 'batch-1' }));
    expect(store.failBatch).toHaveBeenCalledWith(FAKE_DB, 'batch-1', expect.stringContaining('restarted'));
    expect(store.beginDiscovery).not.toHaveBeenCalled();
  });

  it('is an idempotent no-op when the batch already reached a terminal status', async () => {
    store.getBatch.mockResolvedValue(batch({ status: 'succeeded' }));
    await handler(event('discover', { batchJobId: 'batch-1' }));
    expect(store.failBatch).not.toHaveBeenCalled();
    expect(store.beginDiscovery).not.toHaveBeenCalled();
  });

  it('fails the batch cleanly for an unregistered kind', async () => {
    store.getBatch.mockResolvedValue(batch());
    store.beginDiscovery.mockResolvedValue(batch({ status: 'discovering' }));
    getBatchJobKind.mockReturnValue(undefined);

    await handler(event('discover', { batchJobId: 'batch-1' }));

    expect(store.failBatch).toHaveBeenCalledWith(FAKE_DB, 'batch-1', expect.stringContaining('Unknown batch kind'));
  });

  it('completes an empty discovery immediately, with no items created', async () => {
    store.getBatch.mockResolvedValue(batch());
    store.beginDiscovery.mockResolvedValue(batch({ status: 'discovering' }));
    getBatchJobKind.mockReturnValue({ discover: jest.fn().mockResolvedValue({ ok: true, items: [] }) });

    await handler(event('discover', { batchJobId: 'batch-1' }));

    expect(store.completeEmptyBatch).toHaveBeenCalledWith(FAKE_DB, 'batch-1');
    expect(store.insertItem).not.toHaveBeenCalled();
  });

  it('creates and enqueues one item per discovered payload, then activates the batch', async () => {
    store.getBatch.mockResolvedValue(batch());
    store.beginDiscovery.mockResolvedValue(batch({ status: 'discovering' }));
    getBatchJobKind.mockReturnValue({
      discover: jest.fn().mockResolvedValue({
        ok: true,
        items: [{ sourcePaths: ['/a.tif'] }, { sourcePaths: ['/b.tif'] }],
      }),
    });
    store.insertItem
      .mockResolvedValueOnce({ id: 'item-1', batch_id: 'batch-1' })
      .mockResolvedValueOnce({ id: 'item-2', batch_id: 'batch-1' });

    await handler(event('discover', { batchJobId: 'batch-1' }));

    expect(store.insertItem).toHaveBeenNthCalledWith(1, FAKE_DB, 'batch-1', { sourcePaths: ['/a.tif'] });
    expect(store.insertItem).toHaveBeenNthCalledWith(2, FAKE_DB, 'batch-1', { sourcePaths: ['/b.tif'] });
    expect(enqueueItem).toHaveBeenNthCalledWith(1, expect.anything(), 'tenant-1', 'batch-1', 'item-1');
    expect(enqueueItem).toHaveBeenNthCalledWith(2, expect.anything(), 'tenant-1', 'batch-1', 'item-2');
    expect(store.activateBatch).toHaveBeenCalledWith(FAKE_DB, 'batch-1', 2);
  });

  it('fails the batch when the kind handler throws', async () => {
    store.getBatch.mockResolvedValue(batch());
    store.beginDiscovery.mockResolvedValue(batch({ status: 'discovering' }));
    getBatchJobKind.mockReturnValue({ discover: jest.fn().mockRejectedValue(new Error('share unreachable')) });

    await handler(event('discover', { batchJobId: 'batch-1' }));

    expect(store.failBatch).toHaveBeenCalledWith(FAKE_DB, 'batch-1', 'share unreachable');
  });
});

describe('item handler', () => {
  const handler = createBatchItemHandler();
  const item = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: 'item-1',
    batch_id: 'batch-1',
    status: 'pending',
    payload: {},
    result: null,
    ...overrides,
  });

  it('drops silently when the item does not belong to the named batch', async () => {
    store.getBatch.mockResolvedValue(batch());
    store.getItem.mockResolvedValue(item({ batch_id: 'some-other-batch' }));
    await handler(event('item', { batchJobId: 'batch-1', itemId: 'item-1' }));
    expect(store.claimItem).not.toHaveBeenCalled();
  });

  it('finalizes as failed, without re-running, when redelivered mid-item', async () => {
    store.getBatch.mockResolvedValue(batch());
    store.getItem.mockResolvedValue(item({ status: 'processing' }));

    await handler(event('item', { batchJobId: 'batch-1', itemId: 'item-1' }));

    expect(store.recordItemOutcome).toHaveBeenCalledWith(FAKE_DB, 'batch-1', 'item-1', {
      ok: false,
      error: expect.stringContaining('restarted'),
    });
    expect(store.claimItem).not.toHaveBeenCalled();
  });

  it('is an idempotent no-op when the item already reached a terminal status', async () => {
    store.getBatch.mockResolvedValue(batch());
    store.getItem.mockResolvedValue(item({ status: 'succeeded' }));

    await handler(event('item', { batchJobId: 'batch-1', itemId: 'item-1' }));

    expect(store.recordItemOutcome).not.toHaveBeenCalled();
    expect(store.claimItem).not.toHaveBeenCalled();
  });

  it('records the kind handler outcome for a claimed item', async () => {
    store.getBatch.mockResolvedValue(batch());
    store.getItem.mockResolvedValue(item());
    store.claimItem.mockResolvedValue(item({ status: 'processing' }));
    getBatchJobKind.mockReturnValue({
      runItem: jest.fn().mockResolvedValue({ ok: true, result: { sandboxFileId: 'file-1' } }),
    });

    await handler(event('item', { batchJobId: 'batch-1', itemId: 'item-1' }));

    expect(store.recordItemOutcome).toHaveBeenCalledWith(FAKE_DB, 'batch-1', 'item-1', {
      ok: true,
      result: { sandboxFileId: 'file-1' },
    });
  });

  it('records a failure when the kind handler throws, rather than leaving the item stuck', async () => {
    store.getBatch.mockResolvedValue(batch());
    store.getItem.mockResolvedValue(item());
    store.claimItem.mockResolvedValue(item({ status: 'processing' }));
    getBatchJobKind.mockReturnValue({ runItem: jest.fn().mockRejectedValue(new Error('OCR timed out')) });

    await handler(event('item', { batchJobId: 'batch-1', itemId: 'item-1' }));

    expect(store.recordItemOutcome).toHaveBeenCalledWith(FAKE_DB, 'batch-1', 'item-1', {
      ok: false,
      error: 'OCR timed out',
    });
  });
});
