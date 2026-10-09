/**
 * A person's file share credential sealed under THEIR key — `uenc1:` through
 * @renkei/user-keys (docs/user-encryption-keys-design.md) — and under
 * nothing else: a credential belongs to the one person who connected,
 * is never shared, and is never under a deployment-wide key. The
 * credential's shape lives in credentials.ts; this file is whose key is
 * on the outside.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { openForSubject, sealForSubject, type SealError } from '@renkei/user-keys';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { parseShareCredentials, type ShareCredentials, type CredentialError } from './credentials';

export type SealCredentialsError = SealError;

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
 * Open the stored credential as its owner. Fails closed on anything but a
 * `uenc1:` envelope under their key — including an owner whose own key is
 * locked, which to a caller is simply "not usable right now".
 */
export async function openCredentialsForSubject(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  stored: string
): Promise<Result<ShareCredentials, CredentialError>> {
  const opened = await openForSubject(db, tenantId, subject, stored);
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
