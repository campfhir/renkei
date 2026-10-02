/**
 * Values that belong to exactly one person and are never shared, sealed
 * directly under one of their keys:
 *
 *   uenc1:   under the AUTOMATION key — a connector credential, an OAuth
 *            token: what the person's agents and the delegate's token
 *            refresh need while they are away. Opens under either scope.
 *   upriv1:  under the USER key — the person's own memory: what nothing
 *            unattended should read. Opens under a session delegation only.
 *
 * There is no other form: a value without an envelope does not open, and
 * a value under somebody else's key fails its authentication tag.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { decrypt, encrypt, USER_ENVELOPE_PREFIX } from '@renkei/crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { getKeyRing, type KeyError } from './keyring';

export const PRIVATE_ENVELOPE_PREFIX = 'upriv1:';

/** Which of the person's keys a value goes under; see the module comment. */
export type SealScope = 'automation' | 'session';

export type SealError = Exclude<KeyError, 'NO_USER_KEY'>;
export type OpenError = KeyError | 'DECRYPTION_ERROR';

export function isUserSealed(value: string): boolean {
  return value.startsWith(USER_ENVELOPE_PREFIX) || value.startsWith(PRIVATE_ENVELOPE_PREFIX);
}

/** Seal a person's own value under the key its scope names. */
export async function sealForSubject(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  plaintext: string,
  scope: SealScope = 'automation'
): Promise<Result<string, SealError>> {
  const ring = await getKeyRing(db, tenantId, subject, scope === 'session' ? 'session' : 'any');
  if (!ring.ok) return err(ring.err.type === 'NO_USER_KEY' ? 'NOT_ENROLLED' : ring.err.type);
  if (scope === 'session') {
    if (!ring.val.userKey) return err('NEEDS_SESSION' as const);
    return ok(PRIVATE_ENVELOPE_PREFIX + encrypt(plaintext, ring.val.userKey));
  }
  return ok(USER_ENVELOPE_PREFIX + encrypt(plaintext, ring.val.automationKey));
}

/** Open a person's value under the key its envelope names; anything else is an error. */
export async function openForSubject(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  stored: string
): Promise<Result<string, OpenError>> {
  if (stored.startsWith(PRIVATE_ENVELOPE_PREFIX)) {
    const ring = await getKeyRing(db, tenantId, subject, 'session');
    if (!ring.ok) return ring;
    if (!ring.val.userKey) return err('NEEDS_SESSION' as const);
    const opened = decrypt(stored.slice(PRIVATE_ENVELOPE_PREFIX.length), ring.val.userKey);
    return opened.ok ? ok(opened.val) : err('DECRYPTION_ERROR' as const);
  }
  if (!stored.startsWith(USER_ENVELOPE_PREFIX)) {
    return err('DECRYPTION_ERROR' as const, {
      message: 'value is not sealed under a user key — run the rekey sweep',
    });
  }
  const ring = await getKeyRing(db, tenantId, subject);
  if (!ring.ok) return ring;
  const opened = decrypt(stored.slice(USER_ENVELOPE_PREFIX.length), ring.val.automationKey);
  return opened.ok ? ok(opened.val) : err('DECRYPTION_ERROR' as const);
}
