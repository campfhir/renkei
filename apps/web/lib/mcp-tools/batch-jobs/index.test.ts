/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * batch_* / sandbox_ocr_file's own contract: starting a pipeline creates a
 * batch row and enqueues its discovery message; status/list tools never
 * leak another subject's batch (id alone is not enough — a mismatched
 * subject reads as "no such batch job", not a permission error, so ids
 * are not an existence oracle); sandbox_ocr_file refuses when the
 * connector is unconfigured, and truncates a long OCR result.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/batch-jobs-store', () => ({
  createBatch: jest.fn(),
  getBatch: jest.fn(),
  listBatches: jest.fn(),
  listItems: jest.fn(),
  enqueueDiscover: jest.fn(),
  DOCUMENT_OCR_PIPELINE_KIND: 'document-ocr-pipeline',
}));
jest.mock('@renkei/queue', () => ({ batchJobsQueue: jest.fn() }));
jest.mock('@renkei/connector-mistral-ocr', () => ({
  callMistralOcr: jest.fn(),
  resolveMistralOcrConfig: jest.fn(),
  describeMistralOcrError: (err: { message?: string }) => err.message ?? 'ocr error',
}));
jest.mock('@renkei/sandbox-client', () => ({
  sbReadFile: jest.fn(),
  clientFailure: (err: { message?: string }) => ({ message: err.message ?? 'sandbox error' }),
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { getDatabase } from '@renkei/db';
import { createBatch, getBatch, listBatches, listItems, enqueueDiscover } from '@renkei/batch-jobs-store';
import { batchJobsQueue } from '@renkei/queue';
import { callMistralOcr, resolveMistralOcrConfig } from '@renkei/connector-mistral-ocr';
import { sbReadFile } from '@renkei/sandbox-client';
import { registerBatchJobTools } from './index';
import type { MCPToolContext } from '../common';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

const getDatabaseMock = getDatabase as jest.Mock;
const createBatchMock = createBatch as jest.Mock;
const getBatchMock = getBatch as jest.Mock;
const listBatchesMock = listBatches as jest.Mock;
const listItemsMock = listItems as jest.Mock;
const enqueueDiscoverMock = enqueueDiscover as jest.Mock;
const batchJobsQueueMock = batchJobsQueue as jest.Mock;
const callMistralOcrMock = callMistralOcr as jest.Mock;
const resolveMistralOcrConfigMock = resolveMistralOcrConfig as jest.Mock;
const sbReadFileMock = sbReadFile as jest.Mock;

const FAKE_DB = {};

function context(): MCPToolContext {
  return { tenantId: 'tenant-1', subject: 'auth0|alice' } as unknown as MCPToolContext;
}

function registerAll(): Map<string, Handler> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  registerBatchJobTools(server, context());
  return registered;
}

beforeEach(() => {
  jest.clearAllMocks();
  getDatabaseMock.mockReturnValue({ ok: true, val: FAKE_DB });
  batchJobsQueueMock.mockReturnValue({ producer: 'the-producer' });
});

describe('batch_start_document_pipeline', () => {
  it('creates a batch row and enqueues its discovery message', async () => {
    createBatchMock.mockResolvedValue({ id: 'batch-1' });
    const handlers = registerAll();

    const result = await handlers.get('batch_start_document_pipeline')!({
      name: 'Inbox OCR',
      shareId: 'share-1',
      path: '/in',
      grouping: { strategy: 'whole-file' },
    });

    expect(createBatchMock).toHaveBeenCalledWith(FAKE_DB, {
      tenantId: 'tenant-1',
      subject: 'auth0|alice',
      name: 'Inbox OCR',
      kind: 'document-ocr-pipeline',
      config: { shareId: 'share-1', path: '/in', grouping: { strategy: 'whole-file' } },
      scheduleId: undefined,
    });
    expect(enqueueDiscoverMock).toHaveBeenCalledWith('the-producer', 'tenant-1', 'batch-1');
    expect(result.content[0]?.text).toContain('batch-1');
  });
});

describe('batch_get_job', () => {
  it('reports a batch this subject owns', async () => {
    getBatchMock.mockResolvedValue({
      id: 'batch-1',
      subject: 'auth0|alice',
      kind: 'document-ocr-pipeline',
      status: 'running',
      total: 10,
      succeeded: 3,
      failed: 1,
    });
    const handlers = registerAll();

    const result = await handlers.get('batch_get_job')!({ batchId: 'batch-1' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('running');
    expect(result.content[0]?.text).toContain('4/10');
  });

  it('answers "no such batch job" for a batch owned by a different subject', async () => {
    getBatchMock.mockResolvedValue({ id: 'batch-1', subject: 'someone-else', status: 'running' });
    const handlers = registerAll();

    const result = await handlers.get('batch_get_job')!({ batchId: 'batch-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('No such batch job.');
  });

  it('answers the same for a batch that does not exist at all', async () => {
    getBatchMock.mockResolvedValue(undefined);
    const handlers = registerAll();

    const result = await handlers.get('batch_get_job')!({ batchId: 'batch-1' });

    expect(result.content[0]?.text).toBe('No such batch job.');
  });
});

describe('batch_list_jobs', () => {
  it('lists nothing gracefully', async () => {
    listBatchesMock.mockResolvedValue([]);
    const handlers = registerAll();
    const result = await handlers.get('batch_list_jobs')!({});
    expect(result.content[0]?.text).toContain('No batch jobs');
  });
});

describe('batch_list_items', () => {
  it('scopes by the batch\'s owning subject before listing items', async () => {
    getBatchMock.mockResolvedValue({ id: 'batch-1', subject: 'auth0|alice' });
    listItemsMock.mockResolvedValue([
      { id: 'item-1', payload: { documentKey: 'inv-7' }, status: 'succeeded', result: { sandboxFileId: 'file-1' } },
    ]);
    const handlers = registerAll();

    const result = await handlers.get('batch_list_items')!({ batchId: 'batch-1' });

    expect(result.content[0]?.text).toContain('inv-7');
    expect(result.content[0]?.text).toContain('file-1');
  });
});

describe('sandbox_ocr_file', () => {
  it('refuses when the Mistral connector is not configured', async () => {
    resolveMistralOcrConfigMock.mockResolvedValue({ ok: false, err: 'unconfigured' });
    const handlers = registerAll();

    const result = await handlers.get('sandbox_ocr_file')!({ fileId: 'file-1' });

    expect(result.isError).toBe(true);
    expect(sbReadFileMock).not.toHaveBeenCalled();
  });

  it('returns the OCR text on success', async () => {
    resolveMistralOcrConfigMock.mockResolvedValue({ ok: true, val: { endpoint: 'x', model: 'm', apiKey: 'k' } });
    sbReadFileMock.mockResolvedValue({
      ok: true,
      val: { filename: 'report.pdf', contentType: 'application/pdf', bytes: new Uint8Array([1]) },
    });
    callMistralOcrMock.mockResolvedValue({
      ok: true,
      val: { pages: [{ index: 0, markdown: 'hello world' }], pagesProcessed: 1 },
    });
    const handlers = registerAll();

    const result = await handlers.get('sandbox_ocr_file')!({ fileId: 'file-1' });

    expect(result.content[0]?.text).toBe('hello world');
  });

  it('truncates a very long OCR result with a note', async () => {
    resolveMistralOcrConfigMock.mockResolvedValue({ ok: true, val: { endpoint: 'x', model: 'm', apiKey: 'k' } });
    sbReadFileMock.mockResolvedValue({
      ok: true,
      val: { filename: 'report.pdf', contentType: 'application/pdf', bytes: new Uint8Array([1]) },
    });
    callMistralOcrMock.mockResolvedValue({
      ok: true,
      val: { pages: [{ index: 0, markdown: 'x'.repeat(70_000) }], pagesProcessed: 1 },
    });
    const handlers = registerAll();

    const result = await handlers.get('sandbox_ocr_file')!({ fileId: 'file-1' });

    expect(result.content[0]?.text).toContain('[note: truncated');
  });
});
