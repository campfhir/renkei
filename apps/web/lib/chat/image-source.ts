/**
 * The picture an image call starts from, when the person's message builds
 * on one — "make it bluer", "same bear, but in winter". The chat model,
 * which can see the conversation, says so with `sourceImage` (a file's name
 * in this chat, or "last"); this finds that file among the chat's own
 * images, reads it back, and rebuilds it through the same validators as
 * anything else that comes from outside (so a user's upload loses its
 * metadata too) before it goes to the image model.
 *
 * Only PNG and JPEG, which every image model's edit takes. Only this chat's
 * files: nothing from another chat or a project is reachable by name.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { resolveTenantBlobStore } from '@renkei/blob-store';
import { sanitizeBytes } from '@renkei/document-render';
import { listAttachments, type AttachmentRow } from './attachments';

/** What the picker needs of a stored file. */
export interface ImageFile {
  filename: string;
  contentType: string;
  /** 'model' for a picture a tool drew; anything else is the person's own upload. */
  origin: string;
}

const EDITABLE = new Set(['image/png', 'image/jpeg']);
/** How many names an "it is not there" message lists. */
const NAMES_LISTED = 10;
const LAST = new Set(['', 'last', 'previous', 'latest']);

export type SourcePick<T extends ImageFile> = { ok: true; file: T } | { ok: false; reason: string };

/**
 * Which of the chat's files `wanted` names. `files` is oldest first, as
 * listAttachments returns them. "last" (or nothing) is the newest picture a
 * tool drew, else the newest image of any kind; a name is matched exactly
 * (ignoring case), then as a part of a name, newest first.
 */
export function pickSourceImage<T extends ImageFile>(
  files: readonly T[],
  wanted: string
): SourcePick<T> {
  const images = files.filter((file) => EDITABLE.has(file.contentType)).reverse();
  if (images.length === 0) {
    return {
      ok: false,
      reason:
        'There is no earlier PNG or JPEG image in this chat to build on. Leave sourceImage out to draw a new one.',
    };
  }
  const name = wanted.trim().toLowerCase();
  if (LAST.has(name)) {
    return { ok: true, file: images.find((file) => file.origin === 'model') ?? images[0]! };
  }
  const exact = images.find((file) => file.filename.toLowerCase() === name);
  if (exact) return { ok: true, file: exact };
  const partial = images.find((file) => file.filename.toLowerCase().includes(name));
  if (partial) return { ok: true, file: partial };
  const names = images
    .slice(0, NAMES_LISTED)
    .map((file) => file.filename)
    .join(', ');
  return {
    ok: false,
    reason: `No image called "${wanted}" in this chat. Its images, newest first: ${names}. Use one of those names, or "last".`,
  };
}

export interface SourceImage {
  bytes: Buffer;
  mediaType: 'image/png' | 'image/jpeg';
  filename: string;
}

export type SourceLoad = { ok: true; image: SourceImage } | { ok: false; reason: string };

export interface SourceScope {
  db: Kysely<DB>;
  tenantId: string;
  chatId: string;
}

/** Reads the named picture back from the store and rebuilds it; or says why it cannot. */
export async function loadSourceImage(scope: SourceScope, wanted: string): Promise<SourceLoad> {
  let rows: AttachmentRow[];
  try {
    rows = await listAttachments(scope.db, scope.tenantId, { chatId: scope.chatId });
  } catch {
    return { ok: false, reason: 'This chat’s files could not be read just now.' };
  }
  const picked = pickSourceImage(rows, wanted);
  if (!picked.ok) return picked;
  const store = await resolveTenantBlobStore(scope.tenantId);
  if (!store.ok) return { ok: false, reason: 'The file store is not available.' };
  const object = await store.val.getObject(picked.file.blobKey);
  if (!object.ok) {
    return { ok: false, reason: `${picked.file.filename} could not be read back from storage.` };
  }
  const extension = picked.file.contentType === 'image/jpeg' ? 'jpg' : 'png';
  // Rebuilt, not trusted: an upload may carry metadata or worse.
  const checked = sanitizeBytes(extension, Buffer.from(object.val.bytes));
  if (!checked.ok) {
    return {
      ok: false,
      reason: `${picked.file.filename} is not a valid ${extension.toUpperCase()} image, so it cannot be built on: ${checked.reason}`,
    };
  }
  return {
    ok: true,
    image: {
      bytes: checked.bytes,
      mediaType: picked.file.contentType === 'image/jpeg' ? 'image/jpeg' : 'image/png',
      filename: picked.file.filename,
    },
  };
}
