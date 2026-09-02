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
jest.mock('@renkei/connector-fileshares', () => ({ listConnectedShares: jest.fn() }));
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
import { listConnectedShares } from '@renkei/connector-fileshares';
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
const listConnectedSharesMock = listConnectedShares as jest.Mock;

/** One connected share, with the exposure its owner chose on the Connectors page. */
function connected(id: string, toolAccess: 'read' | 'read_write', allowDelete: boolean) {
  return { share: { id, name: `Share ${id}` }, connection: { username: 'alice', toolAccess, allowDelete } };
}
const callMistralOcrMock = callMistralOcr as jest.Mock;
const resolveMistralOcrConfigMock = resolveMistralOcrConfig as jest.Mock;
const sbReadFileMock = sbReadFile as jest.Mock;

const FAKE_DB = {};
const DEST_SHARE = '5d1f1a0e-6c7b-4e2a-9f3c-1b2d3e4f5a6b';

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
  listConnectedSharesMock.mockResolvedValue({ ok: true, val: [connected('share-1', 'read', false)] });
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
      config: {
        shareId: 'share-1',
        path: '/in',
        grouping: { strategy: 'whole-file' },
        skipProcessed: true,
        afterProcessing: { action: 'keep' },
      },
      scheduleId: undefined,
    });
    expect(enqueueDiscoverMock).toHaveBeenCalledWith('the-producer', 'tenant-1', 'batch-1');
    expect(result.content[0]?.text).toContain('batch-1');
  });

  it('refuses a share the caller has not connected', async () => {
    listConnectedSharesMock.mockResolvedValue({ ok: true, val: [] });
    const handlers = registerAll();

    const result = await handlers.get('batch_start_document_pipeline')!({
      name: 'Inbox OCR',
      shareId: 'share-1',
      grouping: { strategy: 'whole-file' },
    });

    expect(result.isError).toBe(true);
    expect(createBatchMock).not.toHaveBeenCalled();
  });

  it('refuses to delete or move source files beyond what the connection allows the tools', async () => {
    const handlers = registerAll();

    const result = await handlers.get('batch_start_document_pipeline')!({
      name: 'Inbox OCR',
      shareId: 'share-1',
      grouping: { strategy: 'whole-file' },
      afterProcessing: { action: 'delete' },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('write tools');
    expect(createBatchMock).not.toHaveBeenCalled();
  });

  it('stores the opt-outs and opt-ins when the connection allows them', async () => {
    listConnectedSharesMock.mockResolvedValue({
      ok: true,
      // A real uuid: the tool validates the destination the way the MCP
      // schema would, and a placeholder id is refused before consent is.
      val: [connected('share-1', 'read_write', true), connected(DEST_SHARE, 'read_write', false)],
    });
    createBatchMock.mockResolvedValue({ id: 'batch-1' });
    const handlers = registerAll();

    await handlers.get('batch_start_document_pipeline')!({
      name: 'Inbox OCR',
      shareId: 'share-1',
      grouping: { strategy: 'whole-file' },
      skipProcessed: false,
      afterProcessing: { action: 'move', shareId: DEST_SHARE, path: 'archive/' },
    });

    expect(createBatchMock).toHaveBeenCalledWith(
      FAKE_DB,
      expect.objectContaining({
        config: expect.objectContaining({
          skipProcessed: false,
          afterProcessing: { action: 'move', shareId: DEST_SHARE, path: '/archive' },
        }),
      })
    );
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
      skipped: 0,
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
