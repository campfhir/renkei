/**
 * The share's service credential, sealed at rest with the deployment key.
 *
 * One credential per share — Renkei's own ACL is the per-user authority, so
 * the backend account is infrastructure, not identity. The document is a
 * discriminated union rather than a loose string map so a mis-filed field
 * (an SFTP key on an SMB share) is a parse error at read time instead of a
 * confusing protocol failure at connect time. Parsing fails closed: any
 * malformed stored value means the share is unusable until an admin
 * re-enters the credential, never a guess at what was meant.
 */

import { decrypt, encrypt } from '@renkei/crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

export type ShareCredentials =
  | { protocol: 'smb'; username: string; password: string; domain?: string }
  | { protocol: 'sftp'; username: string; password: string }
  | { protocol: 'sftp'; username: string; privateKey: string; passphrase?: string };

export type CredentialError = 'DECRYPTION_ERROR' | 'MALFORMED_CREDENTIALS';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Validate an untrusted value into a credential document, or null. Exposed
 * for the fileshare worker's test-connection endpoint, which receives an
 * admin's unsaved credentials over the internal HTTP seam and must
 * re-validate them at the trust boundary rather than assume the caller's
 * parsing.
 */
export function parseShareCredentials(value: unknown): ShareCredentials | null {
  if (!isRecord(value)) return null;
  const username = optionalString(value.username);
  if (!username) return null;

  if (value.protocol === 'smb') {
    const password = optionalString(value.password);
    if (!password) return null;
    return { protocol: 'smb', username, password, domain: optionalString(value.domain) };
  }

  if (value.protocol === 'sftp') {
    const privateKey = optionalString(value.privateKey);
    if (privateKey) {
      return {
        protocol: 'sftp',
        username,
        privateKey,
        passphrase: optionalString(value.passphrase),
      };
    }
    const password = optionalString(value.password);
    if (!password) return null;
    return { protocol: 'sftp', username, password };
  }

  return null;
}

export function encryptCredentials(credentials: ShareCredentials, key: Buffer): string {
  return encrypt(JSON.stringify(credentials), key);
}

export function decryptCredentials(
  payload: string,
  key: Buffer
): Result<ShareCredentials, CredentialError> {
  const opened = decrypt(payload, key);
  if (!opened.ok) return err('DECRYPTION_ERROR' as const);

  let parsed: unknown;
  try {
    parsed = JSON.parse(opened.val);
  } catch {
    return err('MALFORMED_CREDENTIALS' as const);
  }

  const credentials = parseShareCredentials(parsed);
  if (!credentials) return err('MALFORMED_CREDENTIALS' as const);
  return ok(credentials);
}
