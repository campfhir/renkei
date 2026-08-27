/**
 * The operation layer — one function per thing a caller may do to a share,
 * each resolving the CALLER'S OWN stored credential fresh and then opening
 * a bounded backend session. There is no Renkei-side authorization in this
 * model: the file server judges every operation by the account the person
 * connected with, exactly as a provider judges an OAuth token. What the
 * server refuses surfaces as 'access_denied'; Renkei adds no verdicts of
 * its own beyond path hygiene.
 *
 * This exists as its own seam because the file-share I/O runs in a
 * DEDICATED WORKER PROCESS (apps/worker-fileshares): SMB/SFTP sessions are
 * heavy, slow I/O against servers with no rate limits of their own, and
 * isolating them keeps a wedged NAS from tying up web request handlers.
 * The web app never opens a backend connection — it calls the worker over
 * authenticated HTTP, and the worker calls THESE functions. The worker is
 * also the only process that decrypts a stored credential.
 *
 * Errors are one tag union across resolution and backend failures so the
 * HTTP layer maps them mechanically. 'no_share' covers "missing" and
 * "disabled" alike; 'not_connected' means this person has not stored a
 * credential for the share. Refusal messages are user-facing and phrased
 * here, once, so the MCP tools and REST routes answer identically.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { EntryKind, ShareEntry, ShareSummary } from './types';
import { childPath, normalizePath, parentPath, type PathError } from './paths';
import { decryptCredentials, type ShareCredentials } from './credentials';
import { openBackend, type BackendError, type ShareBackend } from './backend';
import { withSessionLimits } from './limits';
import { getShare, readConnectionCiphertext } from './store';

export type ServiceError =
  | BackendError
  /** Share missing or disabled. */
  | 'no_share'
  /** This person has not connected the share with their own credentials. */
  | 'not_connected'
  /** A stored credential exists but cannot be decrypted or parsed. */
  | 'bad_credentials'
  /** The store could not be read; always fail closed. */
  | 'store'
  /** The supplied path or name is unusable; the message says how. */
  | 'bad_path';

export interface ServiceDeps {
  db: Kysely<DB>;
  /** The parsed TOKEN_ENCRYPTION_KEY, for opening stored credentials. */
  encryptionKey: Buffer;
}

/** The share fields responses echo so callers can name it without a DB read. */
export interface ShareRef {
  id: string;
  name: string;
}

export interface ResolvedConnection {
  share: ShareSummary;
  credentials: ShareCredentials;
}

export interface SubjectTarget {
  tenantId: string;
  shareId: string;
  subject: string;
}

const TRAVERSAL_MESSAGE =
  'That path climbs out of the share (".." is not allowed here). Give the path from the share root, like /reports/q4.';

function badPath(kind: PathError): Result<never, ServiceError> {
  return err('bad_path' as const, {
    message: kind === 'PATH_TRAVERSAL' ? TRAVERSAL_MESSAGE : 'That is not a usable path.',
  });
}

/**
 * Resolve the share and THIS caller's decrypted credential. Every op starts
 * here — nothing is cached across calls, so a disconnect on the connectors
 * page takes effect on the next operation, not the next connection.
 */
export async function resolveConnection(
  deps: ServiceDeps,
  target: SubjectTarget
): Promise<Result<ResolvedConnection, ServiceError>> {
  const share = await getShare(deps.db, target.tenantId, target.shareId);
  if (!share.ok) return err('store' as const, { message: 'Could not read the share.' });
  if (!share.val || !share.val.summary.enabled) return err('no_share' as const);

  const ciphertext = await readConnectionCiphertext(
    deps.db,
    target.tenantId,
    target.shareId,
    target.subject
  );
  if (!ciphertext.ok) return err('store' as const, { message: 'Could not read the share.' });
  if (ciphertext.val === null) return err('not_connected' as const);
  const credentials = decryptCredentials(ciphertext.val, deps.encryptionKey);
  if (!credentials.ok) return err('bad_credentials' as const);
  return ok({ share: share.val.summary, credentials: credentials.val });
}

/** One bounded backend session: open, run, always close. */
async function withShareSession<T>(
  connection: ResolvedConnection,
  work: (backend: ShareBackend) => Promise<Result<T, BackendError>>
): Promise<Result<T, BackendError>> {
  return withSessionLimits(connection.share.id, 'interactive', async () => {
    const opened = await openBackend(connection.share, connection.credentials);
    if (!opened.ok) return opened;
    try {
      return await work(opened.val);
    } finally {
      await opened.val.close();
    }
  });
}

function shareRef(share: ShareSummary): ShareRef {
  return { id: share.id, name: share.name };
}

export interface FolderListing {
  share: ShareRef;
  path: string;
  entries: ShareEntry[];
}

