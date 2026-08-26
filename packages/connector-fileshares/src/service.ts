/**
 * The operation layer — one function per thing a caller may do to a share,
 * each enforcing the whole contract itself: resolve the caller's ACL
 * context fresh, evaluate the pure engine over the exact target paths,
 * apply the destructive-operation gate where it applies, and only then
 * open a bounded backend session.
 *
 * This exists as its own seam because the file-share I/O runs in a
 * DEDICATED WORKER PROCESS (apps/worker-fileshares): SMB/SFTP sessions are
 * heavy, slow I/O against servers with no rate limits of their own, and
 * isolating them keeps a wedged NAS from tying up web request handlers.
 * The web app never opens a backend connection — it calls the worker over
 * authenticated HTTP, and the worker calls THESE functions. Keeping the
 * functions here (not in the worker app) keeps them unit-testable and
 * keeps the rule that every surface shares exactly one ACL decision path.
 *
 * Errors are one tag union across ACL refusals and backend failures so the
 * HTTP layer maps them mechanically. 'no_share' deliberately covers
 * "missing", "no grant" and "disabled" alike — a caller without a grant
 * must not learn whether a share exists. Refusal messages are user-facing
 * and phrased here, once, so the MCP tools and REST routes answer
 * identically.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type {
  AccessLevel,
  AclContext,
  EntryKind,
  RawEntry,
  ShareEntry,
  ShareSummary,
} from './types';
import { childPath, normalizePath, parentPath, windowsToUnix, type PathError } from './paths';
import { annotateEntries, canListFolder, effectiveAccess, hasAllowedDescendant } from './acl';
import { decryptCredentials, type ShareCredentials } from './credentials';
import { openBackend, type BackendError, type ShareBackend } from './backend';
import { withSessionLimits } from './limits';
import { getAclContext, getShare, listRulePathsUnder, readCredentialCiphertext } from './store';

export type ServiceError =
  | BackendError
  /** Share missing, disabled, or not granted to this subject — one tag, no existence oracle. */
  | 'no_share'
  /** The share has no stored credential yet. */
  | 'no_credentials'
  /** A stored credential exists but cannot be decrypted or parsed. */
  | 'bad_credentials'
  /** The store could not be read; always fail closed. */
  | 'store'
  /** The supplied path or name is unusable; the message says how. */
  | 'bad_path'
  /** An ACL or destructive-gate refusal; the message is user-facing. */
  | 'forbidden';

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

