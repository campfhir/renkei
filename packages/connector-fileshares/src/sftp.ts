/**
 * SFTP backend over ssh2-sftp-client.
 *
 * The extra care here is symlinks: an SFTP server follows them, so a link
 * inside the share pointing at /etc would quietly widen the root. Every
 * operation therefore resolves its target through the server's realpath
 * and re-checks containment against the resolved root — reads resolve the
 * target itself, writes and mkdirs resolve the PARENT (the target may not
 * exist yet) and re-attach the final name. A path that resolves outside
 * the root is answered 'access_denied', the same as any other closed door.
 *
 * Case sensitivity note: containment is checked case-sensitively here
 * regardless of the share's rule-matching flag — the flag describes how
 * ADMIN RULES match, not how the server's filesystem works, and a
 * case-folding containment check would be the wider (wrong) direction.
 */

import SftpClient from 'ssh2-sftp-client';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { BackendError, ShareBackend } from './backend';
import type { ShareCredentials } from './credentials';
import { isBoundaryPrefix, joinUnder, normalizePath, parentPath } from './paths';
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

function mapError(operation: string, cause: unknown): { kind: BackendError; message: string } {
  if (cause instanceof OperationTimeout) {
    return { kind: 'timeout', message: cause.message };
  }
  const message = cause instanceof Error ? `${operation}: ${cause.message}` : `${operation} failed`;
  const code = isRecord(cause) ? cause.code : undefined;
  // ssh2-sftp-client surfaces SFTP status codes numerically (2 = no such
  // file, 3 = permission denied) and socket-level failures as string codes.
  if (code === 2 || /no such file/i.test(message)) return { kind: 'not_found', message };
  if (code === 3 || /permission denied/i.test(message)) return { kind: 'access_denied', message };
  if (code === 4 && /exist/i.test(message)) return { kind: 'exists', message };
  if (typeof code === 'string') return { kind: 'connection', message };
  return { kind: 'protocol', message };
}

