/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * document-ocr-pipeline's own contract: whole-file grouping is one file
 * per document; filename-pattern grouping correlates files by documentKey
 * and orders them by page number, and a file the pattern can't parse
 * becomes its own group rather than being dropped; runItem OCRs each
 * source file in order and assembles their pages into one staged sandbox
 * document.
 *
 * And the two things a nightly batch needs: a file already processed is
 * skipped deterministically (by stat at discovery, by content hash at item
 * time, both BEFORE the billed OCR call), and a processed source file can
 * be deleted or moved — on the same share or across shares — with a
 * failure there failing the item rather than passing silently.
 */

jest.mock('@renkei/fileshares-client', () => ({
  fsListFolder: jest.fn(),
  fsReadFile: jest.fn(),
  fsRemoveEntry: jest.fn(),
  fsMoveEntry: jest.fn(),
  fsStatEntry: jest.fn(),
  fsWriteFile: jest.fn(),
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
jest.mock('@renkei/batch-jobs-store', () => ({
  ...jest.requireActual<Record<string, unknown>>('@renkei/batch-jobs-store'),
  findProcessedByPath: jest.fn(),
  findProcessedHashes: jest.fn(),
  recordProcessedFiles: jest.fn(),
}));

import { createHash } from 'node:crypto';
import {
  fsListFolder,
  fsMoveEntry,
  fsReadFile,
  fsRemoveEntry,
  fsStatEntry,
  fsWriteFile,
} from '@renkei/fileshares-client';
import { sbWriteFile } from '@renkei/sandbox-client';
import { callMistralOcr, resolveMistralOcrConfig } from '@renkei/connector-mistral-ocr';
import {
  findProcessedByPath,
  findProcessedHashes,
  recordProcessedFiles,
} from '@renkei/batch-jobs-store';
import { getBatchJobKind } from './kinds';
import './document-ocr-pipeline';
import type { BatchJobItemRow, BatchJobRow } from './store';

const fsListFolderMock = fsListFolder as jest.Mock;
const fsReadFileMock = fsReadFile as jest.Mock;
const fsRemoveEntryMock = fsRemoveEntry as jest.Mock;
const fsMoveEntryMock = fsMoveEntry as jest.Mock;
const fsStatEntryMock = fsStatEntry as jest.Mock;
const fsWriteFileMock = fsWriteFile as jest.Mock;
const sbWriteFileMock = sbWriteFile as jest.Mock;
const callMistralOcrMock = callMistralOcr as jest.Mock;
const resolveMistralOcrConfigMock = resolveMistralOcrConfig as jest.Mock;
const findProcessedByPathMock = findProcessedByPath as jest.Mock;
const findProcessedHashesMock = findProcessedHashes as jest.Mock;
const recordProcessedFilesMock = recordProcessedFiles as jest.Mock;

const kind = getBatchJobKind('document-ocr-pipeline');
if (!kind) throw new Error('document-ocr-pipeline did not register itself');

const DB = {} as never;

const sha = (bytes: number[]) => createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');

function batch(config: Record<string, unknown>): BatchJobRow {
  return {
    id: 'batch-1',
    tenant_id: 'tenant-1',
    subject: 'auth0|alice',
    name: 'Test batch',
    kind: 'document-ocr-pipeline',
    config: { shareId: 'share-1', path: '/in', grouping: { strategy: 'whole-file' }, ...config },
    status: 'discovering',
    total: null,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    last_error: null,
    schedule_id: null,
    started_at: null,
    finished_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
  };
}

const entry = (path: string, size = 10, modifiedAt = '2026-01-01T00:00:00.000Z') => ({
  path,
  kind: 'file',
  size,
  modifiedAt,
});
const source = (path: string, size = 10, modifiedAt = '2026-01-01T00:00:00.000Z') => ({
  path,
  size,
  modifiedAt,
});

beforeEach(() => {
  jest.clearAllMocks();
  findProcessedByPathMock.mockResolvedValue(new Map());
  findProcessedHashesMock.mockResolvedValue(new Set());
  recordProcessedFilesMock.mockResolvedValue(undefined);
});

describe('discover', () => {
  it('groups whole-file documents one-to-one with the source files', async () => {
    fsListFolderMock.mockResolvedValue({
      ok: true,
      val: {
        entries: [
          entry('/in/invoice-1.pdf'),
          entry('/in/invoice-2.pdf'),
          { path: '/in/subfolder', kind: 'dir', size: null, modifiedAt: null },
        ],
      },
    });

    const outcome = await kind.discover(DB, batch({}));

    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.items).toEqual([
      {
        documentKey: 'invoice-1',
        sourcePaths: ['/in/invoice-1.pdf'],
        sources: [source('/in/invoice-1.pdf')],
        shareId: 'share-1',
      },
      {
        documentKey: 'invoice-2',
        sourcePaths: ['/in/invoice-2.pdf'],
        sources: [source('/in/invoice-2.pdf')],
        shareId: 'share-1',
      },
    ]);
    expect(outcome.skipped).toEqual([]);
  });

  it('correlates per-page files by documentKey and orders them by page', async () => {
    fsListFolderMock.mockResolvedValue({
      ok: true,
      val: {
        entries: [entry('/in/inv-7-p2.tif'), entry('/in/inv-7-p1.tif'), entry('/in/inv-8-p1.tif')],
      },
    });

    const outcome = await kind.discover(
      DB,
      batch({
        grouping: {
          strategy: 'filename-pattern',
          pattern: '^(?<documentKey>.+)-p(?<page>\\d+)\\.tif$',
        },
      })
    );

    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentKey: 'inv-7',
          sourcePaths: ['/in/inv-7-p1.tif', '/in/inv-7-p2.tif'],
        }),
        expect.objectContaining({ documentKey: 'inv-8', sourcePaths: ['/in/inv-8-p1.tif'] }),
      ])
    );
    expect(outcome.items).toHaveLength(2);
  });

  it('keeps a file the pattern cannot parse as its own group instead of dropping it', async () => {
    fsListFolderMock.mockResolvedValue({
      ok: true,
      val: { entries: [entry('/in/unrelated-notes.tif')] },
    });

    const outcome = await kind.discover(
      DB,
      batch({
        grouping: {
          strategy: 'filename-pattern',
          pattern: '^(?<documentKey>.+)-p(?<page>\\d+)\\.tif$',
        },
      })
    );

    if (!outcome.ok) throw new Error(outcome.error);
    expect(outcome.items).toEqual([
      expect.objectContaining({
        documentKey: 'unrelated-notes',
        sourcePaths: ['/in/unrelated-notes.tif'],
      }),
    ]);
  });

  it('fails cleanly when the fileshare listing fails', async () => {
    fsListFolderMock.mockResolvedValue({ ok: false, err: { message: 'share not connected' } });
    const outcome = await kind.discover(DB, batch({}));
    expect(outcome).toEqual({ ok: false, error: 'share not connected' });
  });

  it('rejects a pattern missing the required named capture groups', async () => {
    const outcome = await kind.discover(
      DB,
      batch({ grouping: { strategy: 'filename-pattern', pattern: '.*' } })
    );
    expect(outcome.ok).toBe(false);
    expect(fsListFolderMock).not.toHaveBeenCalled();
  });

  it('rejects an afterProcessing move with no destination share', async () => {
    const outcome = await kind.discover(
      DB,
      batch({ afterProcessing: { action: 'move', path: '/done' } })
    );
    expect(outcome.ok).toBe(false);
    expect(fsListFolderMock).not.toHaveBeenCalled();
  });

  describe('the fast path over the ledger', () => {
    it('skips a file whose path, size and modified time match the ledger, without reading it', async () => {
      fsListFolderMock.mockResolvedValue({
        ok: true,
        val: {
          entries: [entry('/in/old.pdf', 10, '2026-01-01T00:00:00.000Z'), entry('/in/new.pdf', 11)],
        },
      });
      findProcessedByPathMock.mockResolvedValue(
        new Map([
          [
            '/in/old.pdf',
            {
              contentHash: 'h',
              path: '/in/old.pdf',
              size: 10,
              modifiedAt: new Date('2026-01-01T00:00:00Z'),
            },
          ],
        ])
      );

      const outcome = await kind.discover(DB, batch({}));

      if (!outcome.ok) throw new Error(outcome.error);
      expect(findProcessedByPathMock).toHaveBeenCalledWith(DB, 'tenant-1', 'share-1', [
        '/in/old.pdf',
        '/in/new.pdf',
      ]);
      expect(outcome.items).toEqual([expect.objectContaining({ documentKey: 'new' })]);
      expect(outcome.skipped).toEqual([
        expect.objectContaining({ documentKey: 'old', skipReason: 'already-processed' }),
      ]);
      expect(fsReadFileMock).not.toHaveBeenCalled();
    });

    it('does not skip a file whose stat changed — item time will hash it', async () => {
      fsListFolderMock.mockResolvedValue({
        ok: true,
        val: { entries: [entry('/in/old.pdf', 10, '2026-02-01T00:00:00.000Z')] },
      });
      findProcessedByPathMock.mockResolvedValue(
        new Map([
          [
            '/in/old.pdf',
            {
              contentHash: 'h',
              path: '/in/old.pdf',
              size: 10,
              modifiedAt: new Date('2026-01-01T00:00:00Z'),
            },
          ],
        ])
      );

      const outcome = await kind.discover(DB, batch({}));

      if (!outcome.ok) throw new Error(outcome.error);
      expect(outcome.items).toHaveLength(1);
      expect(outcome.skipped).toEqual([]);
    });

    it('skips a multi-file document only when every one of its files is known', async () => {
      fsListFolderMock.mockResolvedValue({
        ok: true,
        val: { entries: [entry('/in/inv-7-p1.tif'), entry('/in/inv-7-p2.tif')] },
      });
      findProcessedByPathMock.mockResolvedValue(
        new Map([
          [
            '/in/inv-7-p1.tif',
            {
              contentHash: 'a',
              path: '/in/inv-7-p1.tif',
              size: 10,
              modifiedAt: new Date('2026-01-01T00:00:00Z'),
            },
          ],
        ])
      );

      const outcome = await kind.discover(
        DB,
        batch({
          grouping: {
            strategy: 'filename-pattern',
            pattern: '^(?<documentKey>.+)-p(?<page>\\d+)\\.tif$',
          },
        })
      );

      if (!outcome.ok) throw new Error(outcome.error);
      expect(outcome.items).toHaveLength(1);
      expect(outcome.skipped).toEqual([]);
    });

    it('never consults the ledger when the batch opted out', async () => {
      fsListFolderMock.mockResolvedValue({ ok: true, val: { entries: [entry('/in/old.pdf')] } });

      const outcome = await kind.discover(DB, batch({ skipProcessed: false }));

      if (!outcome.ok) throw new Error(outcome.error);
      expect(findProcessedByPathMock).not.toHaveBeenCalled();
      expect(outcome.items).toHaveLength(1);
    });
  });
});

