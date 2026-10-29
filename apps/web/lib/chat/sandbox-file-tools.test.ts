/* eslint-disable @typescript-eslint/consistent-type-assertions -- a null db for fakes that never touch it */
/**
 * The two doors between a chat's files and the sandbox: TO it, a file
 * found by id or by name (a tool's own file by the name it reported,
 * "last" for the newest one a tool made) and staged as the chat's;
 * FROM it, a staged file read back and handed over as an artifact under
 * its own name and type — or refused, with why, when it is missing,
 * empty or over what a chat keeps.
 */

jest.mock('@renkei/sandbox-client', () => ({
  sbReadFile: jest.fn(),
  sbWriteFile: jest.fn(),
}));
jest.mock('@renkei/blob-store', () => ({ resolveTenantBlobStore: jest.fn() }));
// The rows are faked; the read of their bytes is the real one, over the faked store.
jest.mock('./attachments', () => ({
  ...jest.requireActual<typeof import('./attachments')>('./attachments'),
  listAttachments: jest.fn(),
  listProjectArtifacts: jest.fn(),
}));
jest.mock('./attachment-tools', () => ({ findAttachment: jest.fn() }));
jest.mock('./artifact-access', () => ({ fileCipherFor: jest.fn() }));
// The org's attachment limit, set to 1 MiB so the test's oversize file stays small.
jest.mock('@renkei/settings', () => ({
  getOrgSettings: async () => ({ ok: true, val: { maxAttachmentBytes: 1_048_576 } }),
}));

import { sbReadFile, sbWriteFile } from '@renkei/sandbox-client';
import { resolveTenantBlobStore } from '@renkei/blob-store';
import { findAttachment } from './attachment-tools';
import { fileCipherFor } from './artifact-access';
import { listAttachments, listProjectArtifacts, type AttachmentRow } from './attachments';
import { createLocalToolSet, type LocalToolContext } from './local-tools';
import {
  ATTACH_FROM_SANDBOX_TOOL,
  ATTACH_TO_SANDBOX_TOOL,
  pickByName,
  sandboxFileTools,
} from './sandbox-file-tools';
import { resourceCipher } from './content-crypto';

const readMock = jest.mocked(sbReadFile);
const writeMock = jest.mocked(sbWriteFile);
const storeMock = jest.mocked(resolveTenantBlobStore);
const listMock = jest.mocked(listAttachments);
const listProjectMock = jest.mocked(listProjectArtifacts);
const findMock = jest.mocked(findAttachment);
const cipherMock = jest.mocked(fileCipherFor);

const testCipher = resourceCipher({
  id: '00000000-0000-4000-8000-00000000c1fe',
  key: Buffer.alloc(32, 7),
});

function context(extra: Partial<LocalToolContext> = {}): LocalToolContext {
  return {
    subject: 'auth0|alice',
    chatId: 'chat-1',
    cipher: testCipher,
    projectId: null,
    readOnly: false,
    ...extra,
  };
}

function row(
  filename: string,
  extra: Partial<AttachmentRow> & { at?: number } = {}
): AttachmentRow {
  const { at = 0, ...rest } = extra;
  return {
    id: `id-${filename}`,
    ownerSubject: 'auth0|alice',
    chatId: 'chat-1',
    keyKind: 'chat',
    keyRef: 'chat-1',
    messageId: null,
    blobKey: `blob/${filename}`,
    filename,
    contentType: 'application/octet-stream',
    sizeBytes: 10,
    extractStatus: 'unsupported',
    origin: 'upload',
    summary: null,
    keywords: [],
    digestStatus: 'none',
    createdAt: new Date(at),
    updatedAt: new Date(at),
    ...rest,
  };
}

const STAGED = {
  id: '22222222-2222-4222-8222-222222222222',
  filename: 'report.docx',
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  sizeBytes: 3,
  source: 'script',
  batchId: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  expiresAt: '2026-10-21T10:00:00.000Z',
};

interface Doc {
  mediaType: string;
  dataBase64: string;
  title: string;
}
const documentsOf = (meta: Record<string, unknown>): Doc[] =>
  Array.isArray(meta.renkeiDocuments) ? (meta.renkeiDocuments as Doc[]) : [];

const tools = createLocalToolSet(sandboxFileTools());

const putMock = jest.fn(async () => ({ ok: true, val: undefined }));

