/**
 * Values that belong to exactly one person and are never shared — a
 * connector credential, an OAuth token — sealed directly under that
 * person's KEK as `uenc1:…`. Readers accept the deployment-key form a row
 * was written in before this (`v1.…`, opened with the legacy key the
 * caller still holds) so the rollout needs no cutover: every write from
 * now on is under the person's key, and a sweep or the next refresh
 * re-seals the rest.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { decrypt, isUserSealed, openForUser, sealForUser } from '@renkei/crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { ensureUserKek, getUserKek, type KekError } from './kek';

export type SealError = Exclude<KekError, 'NO_USER_KEY'>;
export type OpenError = KekError | 'DECRYPTION_ERROR';

/** Seal a person's own value under their KEK (creating their salt on first use). */
export async function sealForSubject(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  plaintext: string
): Promise<Result<string, SealError>> {
  const kek = await ensureUserKek(db, tenantId, subject);
  if (!kek.ok) return kek;
  return ok(sealForUser(plaintext, kek.val.key));
}

/**
 * Open a person's value: `uenc1:` under their KEK; anything else is a
 * pre-rollout deployment-key envelope and opens with `legacyKey` when
 * one is given (without one, such a value is an error, not a passthrough).
 */
export async function openForSubject(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  stored: string,
  legacyKey: Buffer | null
): Promise<Result<string, OpenError>> {
  if (!isUserSealed(stored)) {
    if (!legacyKey) {
      return err('DECRYPTION_ERROR' as const, {
        message: 'value is not sealed under a user key and no legacy key was offered',
      });
    }
    return decrypt(stored, legacyKey);
  }
  const kek = await getUserKek(db, tenantId, subject);
  if (!kek.ok) return kek;
  const opened = openForUser(stored, kek.val.key);
  return opened.ok ? ok(opened.val) : err('DECRYPTION_ERROR' as const);
}

/** Whether a stored value is already under a person's key (for sweeps and refreshes). */
export { isUserSealed } from '@renkei/crypto';
