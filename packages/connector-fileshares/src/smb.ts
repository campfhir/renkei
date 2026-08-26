/**
 * SMB backend over @tryjsky/v9u-smb2 (pure-JS SMB2/3; the fork replaces the
 * upstream NTLM MD4 with js-md4, which OpenSSL 3 removed — plain v9u-smb2
 * cannot authenticate on Node 22+) — chosen over an smbclient CLI
 * wrapper because the runtime images are bare node:24-alpine and a binary
 * dependency would touch every stage of the Dockerfile. If the library
 * proves inadequate against a real server, this file is the whole blast
 * radius of a swap.
 *
 * Path discipline: callers hand in share-relative normalized Unix paths;
 * they are joined under root_path (containment re-verified) and only then
 * translated to the backslash-relative form SMB speaks. The library's
 * errors carry NT status codes as `code`, which map cleanly onto the typed
 * backend error union — STATUS_ACCESS_DENIED is the server saying no, not
 * the call breaking.
 *
 * The library's own .d.ts under-declares its stat objects (size is present
 * at runtime, absent from the types), so fields are read through runtime
 * predicates rather than trusted declarations.
 */

import SMB2 from '@tryjsky/v9u-smb2';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { BackendError, ShareBackend } from './backend';
import type { ShareCredentials } from './credentials';
import { joinUnder } from './paths';
import {
  CONNECT_TIMEOUT_MS,
  OP_TIMEOUT_MS,
  OperationTimeout,
  TRANSFER_TIMEOUT_MS,
  withTimeout,
} from './limits';
import type { RawEntry, ShareSummary } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function fieldNumber(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : null;
}

function fieldDate(value: unknown, key: string): Date | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return field instanceof Date ? field : null;
}

function isDirectoryStat(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const probe = value.isDirectory;
  if (typeof probe !== 'function') return false;
  try {
    return probe.call(value) === true;
  } catch {
    return false;
  }
}

function mapError(operation: string, cause: unknown): { kind: BackendError; message: string } {
  if (cause instanceof OperationTimeout) {
    return { kind: 'timeout', message: cause.message };
  }
  const code = isRecord(cause) && typeof cause.code === 'string' ? cause.code : '';
  const message = cause instanceof Error ? `${operation}: ${cause.message}` : `${operation} failed`;
  switch (code) {
    case 'STATUS_OBJECT_NAME_NOT_FOUND':
    case 'STATUS_OBJECT_PATH_NOT_FOUND':
    case 'STATUS_NO_SUCH_FILE':
      return { kind: 'not_found', message };
    case 'STATUS_ACCESS_DENIED':
    case 'STATUS_LOGON_FAILURE':
    case 'STATUS_USER_SESSION_DELETED':
      return { kind: 'access_denied', message };
    case 'STATUS_OBJECT_NAME_COLLISION':
      return { kind: 'exists', message };
    case 'STATUS_DIRECTORY_NOT_EMPTY':
      return { kind: 'not_empty', message };
    default:
      return code.startsWith('STATUS_')
        ? { kind: 'protocol', message }
        : { kind: 'connection', message };
  }
}