beforeEach(() => {
  jest.clearAllMocks();
  cipherMock.mockResolvedValue(testCipher);
  // What the store holds is the file sealed under the chat's key.
  storeMock.mockResolvedValue({
    ok: true,
    val: {
      getObject: jest.fn(async (key: string) => {
        const sealed = testCipher.sealBytes(Buffer.from(`bytes of ${key}`));
        return {
          ok: true,
          val: { bytes: sealed.ok ? sealed.val : Buffer.alloc(0), contentType: 'image/png' },
        };
      }),
      putObject: putMock,
    },
  } as never);
  writeMock.mockResolvedValue({ ok: true, val: { ...STAGED, filename: 'cover.png' } } as never);
});

describe('pickByName', () => {
  const files = [
    row('brief.docx', { at: 1 }),
    row('cover.png', { at: 2, origin: 'model' }),
    row('Cover-v2.PNG', { at: 3, origin: 'model' }),
    row('notes.txt', { at: 4 }),
  ];

  it('matches a name exactly first, ignoring case, newest first', () => {
    expect(pickByName(files, 'cover.png')).toMatchObject({
      ok: true,
      file: { filename: 'cover.png' },
    });
    expect(pickByName(files, 'COVER-V2.png')).toMatchObject({
      ok: true,
      file: { filename: 'Cover-v2.PNG' },
    });
  });

  it('falls back to a part of a name, newest first', () => {
    expect(pickByName(files, 'cover')).toMatchObject({
      ok: true,
      file: { filename: 'Cover-v2.PNG' },
    });
  });

  it('reads "last" as the newest file a tool made, else the newest of any kind', () => {
    expect(pickByName(files, 'last')).toMatchObject({
      ok: true,
      file: { filename: 'Cover-v2.PNG' },
    });
    expect(pickByName([row('a.txt'), row('b.txt', { at: 1 })], 'latest')).toMatchObject({
      ok: true,
      file: { filename: 'b.txt' },
    });
  });

  it('says what is there when nothing matches, and when nothing is there', () => {
    const missing = pickByName(files, 'deck.pptx');
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.reason).toContain('No file called "deck.pptx"');
      expect(missing.reason).toContain('notes.txt, Cover-v2.PNG, cover.png, brief.docx');
    }
    expect(pickByName([], 'x')).toMatchObject({ ok: false });
  });
});

