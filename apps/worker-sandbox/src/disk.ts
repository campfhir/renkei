/**
 * The scratch disk itself. One directory, one file per staged upload, named
 * by its own id — nothing here is ever served to anything but this process,
 * so there is no folder tree or listing to secure, just containment: every
 * path this module touches is built from a UUID tenantId, a hashed subject,
 * and a UUID fileId, never from anything a caller supplies as free text
 * (that hygiene lives in @renkei/connector-sandbox's `validateFilename`,
 * which guards the DISPLAY name, not the on-disk path).
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile as readFileBytes, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

let dataRoot = process.env.SANDBOX_DATA_DIR || '/data';

/** Test-only override; production always reads SANDBOX_DATA_DIR once at boot. */
export function setDataRootForTests(dir: string): void {
  dataRoot = dir;
}

function subjectSegment(subject: string): string {
  return createHash('sha256').update(subject).digest('hex');
}

/** A fresh storage key for a new file — the caller persists this on the DB row. */
export function newStorageKey(tenantId: string, subject: string): string {
  return join(tenantId, subjectSegment(subject), randomUUID());
}

function resolvePath(storageKey: string): string {
  return join(dataRoot, storageKey);
}

export async function ensureDataRoot(): Promise<void> {
  await mkdir(dataRoot, { recursive: true });
}

/**
 * Write a byte stream to a new storage key, aborting once `maxBytes` is
 * exceeded — the same cap-while-reading discipline serviceWriteFile and the
 * fileshare worker's readBody already apply, so an oversized source can
 * never be buffered in full before it's rejected.
 */
export async function writeStream(
  storageKey: string,
  source: AsyncIterable<Uint8Array>,
  maxBytes: number
): Promise<{ ok: true; sizeBytes: number } | { ok: false; error: 'too_large' }> {
  const path = resolvePath(storageKey);
  await mkdir(join(path, '..'), { recursive: true });
  const handle = await open(path, 'w');
  let total = 0;
  try {
    for await (const chunk of source) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        await handle.close();
        await rm(path, { force: true });
        return { ok: false, error: 'too_large' };
      }
      await handle.write(chunk);
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return { ok: true, sizeBytes: total };
}

export async function readFile(storageKey: string): Promise<Buffer | undefined> {
  const path = resolvePath(storageKey);
  try {
    await stat(path);
  } catch {
    return undefined;
  }
  return readFileBytes(path);
}

export async function deleteFile(storageKey: string): Promise<void> {
  await rm(resolvePath(storageKey), { force: true });
}
