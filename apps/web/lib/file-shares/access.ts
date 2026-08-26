/**
 * Session-side resolution for the file-share REST routes — the same answers
 * fileshare-auth.ts gives the MCP tools, keyed off a browser session
 * instead of a bearer token, so a download from the files page and a read
 * through a model pass the identical gate.
 *
 * The 404 for "no such share" and "share you hold no grant on" is shared
 * deliberately: route status codes are an existence oracle otherwise.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { getDatabase } from '@renkei/db';
import {
  decryptCredentials,
  effectiveAccess,
  getAclContext,
  listRulePathsUnder,
  readCredentialCiphertext,
} from '@renkei/connector-fileshares';
import type { AclContext, ShareCredentials } from '@renkei/connector-fileshares';

export interface ShareAccess {
  ctx: AclContext;
  credentials: ShareCredentials;
}

export interface ShareAccessRefusal {
  status: number;
  error: string;
}

export async function resolveShareAccess(
  tenantId: string,
  shareId: string,
  subject: string
): Promise<ShareAccess | ShareAccessRefusal> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return { status: 500, error: 'Database unavailable' };

  const ctx = await getAclContext(dbResult.val, tenantId, shareId, subject);
  if (!ctx.ok) return { status: 500, error: 'Could not read share access' };
  if (!ctx.val || !ctx.val.share.enabled) return { status: 404, error: 'Not found' };
  if (!ctx.val.share.hasCredentials) {
    return { status: 503, error: 'The share has no stored credentials yet' };
  }

  const key = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!key.ok) return { status: 500, error: 'Encryption key unavailable' };
  const ciphertext = await readCredentialCiphertext(dbResult.val, tenantId, shareId);
  if (!ciphertext.ok || ciphertext.val === null) {
    return { status: 503, error: 'The share has no stored credentials yet' };
  }
  const credentials = decryptCredentials(ciphertext.val, key.val);
  if (!credentials.ok) {
    return { status: 503, error: 'The stored share credentials cannot be read' };
  }
  return { ctx: ctx.val, credentials: credentials.val };
}

export function isRefusal(value: ShareAccess | ShareAccessRefusal): value is ShareAccessRefusal {
  return 'status' in value;
}

/** Map a backend error tag onto the HTTP status a route should answer. */
export function backendStatus(tag: string): number {
  switch (tag) {
    case 'not_found':
      return 404;
    case 'access_denied':
      return 403;
    case 'too_large':
      return 413;
    case 'timeout':
      return 504;
    case 'exists':
    case 'not_empty':
      return 409;
    default:
      return 502;
  }
}

/**
 * The destructive-operation gate, shared by the MCP tools and the REST
 * routes so move, rename and delete answer identically everywhere:
 * read/write on the target, and NO rule — any layer, ANY subject —
 * anchored at or under it. Rules govern paths, not objects; a rename that
 * slid ruled content to an unruled path would be an ACL bypass, so
 * anchored content stays put until an admin removes the rules. Errors
 * fail closed, and the refusal names the anchored paths.
 */
export async function destructiveRefusal(
  tenantId: string,
  ctx: AclContext,
  path: string,
  verb: 'move' | 'rename' | 'delete'
): Promise<string | null> {
  if (effectiveAccess(ctx, path) !== 'read_write') {
    return `You do not have read/write access to ${verb} that path.`;
  }
  const dbResult = getDatabase();
  if (!dbResult.ok) return 'Database unavailable.';
  const anchored = await listRulePathsUnder(
    dbResult.val,
    tenantId,
    ctx.share.id,
    path,
    ctx.share.caseInsensitive
  );
  if (!anchored.ok) return 'Could not verify the path rules here.';
  if (anchored.val.length > 0) {
    return (
      `Access rules are anchored at or under that path (${anchored.val.join(', ')}), so it ` +
      `cannot be ${verb === 'delete' ? 'deleted' : 'moved or renamed'} — an administrator ` +
      'must remove those rules first.'
    );
  }
  return null;
}