describe(ATTACH_TO_SANDBOX_TOOL, () => {
  it('is an act tool that takes an id or a name', () => {
    const def = tools.defs().find((tool) => tool.name === ATTACH_TO_SANDBOX_TOOL);
    expect(def?.inputSchema.required).toEqual([]);
    expect(Object.keys(def?.inputSchema.properties ?? {}).sort()).toEqual([
      'attachmentId',
      'filename',
    ]);
    expect(tools.readOnlyNames()).not.toContain(ATTACH_TO_SANDBOX_TOOL);
    expect(def?.description).toMatch(/sandbox_run_python/);
  });

  it('stages a file found by id as the chat’s own, under its name and type', async () => {
    findMock.mockResolvedValue({
      id: 'a1',
      filename: 'cover.png',
      contentType: 'image/png',
      blobKey: 'blob/cover.png',
      extractedText: null,
      extractStatus: 'unsupported',
      cipher: testCipher,
    });
    const result = await tools.run(ATTACH_TO_SANDBOX_TOOL, { attachmentId: 'a1' }, context());
    expect(result.isError).toBe(false);
    expect(findMock).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'chat-1' }), 'a1');
    expect(writeMock).toHaveBeenCalledWith(
      { subject: 'auth0|alice' },
      { filename: 'cover.png', contentType: 'image/png', source: 'chat' },
      Buffer.from('bytes of blob/cover.png')
    );
    expect(result.content[0]?.text).toContain(
      `Staged cover.png in the sandbox as file ${STAGED.id}`
    );
    expect(listMock).not.toHaveBeenCalled();
  });

  it('stages into the chat’s own scratch space when the turn names one', async () => {
    findMock.mockResolvedValue({
      id: 'a1',
      filename: 'cover.png',
      contentType: 'image/png',
      blobKey: 'blob/cover.png',
      extractedText: null,
      extractStatus: 'unsupported',
      cipher: testCipher,
    });
    const result = await tools.run(
      ATTACH_TO_SANDBOX_TOOL,
      { attachmentId: 'a1' },
      context({ sandboxScope: 'chat:chat-1' })
    );
    expect(result.isError).toBe(false);
    expect(writeMock).toHaveBeenCalledWith(
      { subject: 'auth0|alice', scope: 'chat:chat-1' },
      { filename: 'cover.png', contentType: 'image/png', source: 'chat' },
      Buffer.from('bytes of blob/cover.png')
    );
  });

  it('stages a file found by name among the chat’s and its project’s files', async () => {
    listMock.mockResolvedValue([
      row('cover.png', { at: 2, origin: 'model', contentType: 'image/png' }),
    ]);
    listProjectMock.mockResolvedValue([
      {
        ...row('template.docx', { at: 1, chatId: null, keyKind: 'artifact', keyRef: null }),
        referenceId: 'ref-1',
        mode: 'on_demand',
        addedBy: 'auth0|alice',
      },
    ]);
    const result = await tools.run(
      ATTACH_TO_SANDBOX_TOOL,
      { filename: 'template' },
      context({ projectId: 'p1' })
    );
    expect(result.isError).toBe(false);
    expect(listMock).toHaveBeenCalledWith({ chatId: 'chat-1' });
    expect(listProjectMock).toHaveBeenCalledWith('p1');
    expect(writeMock).toHaveBeenCalledWith(
      { subject: 'auth0|alice' },
      expect.objectContaining({ filename: 'template.docx' }),
      Buffer.from('bytes of blob/template.docx')
    );
    expect(findMock).not.toHaveBeenCalled();
    expect(cipherMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1', projectId: 'p1' }),
      expect.objectContaining({ filename: 'template.docx' })
    );
    expect(putMock).not.toHaveBeenCalled();
  });

  it('stages a file stored before bytes were sealed, sealing it in place on the way', async () => {
    storeMock.mockResolvedValue({
      ok: true,
      val: {
        getObject: jest.fn(async () => ({
          ok: true,
          val: { bytes: Buffer.from('plain bytes'), contentType: 'image/png' },
        })),
        putObject: putMock,
      },
    } as never);
    listMock.mockResolvedValue([row('cover.png', { origin: 'model' })]);
    const result = await tools.run(ATTACH_TO_SANDBOX_TOOL, { filename: 'last' }, context());
    expect(result.isError).toBe(false);
    expect(writeMock).toHaveBeenCalledWith(
      { subject: 'auth0|alice' },
      expect.objectContaining({ filename: 'cover.png' }),
      Buffer.from('plain bytes')
    );
    expect(putMock).toHaveBeenCalledTimes(1);
    const [key, written] = putMock.mock.calls[0] as unknown as [string, Uint8Array];
    expect(key).toBe('blob/cover.png');
    const reopened = testCipher.openBytes(written);
    expect(reopened.ok && reopened.val.toString()).toBe('plain bytes');
  });

  it('refuses a file no key opens for this person, and one sealed under another key', async () => {
    listMock.mockResolvedValue([row('cover.png', { origin: 'model' })]);
    cipherMock.mockResolvedValue(null);
    const noKey = await tools.run(ATTACH_TO_SANDBOX_TOOL, { filename: 'last' }, context());
    expect(noKey.isError).toBe(true);
    expect(noKey.content[0]?.text).toBe('No key opens this file for you.');
    cipherMock.mockResolvedValue(
      resourceCipher({ id: '00000000-0000-4000-8000-00000000beef', key: Buffer.alloc(32, 9) })
    );
    const wrongKey = await tools.run(ATTACH_TO_SANDBOX_TOOL, { filename: 'last' }, context());
    expect(wrongKey.isError).toBe(true);
    expect(wrongKey.content[0]?.text).toContain('could not be read (CONTENT_KEY)');
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('prefers the id when both are given', async () => {
    findMock.mockResolvedValue(null);
    const result = await tools.run(
      ATTACH_TO_SANDBOX_TOOL,
      { attachmentId: 'nope', filename: 'cover.png' },
      context()
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('No such attachment in this chat.');
    expect(listMock).not.toHaveBeenCalled();
  });

  it('refuses a call that names nothing, and a name that is not there, staging nothing', async () => {
    const nothing = await tools.run(ATTACH_TO_SANDBOX_TOOL, {}, context());
    expect(nothing.isError).toBe(true);
    listMock.mockResolvedValue([row('brief.docx')]);
    const missing = await tools.run(ATTACH_TO_SANDBOX_TOOL, { filename: 'deck.pptx' }, context());
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain('brief.docx');
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('passes the sandbox’s refusal and a missing store on as the error', async () => {
    listMock.mockResolvedValue([row('brief.docx')]);
    writeMock.mockResolvedValue({
      ok: false,
      err: { kind: 'op', type: 'quota_full', message: 'full', status: 413 },
    } as never);
    const refused = await tools.run(ATTACH_TO_SANDBOX_TOOL, { filename: 'last' }, context());
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain('refused the file (op)');
    storeMock.mockResolvedValue({ ok: false, err: { type: 'UNCONFIGURED' } } as never);
    const noStore = await tools.run(ATTACH_TO_SANDBOX_TOOL, { filename: 'last' }, context());
    expect(noStore.content[0]?.text).toBe('No file store is configured.');
  });
});

describe(ATTACH_FROM_SANDBOX_TOOL, () => {
  it('is an act tool that needs the staged file’s id', () => {
    const def = tools.defs().find((tool) => tool.name === ATTACH_FROM_SANDBOX_TOOL);
    expect(def?.inputSchema.required).toEqual(['fileId']);
    expect(tools.readOnlyNames()).not.toContain(ATTACH_FROM_SANDBOX_TOOL);
    expect(def?.description).toMatch(/sandbox_run_python/);
    expect(def?.description).toMatch(/Artifacts/);
  });

  it('hands the staged bytes over as an artifact under the staged name and type', async () => {
    readMock.mockResolvedValue({
      ok: true,
      val: { filename: 'report.docx', contentType: STAGED.contentType, bytes: Buffer.from('PK..') },
    });
    const result = await tools.run(ATTACH_FROM_SANDBOX_TOOL, { fileId: STAGED.id }, context());
    expect(result.isError).toBe(false);
    expect(readMock).toHaveBeenCalledWith({ subject: 'auth0|alice' }, STAGED.id);
    expect(result.content[0]?.text).toMatch(
      /^Kept report\.docx \(application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document, 4 bytes\)\. It is under this chat’s Artifacts/
    );
    expect(documentsOf(result.meta)).toEqual([
      {
        mediaType: STAGED.contentType,
        dataBase64: Buffer.from('PK..').toString('base64'),
        title: 'report.docx',
      },
    ]);
    expect(result.meta.renkeiDocumentsShown).toBe(false);
  });

  it('types an untyped file by its extension, and keeps it under the name asked for', async () => {
    readMock.mockResolvedValue({
      ok: true,
      val: {
        filename: 'out.bin',
        contentType: 'application/octet-stream',
        bytes: Buffer.from('%PDF'),
      },
    });
    const result = await tools.run(
      ATTACH_FROM_SANDBOX_TOOL,
      { fileId: STAGED.id, filename: ' summary.pdf ' },
      context()
    );
    expect(result.isError).toBe(false);
    expect(documentsOf(result.meta)[0]).toMatchObject({
      mediaType: 'application/pdf',
      title: 'summary.pdf',
    });
  });

  it('refuses a bad id without asking the sandbox, and says when nothing is staged under one', async () => {
    const bad = await tools.run(ATTACH_FROM_SANDBOX_TOOL, { fileId: 'nope' }, context());
    expect(bad.isError).toBe(true);
    expect(readMock).not.toHaveBeenCalled();
    readMock.mockResolvedValue({
      ok: false,
      err: { kind: 'op', type: 'not_found', message: undefined, status: 404 },
    });
    const gone = await tools.run(ATTACH_FROM_SANDBOX_TOOL, { fileId: STAGED.id }, context());
    expect(gone.isError).toBe(true);
    expect(gone.content[0]?.text).toContain('No such file is staged');
  });

  it('refuses an empty file, a bad name, and one over what a chat keeps — pointing at the share', async () => {
    readMock.mockResolvedValue({
      ok: true,
      val: { filename: 'empty.txt', contentType: 'text/plain', bytes: new Uint8Array(0) },
    });
    const empty = await tools.run(ATTACH_FROM_SANDBOX_TOOL, { fileId: STAGED.id }, context());
    expect(empty.isError).toBe(true);
    expect(empty.content[0]?.text).toContain('empty');

    readMock.mockResolvedValue({
      ok: true,
      val: { filename: 'a.txt', contentType: 'text/plain', bytes: Buffer.from('x') },
    });
    const path = await tools.run(
      ATTACH_FROM_SANDBOX_TOOL,
      { fileId: STAGED.id, filename: '../a.txt' },
      context()
    );
    expect(path.isError).toBe(true);

    readMock.mockResolvedValue({
      ok: true,
      val: {
        filename: 'huge.bin',
        contentType: null,
        bytes: new Uint8Array(1_048_577),
      },
    });
    const huge = await tools.run(ATTACH_FROM_SANDBOX_TOOL, { fileId: STAGED.id }, context());
    expect(huge.isError).toBe(true);
    expect(huge.content[0]?.text).toContain('sandbox_send_to_upload');
    expect(documentsOf(huge.meta)).toEqual([]);
  });
});