export interface ResolvedAccess {
  ctx: AclContext;
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
 * Resolve the full context + decrypted credential for one caller/share
 * pair. Every op starts here — nothing is cached across calls beyond the
 * store's own short-TTL ACL cache, so an admin's narrowing takes effect on
 * the next operation, not the next connection.
 */
export async function resolveAccess(
  deps: ServiceDeps,
  target: SubjectTarget
): Promise<Result<ResolvedAccess, ServiceError>> {
  const ctx = await getAclContext(deps.db, target.tenantId, target.shareId, target.subject);
  if (!ctx.ok) return err('store' as const, { message: 'Could not read share access.' });
  if (!ctx.val || !ctx.val.share.enabled) return err('no_share' as const);
  if (!ctx.val.share.hasCredentials) return err('no_credentials' as const);

  const ciphertext = await readCredentialCiphertext(deps.db, target.tenantId, target.shareId);
  if (!ciphertext.ok) return err('store' as const, { message: 'Could not read share access.' });
  if (ciphertext.val === null) return err('no_credentials' as const);
  const credentials = decryptCredentials(ciphertext.val, deps.encryptionKey);
  if (!credentials.ok) return err('bad_credentials' as const);
  return ok({ ctx: ctx.val, credentials: credentials.val });
}

/** One bounded backend session: open, run, always close. */
async function withShareSession<T>(
  access: ResolvedAccess,
  work: (backend: ShareBackend) => Promise<Result<T, BackendError>>
): Promise<Result<T, BackendError>> {
  return withSessionLimits(access.ctx.share.id, 'interactive', async () => {
    const opened = await openBackend(access.ctx.share, access.credentials);
    if (!opened.ok) return opened;
    try {
      return await work(opened.val);
    } finally {
      await opened.val.close();
    }
  });
}

/**
 * The destructive-operation gate: read/write on the target, and NO path
 * rule — either layer, ANY subject — anchored at or under it. Rules govern
 * paths, not objects; a rename that slid ruled content to an unruled path
 * would be an ACL bypass, so anchored content stays put until an admin
 * removes the rules. Errors fail closed, and the refusal names the
 * anchored paths.
 */
async function destructiveRefusal(
  deps: ServiceDeps,
  tenantId: string,
  ctx: AclContext,
  path: string,
  verb: 'move' | 'rename' | 'delete'
): Promise<Result<void, ServiceError>> {
  if (effectiveAccess(ctx, path) !== 'read_write') {
    return err('forbidden' as const, {
      message: `You do not have read/write access to ${verb} that path.`,
    });
  }
  const anchored = await listRulePathsUnder(
    deps.db,
    tenantId,
    ctx.share.id,
    path,
    ctx.share.caseInsensitive
  );
  if (!anchored.ok) {
    return err('store' as const, { message: 'Could not verify the path rules here.' });
  }
  if (anchored.val.length > 0) {
    return err('forbidden' as const, {
      message:
        `Access rules are anchored at or under that path (${anchored.val.join(', ')}), so it ` +
        `cannot be ${verb === 'delete' ? 'deleted' : 'moved or renamed'} — an administrator ` +
        'must remove those rules first.',
    });
  }
  return ok(undefined);
}

function shareRef(ctx: AclContext): ShareRef {
  return { id: ctx.share.id, name: ctx.share.name };
}

export interface FolderListing {
  share: ShareRef;
  path: string;
  /** The listed folder's own level, for surfaces deciding what to offer. */
  access: AccessLevel;
  entries: ShareEntry[];
}

export async function serviceListFolder(
  deps: ServiceDeps,
  target: SubjectTarget,
  rawPath: string
): Promise<Result<FolderListing, ServiceError>> {
  const access = await resolveAccess(deps, target);
  if (!access.ok) return access;
  const path = normalizePath(rawPath);
  if (!path.ok) return badPath(path.err.type);
  if (!canListFolder(access.val.ctx, path.val)) {
    return err('forbidden' as const, { message: 'You do not have access to that folder.' });
  }

  const listed = await withShareSession(access.val, (backend) => backend.list(path.val));
  if (!listed.ok) return listed;
  return ok({
    share: shareRef(access.val.ctx),
    path: path.val,
    access: effectiveAccess(access.val.ctx, path.val),
    entries: annotateEntries(access.val.ctx, path.val, listed.val),
  });
}

export interface EntryDetails {
  share: ShareRef;
  path: string;
  kind: EntryKind;
  size: number | null;
  modifiedAt: Date | null;
  /** 'traverse' = no access to the entry itself, but folders below are granted. */
  access: 'read' | 'read_write' | 'traverse';
}

export async function serviceStatEntry(
  deps: ServiceDeps,
  target: SubjectTarget,
  rawPath: string
): Promise<Result<EntryDetails, ServiceError>> {
  const access = await resolveAccess(deps, target);
  if (!access.ok) return access;
  const path = normalizePath(rawPath);
  if (!path.ok) return badPath(path.err.type);

  const level = effectiveAccess(access.val.ctx, path.val);
  if (level === 'none' && !hasAllowedDescendant(access.val.ctx, path.val)) {
    return err('forbidden' as const, { message: 'You do not have access to that path.' });
  }

  const stats = await withShareSession(access.val, (backend) => backend.stat(path.val));
  if (!stats.ok) return stats;
  return ok({
    share: shareRef(access.val.ctx),
    path: path.val,
    kind: stats.val.kind,
    size: stats.val.size,
    modifiedAt: stats.val.modifiedAt,
    access: level === 'none' ? ('traverse' as const) : level,
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
  const access = await resolveAccess(deps, target);
  if (!access.ok) return access;
  const path = normalizePath(rawPath);
  if (!path.ok) return badPath(path.err.type);
  if (path.val === '/') return err('bad_path' as const, { message: 'That is not a file.' });
  if (effectiveAccess(access.val.ctx, path.val) === 'none') {
    return err('forbidden' as const, { message: 'You do not have access to that file.' });
  }

  const content = await withShareSession(access.val, (backend) =>
    backend.read(path.val, maxBytes)
  );
  if (!content.ok) return content;
  return ok({ share: shareRef(access.val.ctx), path: path.val, bytes: content.val });
}

export async function serviceWriteFile(
  deps: ServiceDeps,
  target: SubjectTarget,
  rawPath: string,
  bytes: Uint8Array,
  maxBytes: number
): Promise<Result<{ share: ShareRef; path: string }, ServiceError>> {
  const access = await resolveAccess(deps, target);
  if (!access.ok) return access;
  const path = normalizePath(rawPath);
  if (!path.ok) return badPath(path.err.type);
  if (path.val === '/') return err('bad_path' as const, { message: 'That is not a file.' });
  if (bytes.byteLength > maxBytes) {
    return err('too_large' as const, {
      message: `The file exceeds the ${maxBytes}-byte limit.`,
    });
  }
  if (effectiveAccess(access.val.ctx, path.val) !== 'read_write') {
    return err('forbidden' as const, {
      message: 'You do not have read/write access at that destination.',
    });
  }

  const written = await withShareSession(access.val, (backend) => backend.write(path.val, bytes));
  if (!written.ok) return written;
  return ok({ share: shareRef(access.val.ctx), path: path.val });
}

export async function serviceMakeFolder(
  deps: ServiceDeps,
  target: SubjectTarget,
  rawPath: string
): Promise<Result<{ share: ShareRef; path: string }, ServiceError>> {
  const access = await resolveAccess(deps, target);
  if (!access.ok) return access;
  const path = normalizePath(rawPath);
  if (!path.ok) return badPath(path.err.type);
  if (path.val === '/') {
    return err('bad_path' as const, { message: 'The share root already exists.' });
  }
  if (effectiveAccess(access.val.ctx, parentPath(path.val)) !== 'read_write') {
    return err('forbidden' as const, {
      message: 'You do not have read/write access in the parent folder.',
    });
  }

  const made = await withShareSession(access.val, (backend) => backend.mkdir(path.val));
  if (!made.ok) return made;
  return ok({ share: shareRef(access.val.ctx), path: path.val });
}

/**
 * Delete one file or EMPTY folder — the gate, a stat for the kind, then
 * the non-recursive remove (a non-empty folder is the backend's
 * 'not_empty', never a tree delete).
 */
export async function serviceRemoveEntry(
  deps: ServiceDeps,
  target: SubjectTarget,
  rawPath: string
): Promise<Result<{ share: ShareRef; path: string }, ServiceError>> {
  const access = await resolveAccess(deps, target);
  if (!access.ok) return access;
  const path = normalizePath(rawPath);
  if (!path.ok) return badPath(path.err.type);
  if (path.val === '/') {
    return err('bad_path' as const, { message: 'The share root cannot be deleted.' });
  }
  const gate = await destructiveRefusal(deps, target.tenantId, access.val.ctx, path.val, 'delete');
  if (!gate.ok) return gate;

  const removed = await withShareSession(access.val, async (backend) => {
    const stats = await backend.stat(path.val);
    if (!stats.ok) return stats;
    return backend.remove(path.val, stats.val.kind);
  });
  if (!removed.ok) return removed;
  return ok({ share: shareRef(access.val.ctx), path: path.val });
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
 * backend call: the same gates the delete itself will re-run, plus a
 * non-empty-folder refusal here — the card must never promise a deletion
 * the confirm path would refuse.
 */
export async function servicePreviewRemove(
  deps: ServiceDeps,
  target: SubjectTarget,
  rawPath: string
): Promise<Result<RemovePreview, ServiceError>> {
  const access = await resolveAccess(deps, target);
  if (!access.ok) return access;
  const path = normalizePath(rawPath);
  if (!path.ok) return badPath(path.err.type);
  if (path.val === '/') {
    return err('bad_path' as const, { message: 'The share root cannot be deleted.' });
  }
  const gate = await destructiveRefusal(deps, target.tenantId, access.val.ctx, path.val, 'delete');
  if (!gate.ok) return gate;

  const looked = await withShareSession(access.val, async (backend) => {
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
    share: shareRef(access.val.ctx),
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
  deps: ServiceDeps,
  target: SubjectTarget,
  access: ResolvedAccess,
  source: string,
  destination: string,
  verb: 'move' | 'rename'
): Promise<Result<RelocationOutcome, ServiceError>> {
  if (destination === source) {
    return ok({ share: shareRef(access.ctx), path: destination, unchanged: true });
  }
  const gate = await destructiveRefusal(deps, target.tenantId, access.ctx, source, verb);
  if (!gate.ok) return gate;
  if (effectiveAccess(access.ctx, destination) !== 'read_write') {
    return err('forbidden' as const, {
      message:
        verb === 'move'
          ? 'You do not have read/write access at the destination.'
          : 'You do not have read/write access at the new name.',
    });
  }

  const renamed = await withShareSession(access, (backend) => backend.rename(source, destination));
  if (!renamed.ok) return renamed;
  return ok({ share: shareRef(access.ctx), path: destination, unchanged: false });
}

/** Move an entry into another folder on the same share, keeping its name. */
export async function serviceMoveEntry(
  deps: ServiceDeps,
  target: SubjectTarget,
  rawPath: string,
  rawToFolder: string
): Promise<Result<RelocationOutcome, ServiceError>> {
  const access = await resolveAccess(deps, target);
  if (!access.ok) return access;
  const source = normalizePath(rawPath);
  if (!source.ok) return badPath(source.err.type);
  if (source.val === '/') {
    return err('bad_path' as const, { message: 'The share root cannot be moved.' });
  }
  const toFolder = normalizePath(rawToFolder);
  if (!toFolder.ok) return badPath(toFolder.err.type);

  const name = source.val.slice(source.val.lastIndexOf('/') + 1);
  const destination = childPath(toFolder.val, name);
  return relocate(deps, target, access.val, source.val, destination, 'move');
}

/** Rename an entry in place; the new name must be a plain single name. */
export async function serviceRenameEntry(
  deps: ServiceDeps,
  target: SubjectTarget,
  rawPath: string,
  rawNewName: string
): Promise<Result<RelocationOutcome, ServiceError>> {
  const access = await resolveAccess(deps, target);
  if (!access.ok) return access;
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
  return relocate(deps, target, access.val, source.val, destination, 'rename');
}

/**
 * The operator surfaces — UNFILTERED by design, and therefore not
 * subject-gated here: the rules editor and the connection test are how an
 * admin sees the ground truth their rules will govern. The web app gates
 * both behind its operator-role check before calling; the worker's service
 * token is what stands between these and everyone else.
 */
export async function serviceAdminList(
  deps: ServiceDeps,
  tenantId: string,
  shareId: string,
  rawPath: string
): Promise<Result<{ path: string; entries: RawEntry[] }, ServiceError>> {
  const share = await getShare(deps.db, tenantId, shareId);
  if (!share.ok) return err('store' as const, { message: 'Could not read the share.' });
  if (!share.val) return err('no_share' as const);
  const summary = share.val.summary;
  if (!summary.hasCredentials) return err('no_credentials' as const);
  const path = normalizePath(rawPath);
  if (!path.ok) return badPath(path.err.type);

  const ciphertext = await readCredentialCiphertext(deps.db, tenantId, shareId);
  if (!ciphertext.ok) return err('store' as const, { message: 'Could not read the share.' });
  if (ciphertext.val === null) return err('no_credentials' as const);
  const credentials = decryptCredentials(ciphertext.val, deps.encryptionKey);
  if (!credentials.ok) return err('bad_credentials' as const);

  const listed = await withSessionLimits(shareId, 'interactive', async () => {
    const backend = await openBackend(summary, credentials.val);
    if (!backend.ok) return backend;
    try {
      return await backend.val.list(path.val);
    } finally {
      await backend.val.close();
    }
  });
  if (!listed.ok) return listed;
  return ok({ path: path.val, entries: listed.val });
}

export interface SearchHit {
  name: string;
  path: string;
  kind: EntryKind;
}

/** Bounds on the search walk — a NAS tree can be arbitrarily deep. */
const SEARCH_MAX_DIRS = 200;
const SEARCH_MAX_RESULTS = 50;
const SEARCH_DEADLINE_MS = 8_000;

/**
 * Find entries anywhere on the share whose path contains the query — the
 * admin permissions navigator's jump-to-path box. Operator surface like
 * serviceAdminList: unfiltered, gated by the web app's role check plus the
 * worker's service token. One backend session serves the whole walk
 * (breadth-first from the root), and the walk is hard-capped in folders
 * visited, results returned and wall time, reporting `truncated` when it
 * stopped early; an unreadable subtree is skipped, not fatal.
 */
export async function serviceAdminSearch(
  deps: ServiceDeps,
  tenantId: string,
  shareId: string,
  rawQuery: string
): Promise<Result<{ results: SearchHit[]; truncated: boolean }, ServiceError>> {
  const share = await getShare(deps.db, tenantId, shareId);
  if (!share.ok) return err('store' as const, { message: 'Could not read the share.' });
  if (!share.val) return err('no_share' as const);
  const summary = share.val.summary;
  if (!summary.hasCredentials) return err('no_credentials' as const);

  // Search is a finding aid, so matching folds case regardless of the
  // share's rule-matching flag; Windows spellings fold to Unix first.
  const query = windowsToUnix(rawQuery).trim().toLowerCase();
  if (!query) return ok({ results: [], truncated: false });

  const ciphertext = await readCredentialCiphertext(deps.db, tenantId, shareId);
  if (!ciphertext.ok) return err('store' as const, { message: 'Could not read the share.' });
  if (ciphertext.val === null) return err('no_credentials' as const);
  const credentials = decryptCredentials(ciphertext.val, deps.encryptionKey);
  if (!credentials.ok) return err('bad_credentials' as const);

  return withSessionLimits(shareId, 'interactive', async () => {
    const opened = await openBackend(summary, credentials.val);
    if (!opened.ok) return opened;
    const backend = opened.val;
    try {
      const results: SearchHit[] = [];
      const queue = ['/'];
      const deadline = Date.now() + SEARCH_DEADLINE_MS;
      let visited = 0;
      while (
        queue.length > 0 &&
        visited < SEARCH_MAX_DIRS &&
        results.length < SEARCH_MAX_RESULTS &&
        Date.now() < deadline
      ) {
        const dir = queue.shift();
        if (dir === undefined) break;
        visited += 1;
        const listed = await backend.list(dir);
        if (!listed.ok) {
          // The root failing is the share failing; a deeper subtree that
          // cannot be listed just does not participate in the search.
          if (dir === '/') return listed;
          continue;
        }
        for (const entry of listed.val) {
          const entryPath = childPath(dir, entry.name);
          if (entryPath.toLowerCase().includes(query) && results.length < SEARCH_MAX_RESULTS) {
            results.push({ name: entry.name, path: entryPath, kind: entry.kind });
          }
          if (entry.kind === 'dir') queue.push(entryPath);
        }
      }
      return ok({ results, truncated: queue.length > 0 });
    } finally {
      await backend.close();
    }
  });
}

export interface ConnectionTest {
  /** Connection details to test — the admin form's unsaved state, or a stored share's summary. */
  summary: ShareSummary;
  /** Explicit credentials to test; null falls back to the stored credential of `storedShareId`. */
  credentials: ShareCredentials | null;
  tenantId: string;
  /** Where to read the stored credential when none is supplied. */
  storedShareId: string | null;
}

export async function serviceTestConnection(
  deps: ServiceDeps,
  test: ConnectionTest
): Promise<Result<{ entries: number }, ServiceError>> {
  let credentials = test.credentials;
  if (!credentials) {
    if (!test.storedShareId) return err('no_credentials' as const);
    const ciphertext = await readCredentialCiphertext(deps.db, test.tenantId, test.storedShareId);
    if (!ciphertext.ok) return err('store' as const, { message: 'Could not read the share.' });
    if (ciphertext.val === null) return err('no_credentials' as const);
    const opened = decryptCredentials(ciphertext.val, deps.encryptionKey);
    if (!opened.ok) return err('bad_credentials' as const);
    credentials = opened.val;
  }

  const listed = await withSessionLimits(test.summary.id, 'interactive', async () => {
    const backend = await openBackend(test.summary, credentials);
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
