/* eslint-disable @typescript-eslint/consistent-type-assertions -- a null db and loosely typed store errors for fakes that never touch them */
/**
 * Which earlier picture a follow-up builds on: "last" is the newest one a
 * tool drew, a name finds that file (exactly, then in part, newest first),
 * only PNG and JPEG count, and a name that is not there is answered with the
 * names that are so the model can try again.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import { listAttachments, type AttachmentRow } from './attachments';
import { loadSourceImage, pickSourceImage, type ImageFile } from './image-source';

jest.mock('./attachments', () => ({ listAttachments: jest.fn() }));
jest.mock('@renkei/blob-store', () => ({ resolveTenantBlobStore: jest.fn() }));

const { resolveTenantBlobStore } = jest.requireMock<{ resolveTenantBlobStore: jest.Mock }>(
  '@renkei/blob-store'
);
const listAttachmentsMock = jest.mocked(listAttachments);

const file = (filename: string, origin = 'model', contentType = 'image/png'): ImageFile => ({
  filename,
  contentType,
  origin,
});

// Oldest first, as listAttachments returns them.
const chat = [
  file('upload.jpg', 'upload', 'image/jpeg'),
  file('notes.csv', 'model', 'text/csv'),
  file('polar_bear.png'),
  file('fox.png'),
  file('photo.png', 'upload'),
];

describe('pickSourceImage', () => {
  it('takes "last", or nothing, to be the newest picture a tool drew — not the newest upload', () => {
    for (const wanted of ['last', 'LAST', '', '  ', 'previous', 'latest']) {
      const picked = pickSourceImage(chat, wanted);
      expect(picked.ok && picked.file.filename).toBe('fox.png');
    }
  });

  it('falls back to the newest image of any kind when none was drawn', () => {
    const uploads = [file('a.jpg', 'upload', 'image/jpeg'), file('b.png', 'upload')];
    const picked = pickSourceImage(uploads, 'last');
    expect(picked.ok && picked.file.filename).toBe('b.png');
  });

  it('finds a file by name, ignoring case, and also among the person’s uploads', () => {
    const exact = pickSourceImage(chat, 'POLAR_BEAR.PNG');
    expect(exact.ok && exact.file.filename).toBe('polar_bear.png');
    const upload = pickSourceImage(chat, 'photo.png');
    expect(upload.ok && upload.file.origin).toBe('upload');
  });

  it('accepts part of a name, newest first', () => {
    const pngs = [file('bear_v1.png'), file('bear_v2.png')];
    const picked = pickSourceImage(pngs, 'bear');
    expect(picked.ok && picked.file.filename).toBe('bear_v2.png');
  });

  it('prefers an exact name to a partial one', () => {
    const picked = pickSourceImage([file('bear.png'), file('bear.png.bak.png')], 'bear.png');
    expect(picked.ok && picked.file.filename).toBe('bear.png');
  });

  it('never offers a file that is not a PNG or JPEG', () => {
    const picked = pickSourceImage(chat, 'notes.csv');
    expect(picked.ok).toBe(false);
    const gif = pickSourceImage([file('a.gif', 'upload', 'image/gif')], 'last');
    expect(gif.ok).toBe(false);
  });

  it('answers a missing name with the names that are there, newest first', () => {
    const picked = pickSourceImage(chat, 'unicorn.png');
    expect(picked.ok).toBe(false);
    if (!picked.ok) {
      expect(picked.reason).toContain('No image called "unicorn.png"');
      expect(picked.reason).toContain('photo.png, fox.png, polar_bear.png, upload.jpg');
      expect(picked.reason).not.toContain('notes.csv');
    }
  });

  it('says there is nothing to build on when the chat has no image', () => {
    const picked = pickSourceImage([file('notes.csv', 'model', 'text/csv')], 'last');
    expect(!picked.ok && picked.reason).toMatch(/no earlier PNG or JPEG image/);
    expect(pickSourceImage([], 'last').ok).toBe(false);
  });

  it('lists at most ten names', () => {
    const many = Array.from({ length: 15 }, (_, i) => file(`img${i}.png`));
    const picked = pickSourceImage(many, 'zzz');
    expect(!picked.ok && picked.reason.match(/img\d+\.png/g)).toHaveLength(10);
    // The newest ten, not the oldest.
    expect(!picked.ok && picked.reason).toContain('img14.png');
    expect(!picked.ok && picked.reason).not.toContain('img4.png');
  });
});

describe('loadSourceImage', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAA1BMVEX/AAAZ4gk3AAAADElEQVQI12NgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC',
    'base64'
  ); // a real 2x2 PNG
  const SCOPE = { db: null as never, chatId: 'c' };
  const row = (over: Partial<AttachmentRow>): AttachmentRow => ({
    id: 'a1',
    ownerSubject: 'u',
    chatId: 'c',
    projectId: null,
    messageId: 'm1',
    blobKey: 'chat/t/a1',
    filename: 'bear.png',
    contentType: 'image/png',
    sizeBytes: PNG.length,
    extractStatus: 'none',
    origin: 'model',
    createdAt: new Date(0),
    ...over,
  });
  const store = (bytes: Uint8Array | null) =>
    resolveTenantBlobStore.mockResolvedValue(
      ok({
        getObject: jest.fn(async () =>
          bytes
            ? ok({ bytes, contentType: 'image/png' })
            : err('NOT_FOUND' as never, { message: 'gone' })
        ),
      })
    );

  beforeEach(() => jest.clearAllMocks());

  it('reads the picture back from this chat’s store, rebuilt from its pixels', async () => {
    listAttachmentsMock.mockResolvedValue([row({})]);
    // An upload with something riding behind the pixels.
    store(Buffer.concat([PNG, Buffer.from('<script>alert(1)</script>')]));
    const loaded = await loadSourceImage(SCOPE, 'last');
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.image).toMatchObject({ mediaType: 'image/png', filename: 'bear.png' });
      expect(loaded.image.bytes.subarray(1, 4).toString()).toBe('PNG');
      expect(loaded.image.bytes.includes(Buffer.from('script'))).toBe(false);
    }
    expect(listAttachmentsMock).toHaveBeenCalledWith(null, { chatId: 'c' });
  });

  it('says what is there when the name is not', async () => {
    listAttachmentsMock.mockResolvedValue([row({})]);
    store(PNG);
    const loaded = await loadSourceImage(SCOPE, 'unicorn.png');
    expect(!loaded.ok && loaded.reason).toMatch(/No image called "unicorn\.png".*bear\.png/);
    expect(resolveTenantBlobStore).not.toHaveBeenCalled();
  });

  it('refuses a file that is not really the image it says, naming it', async () => {
    listAttachmentsMock.mockResolvedValue([row({})]);
    store(Buffer.from('<html><script>alert(1)</script></html>'));
    const loaded = await loadSourceImage(SCOPE, 'bear.png');
    expect(!loaded.ok && loaded.reason).toMatch(/bear\.png is not a valid PNG image/);
  });

  it('says so when the file store is off, the object is gone, or the list fails', async () => {
    listAttachmentsMock.mockResolvedValue([row({})]);
    resolveTenantBlobStore.mockResolvedValue(err('UNCONFIGURED' as never, { message: 'off' }));
    const off = await loadSourceImage(SCOPE, 'last');
    expect(!off.ok && off.reason).toMatch(/file store is not available/);

    store(null);
    const gone = await loadSourceImage(SCOPE, 'last');
    expect(!gone.ok && gone.reason).toMatch(/bear\.png could not be read back/);

    listAttachmentsMock.mockRejectedValue(new Error('db down'));
    const down = await loadSourceImage(SCOPE, 'last');
    expect(!down.ok && down.reason).toMatch(/files could not be read/);
  });
});