describe('runItem', () => {
  function item(overrides: Partial<BatchJobItemRow['payload']> = {}): BatchJobItemRow {
    return {
      id: 'item-1',
      batch_id: 'batch-1',
      status: 'processing',
      payload: {
        documentKey: 'inv-7',
        shareId: 'share-1',
        sourcePaths: ['/in/inv-7-p1.tif', '/in/inv-7-p2.tif'],
        sources: [source('/in/inv-7-p1.tif', 1), source('/in/inv-7-p2.tif', 1)],
        ...overrides,
      },
      result: null,
      error: null,
    };
  }

  function happyPath() {
    resolveMistralOcrConfigMock.mockResolvedValue({
      ok: true,
      val: { endpoint: 'x', model: 'm', apiKey: 'k' },
    });
    fsReadFileMock
      .mockResolvedValueOnce({ ok: true, val: new Uint8Array([1]) })
      .mockResolvedValueOnce({ ok: true, val: new Uint8Array([2]) });
    callMistralOcrMock
      .mockResolvedValueOnce({
        ok: true,
        val: { pages: [{ index: 0, markdown: 'page one' }], pagesProcessed: 1 },
      })
      .mockResolvedValueOnce({
        ok: true,
        val: { pages: [{ index: 0, markdown: 'page two' }], pagesProcessed: 1 },
      });
    sbWriteFileMock.mockResolvedValue({ ok: true, val: { id: 'file-1' } });
  }

  it('OCRs each source file in order, assembles pages into one staged document, and records the ledger', async () => {
    happyPath();

    const outcome = await kind.runItem(DB, batch({}), item());

    expect(fsReadFileMock).toHaveBeenNthCalledWith(1, expect.anything(), '/in/inv-7-p1.tif');
    expect(fsReadFileMock).toHaveBeenNthCalledWith(2, expect.anything(), '/in/inv-7-p2.tif');
    const [, writeInput, bytes] = sbWriteFileMock.mock.calls[0] as [
      unknown,
      { filename: string },
      Uint8Array,
    ];
    expect(writeInput.filename).toBe('inv-7.md');
    expect(new TextDecoder().decode(bytes)).toBe('page one\n\n---\n\npage two');
    expect(outcome).toEqual({
      ok: true,
      result: {
        documentKey: 'inv-7',
        sandboxFileId: 'file-1',
        pageCount: 2,
        sourcePaths: ['/in/inv-7-p1.tif', '/in/inv-7-p2.tif'],
        contentHashes: [sha([1]), sha([2])],
      },
    });
    expect(recordProcessedFilesMock).toHaveBeenCalledWith(DB, 'tenant-1', 'share-1', 'batch-1', [
      expect.objectContaining({
        contentHash: sha([1]),
        path: '/in/inv-7-p1.tif',
        size: 1,
        documentKey: 'inv-7',
      }),
      expect.objectContaining({
        contentHash: sha([2]),
        path: '/in/inv-7-p2.tif',
        size: 1,
        documentKey: 'inv-7',
      }),
    ]);
    // Nothing was asked for, so nothing happens to the source.
    expect(fsRemoveEntryMock).not.toHaveBeenCalled();
    expect(fsMoveEntryMock).not.toHaveBeenCalled();
  });

  it('skips the billed OCR call when every file’s hash is already in the ledger', async () => {
    resolveMistralOcrConfigMock.mockResolvedValue({
      ok: true,
      val: { endpoint: 'x', model: 'm', apiKey: 'k' },
    });
    fsReadFileMock
      .mockResolvedValueOnce({ ok: true, val: new Uint8Array([1]) })
      .mockResolvedValueOnce({ ok: true, val: new Uint8Array([2]) });
    findProcessedHashesMock.mockResolvedValue(new Set([sha([1]), sha([2])]));

    const outcome = await kind.runItem(DB, batch({}), item());

    expect(findProcessedHashesMock).toHaveBeenCalledWith(DB, 'tenant-1', 'share-1', [
      sha([1]),
      sha([2]),
    ]);
    expect(callMistralOcrMock).not.toHaveBeenCalled();
    expect(sbWriteFileMock).not.toHaveBeenCalled();
    expect(recordProcessedFilesMock).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      ok: true,
      skipped: true,
      result: expect.objectContaining({ documentKey: 'inv-7', reason: 'already-processed' }),
    });
  });

  it('processes the whole document again when only some of its files are known', async () => {
    happyPath();
    findProcessedHashesMock.mockResolvedValue(new Set([sha([1])]));

    const outcome = await kind.runItem(DB, batch({}), item());

    expect(callMistralOcrMock).toHaveBeenCalledTimes(2);
    expect(outcome.ok).toBe(true);
    expect(outcome.skipped).toBeUndefined();
  });

  it('neither reads nor writes the ledger when the batch opted out', async () => {
    happyPath();

    const outcome = await kind.runItem(DB, batch({ skipProcessed: false }), item());

    expect(outcome.ok).toBe(true);
    expect(findProcessedHashesMock).not.toHaveBeenCalled();
    expect(recordProcessedFilesMock).not.toHaveBeenCalled();
  });

  it('still succeeds when the ledger write fails — the OCR is done and staged', async () => {
    happyPath();
    recordProcessedFilesMock.mockRejectedValue(new Error('db down'));

    const outcome = await kind.runItem(DB, batch({}), item());

    expect(outcome.ok).toBe(true);
    expect(outcome.result?.sandboxFileId).toBe('file-1');
  });

  it('fails without calling OCR when the Mistral connector is not configured', async () => {
    resolveMistralOcrConfigMock.mockResolvedValue({ ok: false, err: 'unconfigured' });
    const outcome = await kind.runItem(DB, batch({}), item());
    expect(outcome.ok).toBe(false);
    expect(fsReadFileMock).not.toHaveBeenCalled();
  });

  it('fails the item when a page fails to read from the share', async () => {
    resolveMistralOcrConfigMock.mockResolvedValue({
      ok: true,
      val: { endpoint: 'x', model: 'm', apiKey: 'k' },
    });
    fsReadFileMock.mockResolvedValue({ ok: false, err: { message: 'not found' } });

    const outcome = await kind.runItem(DB, batch({}), item());

    expect(outcome).toEqual({ ok: false, error: 'not found' });
    expect(callMistralOcrMock).not.toHaveBeenCalled();
  });

  it('reads items written before `sources` existed from their paths alone', async () => {
    happyPath();
    const outcome = await kind.runItem(DB, batch({}), item({ sources: undefined }));
    expect(outcome.ok).toBe(true);
    expect(fsReadFileMock).toHaveBeenCalledTimes(2);
  });

  describe('afterProcessing', () => {
    it('deletes each source file after staging when asked', async () => {
      happyPath();
      fsRemoveEntryMock.mockResolvedValue({ ok: true, val: {} });

      const outcome = await kind.runItem(
        DB,
        batch({ afterProcessing: { action: 'delete' } }),
        item()
      );

      expect(fsRemoveEntryMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ shareId: 'share-1' }),
        '/in/inv-7-p1.tif'
      );
      expect(fsRemoveEntryMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ shareId: 'share-1' }),
        '/in/inv-7-p2.tif'
      );
      expect(outcome.ok).toBe(true);
      expect(outcome.result?.afterProcessing).toEqual({
        action: 'delete',
        removed: ['/in/inv-7-p1.tif', '/in/inv-7-p2.tif'],
      });
    });

    it('moves on the same share as a server-side move', async () => {
      happyPath();
      fsMoveEntryMock
        .mockResolvedValueOnce({ ok: true, val: { path: '/done/inv-7-p1.tif', unchanged: false } })
        .mockResolvedValueOnce({ ok: true, val: { path: '/done/inv-7-p2.tif', unchanged: false } });

      const outcome = await kind.runItem(
        DB,
        batch({ afterProcessing: { action: 'move', shareId: 'share-1', path: '/done' } }),
        item()
      );

      expect(fsMoveEntryMock).toHaveBeenCalledWith(
        expect.objectContaining({ shareId: 'share-1' }),
        '/in/inv-7-p1.tif',
        '/done'
      );
      expect(fsWriteFileMock).not.toHaveBeenCalled();
      expect(fsRemoveEntryMock).not.toHaveBeenCalled();
      expect(outcome.result?.afterProcessing).toEqual({
        action: 'move',
        shareId: 'share-1',
        movedTo: ['/done/inv-7-p1.tif', '/done/inv-7-p2.tif'],
      });
    });

    it('moves across shares by writing the bytes it already read, then removing the source', async () => {
      happyPath();
      fsStatEntryMock.mockResolvedValue({
        ok: false,
        err: { kind: 'op', type: 'not_found', message: 'no' },
      });
      fsWriteFileMock
        .mockResolvedValueOnce({ ok: true, val: { path: '/archive/inv-7-p1.tif' } })
        .mockResolvedValueOnce({ ok: true, val: { path: '/archive/inv-7-p2.tif' } });
      fsRemoveEntryMock.mockResolvedValue({ ok: true, val: {} });

      const outcome = await kind.runItem(
        DB,
        batch({ afterProcessing: { action: 'move', shareId: 'share-2', path: '/archive' } }),
        item()
      );

      expect(fsStatEntryMock).toHaveBeenCalledWith(
        expect.objectContaining({ shareId: 'share-2' }),
        '/archive/inv-7-p1.tif'
      );
      const [target, path, bytes] = fsWriteFileMock.mock.calls[0] as [
        { shareId: string },
        string,
        Uint8Array,
      ];
      expect(target.shareId).toBe('share-2');
      expect(path).toBe('/archive/inv-7-p1.tif');
      expect(Array.from(bytes)).toEqual([1]);
      expect(fsRemoveEntryMock).toHaveBeenCalledWith(
        expect.objectContaining({ shareId: 'share-1' }),
        '/in/inv-7-p1.tif'
      );
      expect(fsMoveEntryMock).not.toHaveBeenCalled();
      expect(outcome.ok).toBe(true);
      expect(outcome.result?.afterProcessing).toEqual({
        action: 'move',
        shareId: 'share-2',
        movedTo: ['/archive/inv-7-p1.tif', '/archive/inv-7-p2.tif'],
      });
    });

    it('never clobbers: a cross-share destination that exists fails the item, staged file kept', async () => {
      happyPath();
      fsStatEntryMock.mockResolvedValue({ ok: true, val: { path: '/archive/inv-7-p1.tif' } });

      const outcome = await kind.runItem(
        DB,
        batch({ afterProcessing: { action: 'move', shareId: 'share-2', path: '/archive' } }),
        item()
      );

      expect(fsWriteFileMock).not.toHaveBeenCalled();
      expect(fsRemoveEntryMock).not.toHaveBeenCalled();
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain('sandbox file file-1');
      expect(outcome.error).toContain('already exists');
      expect(outcome.result?.sandboxFileId).toBe('file-1');
      // The ledger still has the hash: a rerun skips the OCR, not the fix.
      expect(recordProcessedFilesMock).toHaveBeenCalledTimes(1);
    });

    it('fails the item when a delete is refused, naming the file', async () => {
      happyPath();
      fsRemoveEntryMock.mockResolvedValue({ ok: false, err: { message: 'access denied' } });

      const outcome = await kind.runItem(
        DB,
        batch({ afterProcessing: { action: 'delete' } }),
        item()
      );

      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain('could not delete /in/inv-7-p1.tif: access denied');
      expect(outcome.result?.afterProcessing).toEqual({
        action: 'delete',
        error: expect.stringContaining('access denied'),
      });
    });
  });
});
