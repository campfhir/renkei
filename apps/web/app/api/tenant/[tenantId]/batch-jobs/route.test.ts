/**
 * The batch-jobs start route: session-gated, refuses an unknown/unconnected
 * share, validates the grouping shape, and otherwise delegates to
 * startDocumentOcrPipeline — the same helper batch_start_document_pipeline
 * uses, so this test only pins the HTTP seam around it.
 */

jest.mock('@/lib/session', () => ({ getSessionFromRequest: jest.fn() }));
jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: true, val: {} }) }));
jest.mock('@renkei/connector-fileshares', () => ({ listConnectedShares: jest.fn() }));
jest.mock('@/lib/batch-jobs/start-document-ocr-pipeline', () => ({
  startDocumentOcrPipeline: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { POST } from './route';

const { getSessionFromRequest } = jest.requireMock<{ getSessionFromRequest: jest.Mock }>(
  '@/lib/session'
);
const { listConnectedShares } = jest.requireMock<{ listConnectedShares: jest.Mock }>(
  '@renkei/connector-fileshares'
);
const { startDocumentOcrPipeline } = jest.requireMock<{ startDocumentOcrPipeline: jest.Mock }>(
  '@/lib/batch-jobs/start-document-ocr-pipeline'
);

const SHARE_ID = '11111111-2222-3333-4444-555555555555';
const paramsOf = () => Promise.resolve({ tenantId: 'tenant-1' });

function reqOf(body: unknown): NextRequest {
  return new NextRequest(
    new Request('http://x/api/tenant/tenant-1/batch-jobs', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  getSessionFromRequest.mockResolvedValue({ subject: 'auth0|alice' });
  listConnectedShares.mockResolvedValue({ ok: true, val: [{ share: { id: SHARE_ID } }] });
  startDocumentOcrPipeline.mockResolvedValue({ id: 'batch-1' });
});

test('a signed-out request is refused', async () => {
  getSessionFromRequest.mockResolvedValue(null);
  const response = await POST(reqOf({ shareId: SHARE_ID, grouping: { strategy: 'whole-file' } }), {
    params: paramsOf(),
  });
  expect(response.status).toBe(401);
  expect(startDocumentOcrPipeline).not.toHaveBeenCalled();
});

test('a missing name is a 400 before any share lookup', async () => {
  const response = await POST(
    reqOf({ shareId: SHARE_ID, grouping: { strategy: 'whole-file' } }),
    { params: paramsOf() }
  );
  expect(response.status).toBe(400);
  expect(listConnectedShares).not.toHaveBeenCalled();
});

test('a missing shareId is a 400 before any share lookup', async () => {
  const response = await POST(reqOf({ name: 'Inbox OCR', grouping: { strategy: 'whole-file' } }), {
    params: paramsOf(),
  });
  expect(response.status).toBe(400);
  expect(listConnectedShares).not.toHaveBeenCalled();
});

test('an unknown or unconnected share is refused', async () => {
  listConnectedShares.mockResolvedValue({ ok: true, val: [] });
  const response = await POST(
    reqOf({ name: 'Inbox OCR', shareId: SHARE_ID, grouping: { strategy: 'whole-file' } }),
    { params: paramsOf() }
  );
  expect(response.status).toBe(400);
  expect(startDocumentOcrPipeline).not.toHaveBeenCalled();
});

test('a filename-pattern grouping without both named captures is refused', async () => {
  const response = await POST(
    reqOf({
      name: 'Inbox OCR',
      shareId: SHARE_ID,
      grouping: { strategy: 'filename-pattern', pattern: '^(?<documentKey>.+)\\.tif$' },
    }),
    { params: paramsOf() }
  );
  expect(response.status).toBe(400);
  expect(startDocumentOcrPipeline).not.toHaveBeenCalled();
});

test('an unparseable regex pattern is refused', async () => {
  const response = await POST(
    reqOf({
      name: 'Inbox OCR',
      shareId: SHARE_ID,
      grouping: { strategy: 'filename-pattern', pattern: '(?<documentKey>[unterminated' },
    }),
    { params: paramsOf() }
  );
  expect(response.status).toBe(400);
  expect(startDocumentOcrPipeline).not.toHaveBeenCalled();
});

test('an unrecognized grouping strategy is refused', async () => {
  const response = await POST(
    reqOf({ name: 'Inbox OCR', shareId: SHARE_ID, grouping: { strategy: 'by-vibes' } }),
    { params: paramsOf() }
  );
  expect(response.status).toBe(400);
});

test('starts the pipeline and returns the new batch id', async () => {
  const response = await POST(
    reqOf({ name: 'Inbox OCR', shareId: SHARE_ID, path: '/inbox', grouping: { strategy: 'whole-file' } }),
    { params: paramsOf() }
  );
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ batchId: 'batch-1' });
  expect(startDocumentOcrPipeline).toHaveBeenCalledWith(
    {},
    {
      tenantId: 'tenant-1',
      subject: 'auth0|alice',
      name: 'Inbox OCR',
      shareId: SHARE_ID,
      path: '/inbox',
      grouping: { strategy: 'whole-file' },
      // Stored explicitly at their defaults: the ledger on, the source kept.
      skipProcessed: true,
      afterProcessing: { action: 'keep' },
    }
  );
});

test('deleting source files is refused unless the connection allows delete tools', async () => {
  listConnectedShares.mockResolvedValue({
    ok: true,
    val: [
      {
        share: { id: SHARE_ID, name: 'Scans' },
        connection: { username: 'alice', toolAccess: 'read_write', allowDelete: false },
      },
    ],
  });
  const response = await POST(
    reqOf({
      name: 'Inbox OCR',
      shareId: SHARE_ID,
      grouping: { strategy: 'whole-file' },
      afterProcessing: { action: 'delete' },
    }),
    { params: paramsOf() }
  );
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain('delete tools');
  expect(startDocumentOcrPipeline).not.toHaveBeenCalled();
});

test('a malformed afterProcessing is a 400 before any share lookup', async () => {
  const response = await POST(
    reqOf({
      name: 'Inbox OCR',
      shareId: SHARE_ID,
      grouping: { strategy: 'whole-file' },
      afterProcessing: { action: 'archive' },
    }),
    { params: paramsOf() }
  );
  expect(response.status).toBe(400);
  expect(listConnectedShares).not.toHaveBeenCalled();
});

test('an empty path defaults to the share root', async () => {
  await POST(reqOf({ name: 'Inbox OCR', shareId: SHARE_ID, grouping: { strategy: 'whole-file' } }), {
    params: paramsOf(),
  });
  expect(startDocumentOcrPipeline).toHaveBeenCalledWith(
    {},
    expect.objectContaining({ path: '/' })
  );
});
