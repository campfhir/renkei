/* eslint-disable @typescript-eslint/consistent-type-assertions -- a faked store and loosely typed errors for fakes that never reach a provider */
import { ok, err } from '@campfhir/safe-functions/helpers';
import { resolveTenantBlobStore } from '@renkei/blob-store';
import {
  massUploadManifest,
  NEEDS_OCR,
  readAttachmentBytes,
  type AttachmentRow,
} from './attachments';
import { resourceCipher, unavailableCipher } from './content-crypto';

jest.mock('@renkei/blob-store', () => ({
  ...jest.requireActual<typeof import('@renkei/blob-store')>('@renkei/blob-store'),
  resolveTenantBlobStore: jest.fn(),
}));
const storeMock = jest.mocked(resolveTenantBlobStore);

function row(over: Partial<AttachmentRow>): AttachmentRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    ownerSubject: 'u',
    chatId: 'c',
    keyKind: 'chat',
    keyRef: 'c',
    messageId: null,
    blobKey: 'k',
    filename: 'cv.pdf',
    contentType: 'application/pdf',
    sizeBytes: 10,
    extractStatus: 'done',
    origin: 'upload',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

describe('massUploadManifest', () => {
  it('lists every file by id without inlining any text', () => {
    const block = massUploadManifest([
      row({ id: 'a', filename: 'one.pdf' }),
      row({ id: 'b', filename: 'scan.pdf', extractStatus: NEEDS_OCR }),
      row({ id: 'c', filename: 'bad.pdf', extractStatus: 'ocr_failed' }),
    ]);
    expect(block.type).toBe('text');
    const text = block.type === 'text' ? block.text : '';
    expect(text).toContain('count="3"');
    expect(text).toContain('id=a name="one.pdf"');
    expect(text).toContain('id=b name="scan.pdf" type=application/pdf size=10 text=ocr-pending');
    expect(text).toContain('id=c name="bad.pdf" type=application/pdf size=10 text=ocr_failed');
    expect(text).toContain('chat_read_attachment');
  });
});

describe('readAttachmentBytes', () => {
  const cipher = resourceCipher({
    id: '00000000-0000-4000-8000-00000000c0de',
    key: Buffer.alloc(32, 3),
  });
  const other = resourceCipher({
    id: '00000000-0000-4000-8000-00000000beef',
    key: Buffer.alloc(32, 9),
  });
  const file = { blobKey: 'chat/t/a1' };
  const putObject = jest.fn(async () => ok(undefined));
  const holding = (bytes: Uint8Array | null, error: 'NOT_FOUND' | 'PROVIDER_ERROR' = 'NOT_FOUND') =>
    storeMock.mockResolvedValue(
      ok({
        provider: 'local',
        ensureContainer: jest.fn(),
        deleteObject: jest.fn(),
        getObjectStream: jest.fn(),
        getObject: jest.fn(async () =>
          bytes ? ok({ bytes, contentType: null }) : err(error, { message: 'no' })
        ),
        putObject,
      } as never)
    );

  beforeEach(() => jest.clearAllMocks());

  it('opens a sealed file under its key and leaves the store alone', async () => {
    const sealed = cipher.sealBytes(Buffer.from('the file'));
    holding(sealed.ok ? sealed.val : Buffer.alloc(0));
    const read = await readAttachmentBytes(file, cipher);
    expect(read.ok && Buffer.from(read.val).toString()).toBe('the file');
    expect(putObject).not.toHaveBeenCalled();
  });

  it('answers a file sealed under another key, or opened with no key, as CONTENT_KEY', async () => {
    const sealed = cipher.sealBytes(Buffer.from('the file'));
    holding(sealed.ok ? sealed.val : Buffer.alloc(0));
    const wrong = await readAttachmentBytes(file, other);
    expect(!wrong.ok && wrong.err.type).toBe('CONTENT_KEY');
    expect(!wrong.ok && wrong.err.message).toMatch(/another key \(00000000…\)/);
    const none = await readAttachmentBytes(file, unavailableCipher('delegation'));
    expect(!none.ok && none.err.type).toBe('CONTENT_KEY');
    expect(putObject).not.toHaveBeenCalled();
  });

  it('reads a file stored in the clear and seals it in place under the reader’s key', async () => {
    holding(Buffer.from('plain file'));
    const read = await readAttachmentBytes(file, cipher);
    expect(read.ok && Buffer.from(read.val).toString()).toBe('plain file');
    expect(putObject).toHaveBeenCalledTimes(1);
    const [key, written, contentType] = putObject.mock.calls[0] as unknown as [
      string,
      Uint8Array,
      string,
    ];
    expect(key).toBe('chat/t/a1');
    expect(contentType).toBe('application/octet-stream');
    const reopened = cipher.openBytes(written);
    expect(reopened.ok && reopened.val.toString()).toBe('plain file');
  });

  it('leaves a file in the clear for the next reader when this one has no key to seal with', async () => {
    holding(Buffer.from('plain file'));
    const read = await readAttachmentBytes(file, unavailableCipher('no-key'));
    expect(read.ok && Buffer.from(read.val).toString()).toBe('plain file');
    expect(putObject).not.toHaveBeenCalled();
  });

  it('says why when there is no store, no object, or the store fails', async () => {
    storeMock.mockResolvedValue(err('BLOB_UNCONFIGURED' as never, { message: 'off' }));
    const off = await readAttachmentBytes(file, cipher);
    expect(!off.ok && off.err.type).toBe('UNCONFIGURED');
    holding(null);
    const gone = await readAttachmentBytes(file, cipher);
    expect(!gone.ok && gone.err.type).toBe('NOT_FOUND');
    holding(null, 'PROVIDER_ERROR');
    const failed = await readAttachmentBytes(file, cipher);
    expect(!failed.ok && failed.err.type).toBe('STORE');
  });
});
