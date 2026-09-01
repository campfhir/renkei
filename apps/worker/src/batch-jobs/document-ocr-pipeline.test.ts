/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * document-ocr-pipeline's own contract: whole-file grouping is one file
 * per document; filename-pattern grouping correlates files by documentKey
 * and orders them by page number, and a file the pattern can't parse
 * becomes its own group rather than being dropped; runItem OCRs each
 * source file in order and assembles their pages into one staged sandbox
 * document.
 */

jest.mock('@renkei/fileshares-client', () => ({
  fsListFolder: jest.fn(),
  fsReadFile: jest.fn(),
  clientFailure: (err: { message?: string }) => ({ message: err.message ?? 'fileshare error' }),
}));
jest.mock('@renkei/sandbox-client', () => ({
  sbWriteFile: jest.fn(),
  clientFailure: (err: { message?: string }) => ({ message: err.message ?? 'sandbox error' }),
}));
jest.mock('@renkei/connector-mistral-ocr', () => ({
  callMistralOcr: jest.fn(),
  resolveMistralOcrConfig: jest.fn(),
  describeMistralOcrError: (err: { message?: string }) => err.message ?? 'ocr error',
}));

import { fsListFolder, fsReadFile } from '@renkei/fileshares-client';
import { sbWriteFile } from '@renkei/sandbox-client';
import { callMistralOcr, resolveMistralOcrConfig } from '@renkei/connector-mistral-ocr';
import { getBatchJobKind } from './kinds';
import './document-ocr-pipeline';
import type { BatchJobItemRow, BatchJobRow } from './store';

const fsListFolderMock = fsListFolder as jest.Mock;
const fsReadFileMock = fsReadFile as jest.Mock;
const sbWriteFileMock = sbWriteFile as jest.Mock;
const callMistralOcrMock = callMistralOcr as jest.Mock;
const resolveMistralOcrConfigMock = resolveMistralOcrConfig as jest.Mock;

const kind = getBatchJobKind('document-ocr-pipeline');
if (!kind) throw new Error('document-ocr-pipeline did not register itself');

function batch(config: Record<string, unknown>): BatchJobRow {
  return {
    id: 'batch-1',
    tenant_id: 'tenant-1',
    subject: 'auth0|alice',
    kind: 'document-ocr-pipeline',
    config,
    status: 'discovering',
    total: null,
    succeeded: 0,
    failed: 0,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('discover', () => {
  it('groups whole-file documents one-to-one with the source files', async () => {
    fsListFolderMock.mockResolvedValue({
      ok: true,
      val: {
        entries: [
          { path: '/in/invoice-1.pdf', kind: 'file' },
          { path: '/in/invoice-2.pdf', kind: 'file' },
          { path: '/in/subfolder', kind: 'dir' },
        ],
      },
    });

    const outcome = await kind.discover(
      undefined as never,
      batch({ shareId: 'share-1', path: '/in', grouping: { strategy: 'whole-file' } })
    );

    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.items).toEqual([
      { documentKey: 'invoice-1', sourcePaths: ['/in/invoice-1.pdf'], shareId: 'share-1' },
      { documentKey: 'invoice-2', sourcePaths: ['/in/invoice-2.pdf'], shareId: 'share-1' },
    ]);
  });

  it('correlates per-page files by documentKey and orders them by page', async () => {
    fsListFolderMock.mockResolvedValue({
      ok: true,
      val: {
        entries: [
          { path: '/in/inv-7-p2.tif', kind: 'file' },
          { path: '/in/inv-7-p1.tif', kind: 'file' },
          { path: '/in/inv-8-p1.tif', kind: 'file' },
        ],
      },
    });

    const outcome = await kind.discover(
      undefined as never,
      batch({
        shareId: 'share-1',
        path: '/in',
        grouping: { strategy: 'filename-pattern', pattern: '^(?<documentKey>.+)-p(?<page>\\d+)\\.tif$' },
      })
    );

    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.items).toEqual(
      expect.arrayContaining([
        { documentKey: 'inv-7', sourcePaths: ['/in/inv-7-p1.tif', '/in/inv-7-p2.tif'], shareId: 'share-1' },
        { documentKey: 'inv-8', sourcePaths: ['/in/inv-8-p1.tif'], shareId: 'share-1' },
      ])
    );
    expect(outcome.items).toHaveLength(2);
  });

  it('keeps a file the pattern cannot parse as its own group instead of dropping it', async () => {
    fsListFolderMock.mockResolvedValue({
      ok: true,
      val: { entries: [{ path: '/in/unrelated-notes.tif', kind: 'file' }] },
    });

    const outcome = await kind.discover(
      undefined as never,
      batch({
        shareId: 'share-1',
        path: '/in',
        grouping: { strategy: 'filename-pattern', pattern: '^(?<documentKey>.+)-p(?<page>\\d+)\\.tif$' },
      })
    );

    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.items).toEqual([
      { documentKey: 'unrelated-notes', sourcePaths: ['/in/unrelated-notes.tif'], shareId: 'share-1' },
    ]);
  });

  it('fails cleanly when the fileshare listing fails', async () => {
    fsListFolderMock.mockResolvedValue({ ok: false, err: { message: 'share not connected' } });

    const outcome = await kind.discover(
      undefined as never,
      batch({ shareId: 'share-1', path: '/in', grouping: { strategy: 'whole-file' } })
    );

    expect(outcome).toEqual({ ok: false, error: 'share not connected' });
  });

  it('rejects a pattern missing the required named capture groups', async () => {
    const outcome = await kind.discover(
      undefined as never,
      batch({ shareId: 'share-1', path: '/in', grouping: { strategy: 'filename-pattern', pattern: '.*' } })
    );
    expect(outcome.ok).toBe(false);
    expect(fsListFolderMock).not.toHaveBeenCalled();
  });
});

