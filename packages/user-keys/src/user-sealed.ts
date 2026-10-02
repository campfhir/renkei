/**
 * Values that belong to exactly one person and are never shared — a
 * connector credential, an OAuth token, a personal memory note — sealed
 * directly under that person's KEK as `uenc1:…`. There is no other form:
 * a value without the envelope does not open, and a value under
 * somebody else's key fails its authentication tag. (The rollout sweep,
 * `pnpm rekey-chats --connectors`, is what moved rows written before
 * this; it is the one reader of the old deployment-key form.)
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { isUserSealed, openForUser, sealForUser } from '@renkei/crypto';
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

/** Open a person's value under their KEK; anything but a `uenc1:` envelope is an error. */
export async function openForSubject(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  stored: string
): Promise<Result<string, OpenError>> {
  if (!isUserSealed(stored)) {
    return err('DECRYPTION_ERROR' as const, {
      message: 'value is not sealed under a user key — run the rekey sweep',
    });
  }
  const kek = await getUserKek(db, tenantId, subject);
  if (!kek.ok) return kek;
  const opened = openForUser(stored, kek.val.key);
  return opened.ok ? ok(opened.val) : err('DECRYPTION_ERROR' as const);
}

export { isUserSealed } from '@renkei/crypto';
