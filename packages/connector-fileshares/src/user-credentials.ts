/**
 * A person's file share credential sealed under THEIR key — `uenc1:` through
 * @renkei/user-keys (docs/user-encryption-keys-design.md) — rather than
 * the deployment key every connection used to share. Reading accepts
 * both: a row sealed before this opens under the deployment key the
 * worker still holds, and is re-sealed the next time the person
 * reconnects. The credential's shape and its deployment-key form live in
 * credentials.ts; this file only changes whose key is on the outside.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { openForSubject, sealForSubject } from '@renkei/user-keys';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { parseShareCredentials, type ShareCredentials, type CredentialError } from './credentials';

export type SealCredentialsError = 'MISSING_USER_KEY_MASTER' | 'INVALID_ENCRYPTION_KEY';

/** Seal the credential under the connecting person's own key. */
export async function sealCredentialsForSubject(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  credentials: ShareCredentials
): Promise<Result<string, SealCredentialsError>> {
  return sealForSubject(db, tenantId, subject, JSON.stringify(credentials));
}

/**
 * Open the stored credential as its owner: under their key when it was
 * sealed there, under `legacyKey` (the deployment key) when it predates
 * per-user keys. Parsing fails closed, as in credentials.ts.
 */
export async function openCredentialsForSubject(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  stored: string,
  legacyKey: Buffer
): Promise<Result<ShareCredentials, CredentialError>> {
  const opened = await openForSubject(db, tenantId, subject, stored, legacyKey);
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