describe('runItem', () => {
  function item(overrides: Partial<BatchJobItemRow['payload']> = {}): BatchJobItemRow {
    return {
      id: 'item-1',
      batch_id: 'batch-1',
      status: 'processing',
      payload: { documentKey: 'inv-7', shareId: 'share-1', sourcePaths: ['/in/inv-7-p1.tif', '/in/inv-7-p2.tif'], ...overrides },
      result: null,
    };
  }

  it('OCRs each source file in order and assembles pages into one staged document', async () => {
    resolveMistralOcrConfigMock.mockResolvedValue({ ok: true, val: { endpoint: 'x', model: 'm', apiKey: 'k' } });
    fsReadFileMock
      .mockResolvedValueOnce({ ok: true, val: new Uint8Array([1]) })
      .mockResolvedValueOnce({ ok: true, val: new Uint8Array([2]) });
    callMistralOcrMock
      .mockResolvedValueOnce({ ok: true, val: { pages: [{ index: 0, markdown: 'page one' }], pagesProcessed: 1 } })
      .mockResolvedValueOnce({ ok: true, val: { pages: [{ index: 0, markdown: 'page two' }], pagesProcessed: 1 } });
    sbWriteFileMock.mockResolvedValue({ ok: true, val: { id: 'file-1' } });

    const outcome = await kind.runItem(
      undefined as never,
      batch({}),
      item()
    );

    expect(fsReadFileMock).toHaveBeenNthCalledWith(1, expect.anything(), '/in/inv-7-p1.tif');
    expect(fsReadFileMock).toHaveBeenNthCalledWith(2, expect.anything(), '/in/inv-7-p2.tif');
    const [, writeInput, bytes] = sbWriteFileMock.mock.calls[0] as [unknown, { filename: string }, Uint8Array];
    expect(writeInput.filename).toBe('inv-7.md');
    expect(new TextDecoder().decode(bytes)).toBe('page one\n\n---\n\npage two');
    expect(outcome).toEqual({
      ok: true,
      result: {
        documentKey: 'inv-7',
        sandboxFileId: 'file-1',
        pageCount: 2,
        sourcePaths: ['/in/inv-7-p1.tif', '/in/inv-7-p2.tif'],
      },
    });
  });

  it('fails without calling OCR when the Mistral connector is not configured', async () => {
    resolveMistralOcrConfigMock.mockResolvedValue({ ok: false, err: 'unconfigured' });

    const outcome = await kind.runItem(
      undefined as never,
      batch({}),
      item()
    );

    expect(outcome.ok).toBe(false);
    expect(fsReadFileMock).not.toHaveBeenCalled();
  });

  it('fails the item when a page fails to read from the share', async () => {
    resolveMistralOcrConfigMock.mockResolvedValue({ ok: true, val: { endpoint: 'x', model: 'm', apiKey: 'k' } });
    fsReadFileMock.mockResolvedValue({ ok: false, err: { message: 'not found' } });

    const outcome = await kind.runItem(
      undefined as never,
      batch({}),
      item()
    );

    expect(outcome).toEqual({ ok: false, error: 'not found' });
    expect(callMistralOcrMock).not.toHaveBeenCalled();
  });
});
