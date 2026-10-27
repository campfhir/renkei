/**
 * The key-encryption keys from before a person held their own
 * (docs/user-encryption-keys-design.md): `managed`, derived from the
 * deployment master and the person's salt, and `own`, derived from a
 * passphrase. Nothing in the application opens a row under either any
 * more. Two things still need them, and only they import this module:
 *
 *   - `enroll` (enrollment.ts), which opens a person's existing rows one
 *     last time to move them under the key the browser just made;
 *   - the rollout sweep (scripts/rekey-chats.ts), which moves rows from
 *     before per-user keys under a managed key for a person who has not
 *     enrolled yet, so that enrollment finds everything in one place.
 *
 * The master, USER_KEY_ENCRYPTION_KEY, is therefore optional on the
 * delegate: set it while people with pre-enrollment rows remain, remove
 * it once `maintenance/enrollment` reports none. Without it, a person on
 * a managed key cannot enroll (MIGRATION_UNAVAILABLE) rather than enrol
 * with their history unreadable.
 */

import { getDataStore } from '@renkei/db';
import {
  deriveOwnKek,
  deriveUnlockKey,
  deriveUserKek,
  generateDataKey,
  generateUserKeySalt,
  sealForUser,
  unwrapKey,
  userKeyMaster,
  verifierMatches,
  wrapKey,
} from '@renkei/crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

export interface LegacyKeyRow {
  salt: string;
  mode: string;
  version: number;
  verifier: string | null;
  sealed_kek: string | null;
  unlocked_until: Date | null;
}

export type LegacyKekError =
  /** A managed row with no master in this process: the operator removed it too soon. */
  | 'MIGRATION_UNAVAILABLE'
  /** An own-key row, locked, and no passphrase given. */
  | 'KEY_LOCKED'
  | 'WRONG_PASSPHRASE';

/** The KEK a pre-enrollment row yields, for the one read that moves everything off it. */
export function legacyKekOf(
  row: LegacyKeyRow,
  domain: string,
  subject: string,
  passphrase?: string
): Result<Buffer, LegacyKekError> {
  const salt = Buffer.from(row.salt, 'base64');
  if (row.mode === 'own') {
    if (passphrase && row.verifier) {
      const kek = deriveOwnKek(passphrase, salt, domain, subject);
      return verifierMatches(kek, row.verifier) ? ok(kek) : err('WRONG_PASSPHRASE' as const);
    }
    const master = userKeyMaster();
    if (
      !master.ok ||
      !row.sealed_kek ||
      !row.unlocked_until ||
      row.unlocked_until.getTime() <= Date.now()
    ) {
      return err('KEY_LOCKED' as const);
    }
    const unsealed = unwrapKey(row.sealed_kek, deriveUnlockKey(master.val, salt, domain, subject));
    return unsealed.ok ? ok(unsealed.val) : err('KEY_LOCKED' as const);
  }
  const master = userKeyMaster();
  if (!master.ok) return err('MIGRATION_UNAVAILABLE' as const);
  return ok(deriveUserKek(master.val, salt, domain, subject));
}

/**
 * The domain the pre-enrollment KEKs were derived under: the id of the
 * organization row this deployment had while it was multi-tenant, kept in
 * the `legacy_key_domain` setting by the migration that removed tenants.
 * A deployment born single-organization has no such rows and no setting;
 * the empty string then derives nothing anyone stored.
 */
export async function legacyKeyDomain(): Promise<string> {
  const value = await getDataStore().settings.get('legacy_key_domain');
  return typeof value === 'string' ? value : '';
}

/** Is the master present, so managed rows can still be moved? */
export function legacyMasterAvailable(): boolean {
  return userKeyMaster().ok;
}

/**
 * The rollout sweep's half: a MANAGED key for a person who has not
 * enrolled, created if they have none. A person already enrolled or on
 * their own key is not this function's to touch.
 */
export async function legacyManagedKek(
  subject: string
): Promise<Result<{ key: Buffer; version: number }, 'MIGRATION_UNAVAILABLE' | 'NOT_MANAGED'>> {
  const master = userKeyMaster();
  if (!master.ok) return err('MIGRATION_UNAVAILABLE' as const);
  const row = await getDataStore().userKeys.ensureLegacyRow(
    subject,
    generateUserKeySalt().toString('base64')
  );
  if (row.mode !== 'managed') return err('NOT_MANAGED' as const);
  return ok({
    key: deriveUserKek(
      master.val,
      Buffer.from(row.salt, 'base64'),
      await legacyKeyDomain(),
      subject
    ),
    version: row.version,
  });
}

/** The sweep's seal: a `uenc1:` value under the person's managed key. */
export async function legacySealForSubject(
  subject: string,
  plaintext: string
): Promise<Result<string, 'MIGRATION_UNAVAILABLE' | 'NOT_MANAGED'>> {
  const kek = await legacyManagedKek(subject);
  if (!kek.ok) return kek;
  return ok(sealForUser(plaintext, kek.val.key));
}

/**
 * The sweep's resource key: minted for the owner under their managed key,
 * or the existing one opened; `legacyShareResourceKey` wraps it for a
 * grantee the same way. Enrollment later moves each wrapping to the
 * person's held key.
 */
export async function legacyEnsureResourceKey(
  ref: { kind: string; resourceId: string },
  ownerSubject: string
): Promise<
  Result<{ id: string; key: Buffer }, 'MIGRATION_UNAVAILABLE' | 'NOT_MANAGED' | 'DECRYPTION_ERROR'>
> {
  const kek = await legacyManagedKek(ownerSubject);
  if (!kek.ok) return kek;
  const store = getDataStore().resourceKeys;
  const existing = await store.findWithWrapping(ref.kind, ref.resourceId, 'user', ownerSubject);
  if (existing?.wrappedKey) {
    const key = unwrapKey(existing.wrappedKey, kek.val.key);
    return key.ok ? ok({ id: existing.id, key: key.val }) : err('DECRYPTION_ERROR' as const);
  }
  if (existing) return err('DECRYPTION_ERROR' as const, { message: 'key held by others only' });
  const key = generateDataKey();
  const inserted = await store.insertIfAbsent(ref.kind, ref.resourceId);
  // Another writer minted it between the read and here: the sweep runs alone,
  // so this is a second sweep racing — fail the row rather than guess.
  if (inserted === null) throw new Error(`resource key for ${ref.kind} ${ref.resourceId} exists`);
  await store.upsertWrapping({
    resourceKeyId: inserted,
    holderKind: 'user',
    holder: ownerSubject,
    wrappedKey: wrapKey(key, kek.val.key),
    kekVersion: kek.val.version,
    grantedBy: null,
  });
  return ok({ id: inserted, key });
}

export async function legacyShareResourceKey(
  key: { id: string; key: Buffer },
  fromSubject: string,
  toSubject: string
): Promise<Result<void, 'MIGRATION_UNAVAILABLE' | 'NOT_MANAGED'>> {
  const kek = await legacyManagedKek(toSubject);
  if (!kek.ok) return kek;
  await getDataStore().resourceKeys.insertWrappingIfAbsent({
    resourceKeyId: key.id,
    holderKind: 'user',
    holder: toSubject,
    wrappedKey: wrapKey(key.key, kek.val.key),
    kekVersion: kek.val.version,
    grantedBy: fromSubject,
  });
  return ok();
}
