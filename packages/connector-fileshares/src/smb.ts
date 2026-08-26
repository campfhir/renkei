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

  const client = new SMB2({
    share: `\\\\${share.host}\\${share.shareName}`,
    domain: credentials.domain ?? '',
    username: credentials.username,
    password: credentials.password,
    ...(share.port !== null ? { port: share.port } : {}),
    // The client dials lazily and re-dials as needed; keep idle sessions
    // from lingering long past their one tool call.
    autoCloseTimeout: CONNECT_TIMEOUT_MS,
  });

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
        const listed: unknown = await withTimeout(
          'smb readdir',
          OP_TIMEOUT_MS,
          client.readdir(target.val, { stats: true })
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
        const stats: unknown = await withTimeout(
          'smb stat',
          OP_TIMEOUT_MS,
          client.stat(target.val)
        );
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
        const content = await withTimeout(
          'smb readFile',
          TRANSFER_TIMEOUT_MS,
          client.readFile(target.val)
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
        await withTimeout(
          'smb writeFile',
          TRANSFER_TIMEOUT_MS,
          client.writeFile(target.val, Buffer.from(bytes))
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
        await withTimeout('smb mkdir', OP_TIMEOUT_MS, client.mkdir(target.val));
        return ok(undefined);
      } catch (cause) {
        const info = mapError('mkdir', cause);
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