export async function serviceListFolder(
  deps: ServiceDeps,
  target: SubjectTarget,
  rawPath: string
): Promise<Result<FolderListing, ServiceError>> {
  const connection = await resolveConnection(deps, target);
  if (!connection.ok) return connection;
  const path = normalizePath(rawPath);
  if (!path.ok) return badPath(path.err.type);

  const listed = await withShareSession(connection.val, (backend) => backend.list(path.val));
  if (!listed.ok) return listed;
  return ok({
    share: shareRef(connection.val.share),
    path: path.val,
    entries: listed.val.map((entry) => ({ ...entry, path: childPath(path.val, entry.name) })),
  });
}

export interface EntryDetails {
  share: ShareRef;
  path: string;
  kind: EntryKind;
  size: number | null;
  modifiedAt: Date | null;
}

export async function serviceStatEntry(
  deps: ServiceDeps,
  target: SubjectTarget,
  rawPath: string
): Promise<Result<EntryDetails, ServiceError>> {
  const connection = await resolveConnection(deps, target);
  if (!connection.ok) return connection;
  const path = normalizePath(rawPath);
  if (!path.ok) return badPath(path.err.type);

  const stats = await withShareSession(connection.val, (backend) => backend.stat(path.val));
  if (!stats.ok) return stats;
  return ok({
    share: shareRef(connection.val.share),
    path: path.val,
    kind: stats.val.kind,
    size: stats.val.size,
    modifiedAt: stats.val.modifiedAt,
  });
}

export interface FileContent {
  share: ShareRef;
  path: string;
  bytes: Uint8Array;
}

export async function serviceReadFile(
  deps: ServiceDeps,
  target: SubjectTarget,
  rawPath: string,
  maxBytes: number
): Promise<Result<FileContent, ServiceError>> {
  const connection = await resolveConnection(deps, target);
  if (!connection.ok) return connection;
  const path = normalizePath(rawPath);
  if (!path.ok) return badPath(path.err.type);
  if (path.val === '/') return err('bad_path' as const, { message: 'That is not a file.' });

  const content = await withShareSession(connection.val, (backend) =>
    backend.read(path.val, maxBytes)
  );
  if (!content.ok) return content;
  return ok({ share: shareRef(connection.val.share), path: path.val, bytes: content.val });
}

export async function serviceWriteFile(
  deps: ServiceDeps,
  target: SubjectTarget,
  rawPath: string,
  bytes: Uint8Array,
  maxBytes: number
): Promise<Result<{ share: ShareRef; path: string }, ServiceError>> {
  const connection = await resolveConnection(deps, target);
  if (!connection.ok) return connection;
  const path = normalizePath(rawPath);
  if (!path.ok) return badPath(path.err.type);
  if (path.val === '/') return err('bad_path' as const, { message: 'That is not a file.' });
  if (bytes.byteLength > maxBytes) {
    return err('too_large' as const, {
      message: `The file exceeds the ${maxBytes}-byte limit.`,
    });
  }

  const written = await withShareSession(connection.val, (backend) =>
    backend.write(path.val, bytes)
  );
  if (!written.ok) return written;
  return ok({ share: shareRef(connection.val.share), path: path.val });
}

export async function serviceMakeFolder(
  deps: ServiceDeps,
  target: SubjectTarget,
  rawPath: string
): Promise<Result<{ share: ShareRef; path: string }, ServiceError>> {
  const connection = await resolveConnection(deps, target);
  if (!connection.ok) return connection;
  const path = normalizePath(rawPath);
  if (!path.ok) return badPath(path.err.type);
  if (path.val === '/') {
    return err('bad_path' as const, { message: 'The share root already exists.' });
  }

  const made = await withShareSession(connection.val, (backend) => backend.mkdir(path.val));
  if (!made.ok) return made;
  return ok({ share: shareRef(connection.val.share), path: path.val });
}

/**
 * Delete one file or EMPTY folder — a stat for the kind, then the
 * non-recursive remove (a non-empty folder is the backend's 'not_empty',
 * never a tree delete).
 */
export async function serviceRemoveEntry(
  deps: ServiceDeps,
  target: SubjectTarget,
  rawPath: string
): Promise<Result<{ share: ShareRef; path: string }, ServiceError>> {
  const connection = await resolveConnection(deps, target);
  if (!connection.ok) return connection;
  const path = normalizePath(rawPath);
  if (!path.ok) return badPath(path.err.type);
  if (path.val === '/') {
    return err('bad_path' as const, { message: 'The share root cannot be deleted.' });
  }

  const removed = await withShareSession(connection.val, async (backend) => {
    const stats = await backend.stat(path.val);
    if (!stats.ok) return stats;
    return backend.remove(path.val, stats.val.kind);
  });
  if (!removed.ok) return removed;
  return ok({ share: shareRef(connection.val.share), path: path.val });
}

export interface RemovePreview {
  share: ShareRef;
  path: string;
  kind: EntryKind;
  size: number | null;
  modifiedAt: Date | null;
}

