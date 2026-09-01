/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The one place batch_start_document_pipeline (an agent's MCP tool call)
 * and POST /api/tenant/[tenantId]/batch-jobs (a human's form submit) meet:
 * both must produce the identical createBatch config shape and enqueue the
 * discovery message the same way, or the two paths silently diverge.
 */

jest.mock('@renkei/batch-jobs-store', () => ({
  createBatch: jest.fn(),
  enqueueDiscover: jest.fn(),
  DOCUMENT_OCR_PIPELINE_KIND: 'document-ocr-pipeline',
}));
jest.mock('@renkei/queue', () => ({ batchJobsQueue: jest.fn() }));

import { createBatch, enqueueDiscover } from '@renkei/batch-jobs-store';
import { batchJobsQueue } from '@renkei/queue';
import { startDocumentOcrPipeline } from './start-document-ocr-pipeline';

const createBatchMock = createBatch as jest.Mock;
const enqueueDiscoverMock = enqueueDiscover as jest.Mock;
const batchJobsQueueMock = batchJobsQueue as jest.Mock;

const FAKE_DB = {};

beforeEach(() => {
  jest.clearAllMocks();
  batchJobsQueueMock.mockReturnValue({ producer: 'the-producer' });
});

describe('startDocumentOcrPipeline', () => {
  it('creates a batch with the config shape document-ocr-pipeline expects and enqueues discovery', async () => {
    createBatchMock.mockResolvedValue({ id: 'batch-1' });

    const batch = await startDocumentOcrPipeline(FAKE_DB as never, {
      tenantId: 'tenant-1',
      subject: 'auth0|alice',
      shareId: 'share-1',
      path: '/inbox',
      grouping: { strategy: 'whole-file' },
    });

    expect(createBatchMock).toHaveBeenCalledWith(FAKE_DB, {
      tenantId: 'tenant-1',
      subject: 'auth0|alice',
      kind: 'document-ocr-pipeline',
      config: { shareId: 'share-1', path: '/inbox', grouping: { strategy: 'whole-file' } },
    });
    expect(enqueueDiscoverMock).toHaveBeenCalledWith('the-producer', 'tenant-1', 'batch-1');
    expect(batch.id).toBe('batch-1');
  });

  it('defaults a missing/empty path to the share root', async () => {
    createBatchMock.mockResolvedValue({ id: 'batch-2' });

    await startDocumentOcrPipeline(FAKE_DB as never, {
      tenantId: 'tenant-1',
      subject: 'auth0|alice',
      shareId: 'share-1',
      grouping: { strategy: 'filename-pattern', pattern: '^(?<documentKey>.+)-p(?<page>\\d+)\\.tif$' },
    });

    expect(createBatchMock).toHaveBeenCalledWith(
      FAKE_DB,
      expect.objectContaining({ config: expect.objectContaining({ path: '/' }) })
    );
  });
});
