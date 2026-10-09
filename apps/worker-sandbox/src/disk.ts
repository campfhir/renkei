/**
 * The scratch disk itself. One directory, one file per staged upload, named
 * by its own id — nothing here is ever served to anything but this process,
 * so there is no folder tree or listing to secure, just containment: every
 * path this module touches is built from a UUID tenantId, a hashed subject,
 * and a UUID fileId, never from anything a caller supplies as free text
 * (that hygiene lives in @renkei/connector-sandbox's `validateFilename`,
 * which guards the DISPLAY name, not the on-disk path).
 *
 * Modes are explicit — directories 0700, files 0600 — rather than left to
 * the umask: with scripts or workspaces on, this process runs commands as
 * other uids on the same filesystem, and nothing staged here may be
 * readable by any of them whatever umask the process was started with.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile as readFileBytes,
  rm,
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { configuredDirectory } from './configured-path';

let dataRoot = configuredDirectory('SANDBOX_DATA_DIR', '/data');

/** Test-only override; production always reads SANDBOX_DATA_DIR once at boot. */
export function setDataRootForTests(dir: string): void {
  dataRoot = dir;
}

/** The staged-file disk's root — shared by every replica that mounts the volume. */
export function getDataRoot(): string {
  return dataRoot;
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

/** Directories under the data root: this process's alone. */
const DIR_MODE = 0o700;
/** Staged files: this process's alone. */
const FILE_MODE = 0o600;

export async function ensureDataRoot(): Promise<void> {
  await mkdir(dataRoot, { recursive: true, mode: DIR_MODE });
  // mkdir's mode goes through the umask and is ignored for a directory
  // that already exists; chmod sets it regardless.
  await chmod(dataRoot, DIR_MODE);
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
  await mkdir(join(path, '..'), { recursive: true, mode: DIR_MODE });
  const handle = await open(path, 'w', FILE_MODE);
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
    return await readFileBytes(path);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return undefined;
    throw error;
  }
}

/**
 * Copy a staged file's bytes to a path outside the data root — into a
 * script run's input directory (scripts.ts), where a caller's uid can
 * read them, since the data root itself is this process's alone. A
 * kernel copy, never buffered here. False when the bytes are not on this
 * instance's disk.
 */
export async function copyFileTo(storageKey: string, destination: string): Promise<boolean> {
  try {
    await copyFile(resolvePath(storageKey), destination);
    await chmod(destination, FILE_MODE);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Whether the bytes for a storage key are on this instance's disk. */
export async function fileExists(storageKey: string): Promise<boolean> {
  try {
    await stat(resolvePath(storageKey));
    return true;
  } catch {
    return false;
  }
}

export async function deleteFile(storageKey: string): Promise<void> {
  await rm(resolvePath(storageKey), { force: true });
}