/**
 * Everything the delete confirmation card needs, with NO destructive
 * backend call — plus a non-empty-folder refusal here, because the card
 * must never promise a deletion the confirm path would refuse.
 */
export async function servicePreviewRemove(
  deps: ServiceDeps,
  target: SubjectTarget,
  rawPath: string
): Promise<Result<RemovePreview, ServiceError>> {
  const connection = await resolveConnection(deps, target);
  if (!connection.ok) return connection;
  const path = normalizePath(rawPath);
  if (!path.ok) return badPath(path.err.type);
  if (path.val === '/') {
    return err('bad_path' as const, { message: 'The share root cannot be deleted.' });
  }

  const looked = await withShareSession(connection.val, async (backend) => {
    const stats = await backend.stat(path.val);
    if (!stats.ok) return stats;
    if (stats.val.kind === 'dir') {
      const children = await backend.list(path.val);
      if (!children.ok) return children;
      if (children.val.length > 0) return err('not_empty' as const);
    }
    return ok(stats.val);
  });
  if (!looked.ok) return looked;
  return ok({
    share: shareRef(connection.val.share),
    path: path.val,
    kind: looked.val.kind,
    size: looked.val.size,
    modifiedAt: looked.val.modifiedAt,
  });
}

export interface RelocationOutcome {
  share: ShareRef;
  /** The entry's path after the operation. */
  path: string;
  /** True when source and destination were already the same path — no I/O ran. */
  unchanged: boolean;
}

async function relocate(
  connection: ResolvedConnection,
  source: string,
  destination: string
): Promise<Result<RelocationOutcome, ServiceError>> {
  if (destination === source) {
    return ok({ share: shareRef(connection.share), path: destination, unchanged: true });
  }
  const renamed = await withShareSession(connection, (backend) =>
    backend.rename(source, destination)
  );
  if (!renamed.ok) return renamed;
  return ok({ share: shareRef(connection.share), path: destination, unchanged: false });
}

/** Move an entry into another folder on the same share, keeping its name. */
export async function serviceMoveEntry(
  deps: ServiceDeps,
  target: SubjectTarget,
  rawPath: string,
  rawToFolder: string
): Promise<Result<RelocationOutcome, ServiceError>> {
  const connection = await resolveConnection(deps, target);
  if (!connection.ok) return connection;
  const source = normalizePath(rawPath);
  if (!source.ok) return badPath(source.err.type);
  if (source.val === '/') {
    return err('bad_path' as const, { message: 'The share root cannot be moved.' });
  }
  const toFolder = normalizePath(rawToFolder);
  if (!toFolder.ok) return badPath(toFolder.err.type);

  const name = source.val.slice(source.val.lastIndexOf('/') + 1);
  const destination = childPath(toFolder.val, name);
  return relocate(connection.val, source.val, destination);
}

/** Rename an entry in place; the new name must be a plain single name. */
export async function serviceRenameEntry(
  deps: ServiceDeps,
  target: SubjectTarget,
  rawPath: string,
  rawNewName: string
): Promise<Result<RelocationOutcome, ServiceError>> {
  const connection = await resolveConnection(deps, target);
  if (!connection.ok) return connection;
  const source = normalizePath(rawPath);
  if (!source.ok) return badPath(source.err.type);
  if (source.val === '/') {
    return err('bad_path' as const, { message: 'The share root cannot be renamed.' });
  }
  const newName = rawNewName.trim();
  if (!newName || newName.includes('/') || newName.includes('\\') || newName === '..') {
    return err('bad_path' as const, {
      message: 'The new name must be a plain name with no path separators.',
    });
  }

  const destination = childPath(parentPath(source.val), newName);
  return relocate(connection.val, source.val, destination);
}

/**
 * Try a credential against a stored share before it is saved — the connect
 * flow's validation. The credential arrives explicit (unsaved) over the
 * authenticated worker seam and is re-validated at that boundary; success
 * means the account opened a session and listed the share root.
 */
export async function serviceTestConnection(
  deps: ServiceDeps,
  tenantId: string,
  shareId: string,
  credentials: ShareCredentials
): Promise<Result<{ entries: number }, ServiceError>> {
  const share = await getShare(deps.db, tenantId, shareId);
  if (!share.ok) return err('store' as const, { message: 'Could not read the share.' });
  if (!share.val || !share.val.summary.enabled) return err('no_share' as const);
  const summary = share.val.summary;
  if (credentials.protocol !== summary.protocol) {
    return err('bad_credentials' as const);
  }

  const listed = await withSessionLimits(shareId, 'interactive', async () => {
    const backend = await openBackend(summary, credentials);
    if (!backend.ok) return backend;
    try {
      return await backend.val.list('/');
    } finally {
      await backend.val.close();
    }
  });
  if (!listed.ok) return listed;
  return ok({ entries: listed.val.length });
}