export async function openSftpBackend(
  share: ShareSummary,
  credentials: ShareCredentials
): Promise<Result<ShareBackend, BackendError>> {
  if (credentials.protocol !== 'sftp') {
    return err('protocol' as const, { message: 'Stored credential is not an SFTP credential.' });
  }

  const client = new SftpClient();
  const auth =
    'privateKey' in credentials
      ? { privateKey: credentials.privateKey, passphrase: credentials.passphrase }
      : { password: credentials.password };

  let realRoot: string;
  try {
    await withTimeout(
      'sftp connect',
      CONNECT_TIMEOUT_MS,
      client.connect({
        host: share.host,
        port: share.port ?? 22,
        username: credentials.username,
        readyTimeout: CONNECT_TIMEOUT_MS,
        ...auth,
      })
    );
    // The resolved root anchors every later containment check. A share
    // whose root does not exist is unusable, which is the right failure.
    const resolvedRoot = await withTimeout(
      'sftp realpath(root)',
      OP_TIMEOUT_MS,
      client.realPath(share.rootPath)
    );
    const normalizedRoot = normalizePath(resolvedRoot);
    if (!normalizedRoot.ok) {
      await client.end().catch(() => undefined);
      return err('protocol' as const, { message: 'Share root resolved to an invalid path.' });
    }
    realRoot = normalizedRoot.val;
  } catch (cause) {
    await client.end().catch(() => undefined);
    const info = mapError('connect', cause);
    return err(info.kind, { message: info.message });
  }

  function joined(path: string): Result<string, BackendError> {
    const result = joinUnder(share.rootPath, path);
    if (!result.ok) {
      return err('access_denied' as const, { message: 'Path escapes the share root.' });
    }
    return ok(result.val);
  }

  /** Resolve an EXISTING path through the server and re-check containment. */
  async function resolveExisting(path: string): Promise<Result<string, BackendError>> {
    const target = joined(path);
    if (!target.ok) return target;
    try {
      const resolved = await withTimeout(
        'sftp realpath',
        OP_TIMEOUT_MS,
        client.realPath(target.val)
      );
      const normalized = normalizePath(resolved);
      if (!normalized.ok || !isBoundaryPrefix(realRoot, normalized.val, false)) {
        return err('access_denied' as const, { message: 'Path resolves outside the share root.' });
      }
      return ok(normalized.val);
    } catch (cause) {
      const info = mapError('realpath', cause);
      return err(info.kind, { message: info.message });
    }
  }

  /** Resolve the parent of a possibly-new path, re-attach the final name. */
  async function resolveForCreate(path: string): Promise<Result<string, BackendError>> {
    const target = joined(path);
    if (!target.ok) return target;
    if (target.val === realRoot || target.val === '/') {
      return err('protocol' as const, { message: 'Refusing to write to the share root itself.' });
    }
    const parent = parentPath(target.val);
    const name = target.val.slice(target.val.lastIndexOf('/') + 1);
    try {
      const resolvedParent = await withTimeout(
        'sftp realpath(parent)',
        OP_TIMEOUT_MS,
        client.realPath(parent)
      );
      const normalized = normalizePath(resolvedParent);
      if (!normalized.ok || !isBoundaryPrefix(realRoot, normalized.val, false)) {
        return err('access_denied' as const, { message: 'Path resolves outside the share root.' });
      }
      return ok(normalized.val === '/' ? '/' + name : normalized.val + '/' + name);
    } catch (cause) {
      const info = mapError('realpath', cause);
      return err(info.kind, { message: info.message });
    }
  }

  const backend: ShareBackend = {
    async list(path) {
      const resolved = await resolveExisting(path);
      if (!resolved.ok) return resolved;
      try {
        const listed = await withTimeout('sftp list', OP_TIMEOUT_MS, client.list(resolved.val));
        const entries: RawEntry[] = listed.map((info) => ({
          name: info.name,
          kind: info.type === 'd' ? 'dir' : 'file',
          size: info.type === 'd' ? null : info.size,
          modifiedAt: Number.isFinite(info.modifyTime) ? new Date(info.modifyTime) : null,
        }));
        return ok(entries);
      } catch (cause) {
        const info = mapError('list', cause);
        return err(info.kind, { message: info.message });
      }
    },

    async stat(path) {
      const resolved = await resolveExisting(path);
      if (!resolved.ok) return resolved;
      try {
        const stats = await withTimeout('sftp stat', OP_TIMEOUT_MS, client.stat(resolved.val));
        const name = path === '/' ? '' : path.slice(path.lastIndexOf('/') + 1);
        return ok({
          name,
          kind: stats.isDirectory ? 'dir' : 'file',
          size: stats.isDirectory ? null : stats.size,
          modifiedAt: Number.isFinite(stats.modifyTime) ? new Date(stats.modifyTime) : null,
        });
      } catch (cause) {
        const info = mapError('stat', cause);
        return err(info.kind, { message: info.message });
      }
    },

    async read(path, maxBytes) {
      const resolved = await resolveExisting(path);
      if (!resolved.ok) return resolved;
      try {
        const stats = await withTimeout('sftp stat', OP_TIMEOUT_MS, client.stat(resolved.val));
        if (stats.isDirectory) {
          return err('protocol' as const, { message: 'Cannot read a directory as a file.' });
        }
        if (stats.size > maxBytes) {
          return err('too_large' as const, {
            message: `File is ${stats.size} bytes; the limit here is ${maxBytes}.`,
          });
        }
        const content = await withTimeout(
          'sftp get',
          TRANSFER_TIMEOUT_MS,
          client.get(resolved.val)
        );
        if (!Buffer.isBuffer(content)) {
          return err('protocol' as const, { message: 'Unexpected non-buffer download result.' });
        }
        return ok(new Uint8Array(content));
      } catch (cause) {
        const info = mapError('get', cause);
        return err(info.kind, { message: info.message });
      }
    },

    async write(path, bytes) {
      const resolved = await resolveForCreate(path);
      if (!resolved.ok) return resolved;
      try {
        await withTimeout(
          'sftp put',
          TRANSFER_TIMEOUT_MS,
          client.put(Buffer.from(bytes), resolved.val)
        );
        return ok(undefined);
      } catch (cause) {
        const info = mapError('put', cause);
        return err(info.kind, { message: info.message });
      }
    },

    async mkdir(path) {
      const resolved = await resolveForCreate(path);
      if (!resolved.ok) return resolved;
      try {
        await withTimeout('sftp mkdir', OP_TIMEOUT_MS, client.mkdir(resolved.val, false));
        return ok(undefined);
      } catch (cause) {
        const info = mapError('mkdir', cause);
        return err(info.kind, { message: info.message });
      }
    },

    async close() {
      try {
        await client.end();
      } catch {
        // Closing a session that already died is not an event.
      }
    },
  };

  return ok(backend);
}