/** '/a/b' (already joined under root) → 'a\\b'; the share root is ''. */
function toSmbRelative(joined: string): string {
  return joined === '/' ? '' : joined.slice(1).replace(/\//g, '\\');
}

/**
 * A loaded server may answer any request with STATUS_PENDING — SMB2's
 * async interim response, meaning "the real answer follows". The library
 * treats it as a terminal error instead of waiting — and worse, when the
 * real response arrives later the connection's dispatch state is left
 * wedged: every subsequent request on that client times out. Both were
 * found by stress-testing concurrent sessions against a real samba. So
 * the retry policy is: on STATUS_PENDING, DISCARD the client, reconnect
 * fresh, and reissue. Every operation here is safe to reissue — reads
 * are pure, mkdir converges, and writes open with FILE_OVERWRITE_IF.
 */
const PENDING_RETRIES = 3;
const PENDING_RETRY_DELAY_MS = 150;

function isPendingStatus(cause: unknown): boolean {
  return isRecord(cause) && cause.code === 'STATUS_PENDING';
}

export function openSmbBackend(
  share: ShareSummary,
  credentials: ShareCredentials
): Result<ShareBackend, BackendError> {
  if (credentials.protocol !== 'smb') {
    return err('protocol' as const, { message: 'Stored credential is not an SMB credential.' });
  }
  if (!share.shareName) {
    return err('protocol' as const, { message: 'SMB share has no share name configured.' });
  }

  const makeClient = () =>
    new SMB2({
      share: `\\\\${share.host}\\${share.shareName}`,
      domain: credentials.domain ?? '',
      username: credentials.username,
      password: credentials.password,
      ...(share.port !== null ? { port: share.port } : {}),
      // The client dials lazily and re-dials as needed; keep idle sessions
      // from lingering long past their one tool call.
      autoCloseTimeout: CONNECT_TIMEOUT_MS,
    });
  let client = makeClient();

  /**
   * Run one operation, replacing the client on a wedge. Two spellings of
   * the same server behavior get a fresh connection and a reissue: a
   * surfaced STATUS_PENDING, and a timeout — the interim response can
   * also be swallowed entirely, leaving the request unresolved and the
   * client's dispatch state poisoned for everything after it. Pending
   * retries a few times (cheap, definitely transient); a timeout retries
   * once, because it may equally mean the server is simply down and each
   * attempt costs the full window.
   */
  async function run<T>(operation: string, ms: number, work: (c: SMB2) => Promise<T>): Promise<T> {
    let lastCause: unknown;
    let timeouts = 0;
    for (let attempt = 0; attempt <= PENDING_RETRIES; attempt += 1) {
      if (attempt > 0) {
        try {
          client.disconnect();
        } catch {
          // The wedged client may not even close cleanly.
        }
        client = makeClient();
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, PENDING_RETRY_DELAY_MS * attempt)
        );
      }
      try {
        return await withTimeout(operation, ms, work(client));
      } catch (cause) {
        if (cause instanceof OperationTimeout) {
          timeouts += 1;
          if (timeouts > 1) throw cause;
        } else if (!isPendingStatus(cause)) {
          throw cause;
        }
        lastCause = cause;
      }
    }
    throw lastCause;
  }

  function resolve(path: string): Result<string, BackendError> {
    const joined = joinUnder(share.rootPath, path);
    if (!joined.ok) {
      return err('access_denied' as const, { message: 'Path escapes the share root.' });
    }
    return ok(toSmbRelative(joined.val));
  }

  const backend: ShareBackend = {
    async list(path) {
      const target = resolve(path);
      if (!target.ok) return target;
      try {
        const listed: unknown = await run('smb readdir', OP_TIMEOUT_MS, (c) =>
          c.readdir(target.val, { stats: true })
        );
        const entries: RawEntry[] = [];
        if (Array.isArray(listed)) {
          for (const item of listed) {
            const name = isRecord(item) && typeof item.name === 'string' ? item.name : null;
            if (!name) continue;
            const dir = isDirectoryStat(item);
            entries.push({
              name,
              kind: dir ? 'dir' : 'file',
              size: dir ? null : fieldNumber(item, 'size'),
              modifiedAt: fieldDate(item, 'mtime'),
            });
          }
        }
        return ok(entries);
      } catch (cause) {
        const info = mapError('readdir', cause);
        return err(info.kind, { message: info.message });
      }
    },

    async stat(path) {
      const target = resolve(path);
      if (!target.ok) return target;
      // The share root itself has no open-able parent entry; it is a
      // directory by definition.
      if (target.val === '') {
        return ok({ name: '', kind: 'dir', size: null, modifiedAt: null });
      }
      try {
        const stats: unknown = await run('smb stat', OP_TIMEOUT_MS, (c) => c.stat(target.val));
        const dir = isDirectoryStat(stats);
        const name = path.slice(path.lastIndexOf('/') + 1);
        return ok({
          name,
          kind: dir ? 'dir' : 'file',
          size: dir ? null : fieldNumber(stats, 'size'),
          modifiedAt: fieldDate(stats, 'mtime'),
        });
      } catch (cause) {
        const info = mapError('stat', cause);
        return err(info.kind, { message: info.message });
      }
    },

    async read(path, maxBytes) {
      const target = resolve(path);
      if (!target.ok) return target;
      const before = await backend.stat(path);
      if (!before.ok) return before;
      if (before.val.kind === 'dir') {
        return err('protocol' as const, { message: 'Cannot read a directory as a file.' });
      }
      if (before.val.size !== null && before.val.size > maxBytes) {
        return err('too_large' as const, {
          message: `File is ${before.val.size} bytes; the limit here is ${maxBytes}.`,
        });
      }
      try {
        const content = await run('smb readFile', TRANSFER_TIMEOUT_MS, (c) =>
          c.readFile(target.val)
        );
        if (content.byteLength > maxBytes) {
          return err('too_large' as const, {
            message: `File is ${content.byteLength} bytes; the limit here is ${maxBytes}.`,
          });
        }
        return ok(new Uint8Array(content));
      } catch (cause) {
        const info = mapError('readFile', cause);
        return err(info.kind, { message: info.message });
      }
    },

    async write(path, bytes) {
      const target = resolve(path);
      if (!target.ok) return target;
      try {
        // 'w' = FILE_OVERWRITE_IF. The library's default is 'wx' (exclusive
        // create), which would refuse to overwrite an existing file — and
        // would also collide with this operation's own first attempt when a
        // STATUS_PENDING retry reissues it. The options type under-declares
        // `flags`, hence the widened variable rather than a literal.
        const overwrite: { encoding?: null; flags: string } = { flags: 'w' };
        await run('smb writeFile', TRANSFER_TIMEOUT_MS, (c) =>
          c.writeFile(target.val, Buffer.from(bytes), overwrite)
        );
        return ok(undefined);
      } catch (cause) {
        const info = mapError('writeFile', cause);
        return err(info.kind, { message: info.message });
      }
    },

    async mkdir(path) {
      const target = resolve(path);
      if (!target.ok) return target;
      try {
        await run('smb mkdir', OP_TIMEOUT_MS, (c) => c.mkdir(target.val));
        return ok(undefined);
      } catch (cause) {
        const info = mapError('mkdir', cause);
        return err(info.kind, { message: info.message });
      }
    },

    async remove(path, kind) {
      const target = resolve(path);
      if (!target.ok) return target;
      if (target.val === '') {
        return err('protocol' as const, { message: 'Refusing to remove the share root.' });
      }
      try {
        await run('smb remove', OP_TIMEOUT_MS, (c) =>
          kind === 'dir' ? c.rmdir(target.val) : c.unlink(target.val)
        );
        return ok(undefined);
      } catch (cause) {
        const info = mapError('remove', cause);
        // Convergent by contract: the desired end state is "absent", and a
        // not_found here usually means a STATUS_PENDING retry reissued a
        // remove whose first attempt had already landed. Callers stat first
        // (they need the kind), so a genuinely-missing target is their
        // answer to give.
        if (info.kind === 'not_found') return ok(undefined);
        return err(info.kind, { message: info.message });
      }
    },

    async rename(fromPath, toPath) {
      const from = resolve(fromPath);
      if (!from.ok) return from;
      const to = resolve(toPath);
      if (!to.ok) return to;
      if (from.val === '' || to.val === '') {
        return err('protocol' as const, { message: 'Refusing to rename the share root.' });
      }

      // Never clobber: probe the destination first so every server answers
      // uniformly, then rename without replace so a race still refuses.
      const collision = await backend.stat(toPath);
      if (collision.ok) {
        return err('exists' as const, { message: `"${toPath}" already exists.` });
      }
      if (collision.err.type !== 'not_found') return collision;

      try {
        await run('smb rename', OP_TIMEOUT_MS, (c) =>
          c.rename(from.val, to.val, { replace: false })
        );
        return ok(undefined);
      } catch (cause) {
        const info = mapError('rename', cause);
        if (info.kind === 'not_found') {
          // A retried rename whose first attempt landed reports not_found on
          // the source; the destination existing now is the disambiguation.
          const healed = await backend.stat(toPath);
          if (healed.ok) return ok(undefined);
        }
        return err(info.kind, { message: info.message });
      }
    },

    async close() {
      try {
        client.disconnect();
      } catch {
        // Closing a session that already died is not an event.
      }
    },
  };

  return ok(backend);
}
