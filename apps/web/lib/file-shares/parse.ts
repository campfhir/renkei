/**
 * Body parsers for the file-share admin routes — validation lives here, not
 * in the UI, so the API is safe whatever client speaks to it. Paths are
 * translated from Windows spellings and normalized server-side for the
 * same reason: the UI's live preview is a convenience, never the check.
 */

import {
  isAccessLevel,
  isShareProtocol,
  normalizePath,
  windowsToUnix,
} from '@renkei/connector-fileshares';
import type { AccessLevel, ShareCredentials, ShareInput } from '@renkei/connector-fileshares';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export interface ParsedShare {
  input: ShareInput;
  /** undefined = body carried no credential fields (keep what is stored). */
  credentials: ShareCredentials | undefined;
}

export function parseSharePayload(body: unknown): ParsedShare | { error: string } {
  if (!isRecord(body)) return { error: 'A JSON object is required' };

  const name = cleanString(body.name);
  if (!name || name.length > 120) return { error: 'name is required (max 120 chars)' };

  const protocol = body.protocol;
  if (!isShareProtocol(protocol)) return { error: "protocol must be 'smb' or 'sftp'" };

  const host = cleanString(body.host);
  if (!host || host.length > 255) return { error: 'host is required (max 255 chars)' };

  let port: number | null = null;
  if (body.port !== undefined && body.port !== null && body.port !== '') {
    const parsed = Number(body.port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return { error: 'port must be 1-65535, or empty for the protocol default' };
    }
    port = parsed;
  }

  const shareName = cleanString(body.shareName) || null;
  if (protocol === 'smb' && !shareName) {
    return { error: 'shareName is required for SMB (the share component of \\\\host\\share)' };
  }

  const rootPath = normalizePath(windowsToUnix(cleanString(body.rootPath) || '/'));
  if (!rootPath.ok) return { error: 'rootPath cannot climb (".." is not allowed)' };

  const caseInsensitive =
    typeof body.caseInsensitive === 'boolean'
      ? body.caseInsensitive
      : // The protocol default is set here, explicitly, so the stored value
        // is always a decision (the column has no DDL default on purpose).
        protocol === 'smb';

  const maxAccess = body.maxAccess;
  if (maxAccess !== 'read' && maxAccess !== 'read_write') {
    return { error: "maxAccess must be 'read' or 'read_write'" };
  }

  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

  const credentials = parseCredentialFields(protocol, body);
  if (credentials && 'error' in credentials) return credentials;

  return {
    input: {
      name,
      protocol,
      host,
      port,
      shareName,
      rootPath: rootPath.val,
      caseInsensitive,
      maxAccess,
      enabled,
    },
    credentials: credentials ?? undefined,
  };
}

/**
 * Credential fields are OPTIONAL on update (absent = keep stored) but a
 * partial credential is an error, never a guess.
 */
function parseCredentialFields(
  protocol: 'smb' | 'sftp',
  body: Record<string, unknown>
): ShareCredentials | { error: string } | null {
  const username = cleanString(body.username);
  const password = cleanString(body.password);
  const domain = cleanString(body.domain);
  const privateKey = typeof body.privateKey === 'string' ? body.privateKey.trim() : '';
  const passphrase = cleanString(body.passphrase);

  if (!username && !password && !privateKey) return null;
  if (!username) return { error: 'A credential needs a username' };

  if (protocol === 'smb') {
    if (!password) return { error: 'An SMB credential needs a password' };
    return { protocol: 'smb', username, password, ...(domain ? { domain } : {}) };
  }
  if (privateKey) {
    return { protocol: 'sftp', username, privateKey, ...(passphrase ? { passphrase } : {}) };
  }
  if (!password) return { error: 'An SFTP credential needs a password or a private key' };
  return { protocol: 'sftp', username, password };
}

export interface ParsedGrant {
  subject: string;
  defaultAccess: AccessLevel;
}

export function parseGrantPayload(body: unknown): ParsedGrant | { error: string } {
  if (!isRecord(body)) return { error: 'A JSON object is required' };
  const subject = cleanString(body.subject);
  if (!subject || subject.length > 255) return { error: 'subject is required (max 255 chars)' };
  const defaultAccess = body.defaultAccess;
  if (!isAccessLevel(defaultAccess)) {
    return { error: "defaultAccess must be 'none', 'read' or 'read_write'" };
  }
  return { subject, defaultAccess };
}

export interface ParsedRule {
  /** null = the share-wide layer. */
  subject: string | null;
  path: string;
  access: AccessLevel;
}

export function parseRulePayload(body: unknown): ParsedRule | { error: string } {
  if (!isRecord(body)) return { error: 'A JSON object is required' };
  const subject = cleanString(body.subject) || null;
  const path = normalizePath(windowsToUnix(cleanString(body.path)));
  if (!path.ok) return { error: 'path cannot climb (".." is not allowed)' };
  const access = body.access;
  if (!isAccessLevel(access)) return { error: "access must be 'none', 'read' or 'read_write'" };
  return { subject, path: path.val, access };
}
