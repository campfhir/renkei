/**
 * Body parsers for the file-share routes — validation lives here, not in
 * the UI, so the API is safe whatever client speaks to it. Paths are
 * translated from Windows spellings and normalized server-side for the
 * same reason: the UI's live preview is a convenience, never the check.
 */

import { isToolAccess, normalizePath, windowsToUnix } from '@renkei/connector-fileshares';
import type { ShareCredentials, ShareInput, ToolAccess } from '@renkei/connector-fileshares';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isShareProtocolValue(value: unknown): value is 'smb' | 'sftp' {
  return value === 'smb' || value === 'sftp';
}

/** The admin share form: connection details only — never a credential. */
export function parseSharePayload(body: unknown): { input: ShareInput } | { error: string } {
  if (!isRecord(body)) return { error: 'A JSON object is required' };

  const name = cleanString(body.name);
  if (!name || name.length > 120) return { error: 'name is required (max 120 chars)' };

  const protocol = body.protocol;
  if (!isShareProtocolValue(protocol)) return { error: "protocol must be 'smb' or 'sftp'" };

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

  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

  return {
    input: {
      name,
      protocol,
      host,
      port,
      shareName,
      rootPath: rootPath.val,
      caseInsensitive,
      enabled,
    },
  };
}

export interface ParsedExposure {
  toolAccess: ToolAccess;
  allowDelete: boolean;
}

/**
 * The LLM-exposure half of a connect or update body. Delete without write
 * would be a lie on the card — the delete tools require read/write — so it
 * is normalized away rather than stored.
 */
export function parseExposurePayload(body: unknown): ParsedExposure | { error: string } {
  if (!isRecord(body)) return { error: 'A JSON object is required' };
  const toolAccess = body.toolAccess;
  if (!isToolAccess(toolAccess)) {
    return { error: "toolAccess must be 'read' or 'read_write'" };
  }
  const allowDelete = body.allowDelete === true && toolAccess === 'read_write';
  return { toolAccess, allowDelete };
}

export interface ParsedConnect extends ParsedExposure {
  credentials: ShareCredentials;
}

/**
 * The connect form: the person's own credential for one share, plus their
 * exposure choice. A partial credential is an error, never a guess.
 */
export function parseConnectPayload(
  protocol: 'smb' | 'sftp',
  body: unknown
): ParsedConnect | { error: string } {
  if (!isRecord(body)) return { error: 'A JSON object is required' };

  const exposure = parseExposurePayload(body);
  if ('error' in exposure) return exposure;

  const username = cleanString(body.username);
  const password = cleanString(body.password);
  const domain = cleanString(body.domain);
  const privateKey = typeof body.privateKey === 'string' ? body.privateKey.trim() : '';
  const passphrase = cleanString(body.passphrase);

  if (!username) return { error: 'A credential needs a username' };

  if (protocol === 'smb') {
    if (!password) return { error: 'An SMB credential needs a password' };
    return {
      ...exposure,
      credentials: { protocol: 'smb', username, password, ...(domain ? { domain } : {}) },
    };
  }
  if (privateKey) {
    return {
      ...exposure,
      credentials: {
        protocol: 'sftp',
        username,
        privateKey,
        ...(passphrase ? { passphrase } : {}),
      },
    };
  }
  if (!password) return { error: 'An SFTP credential needs a password or a private key' };
  return { ...exposure, credentials: { protocol: 'sftp', username, password } };
}
