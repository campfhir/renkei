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

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
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
  tenantId: string,
  subject: string,
  passphrase?: string
): Result<Buffer, LegacyKekError> {
  const salt = Buffer.from(row.salt, 'base64');
  if (row.mode === 'own') {
    if (passphrase && row.verifier) {
      const kek = deriveOwnKek(passphrase, salt, tenantId, subject);
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
    const unsealed = unwrapKey(
      row.sealed_kek,
      deriveUnlockKey(master.val, salt, tenantId, subject)
    );
    return unsealed.ok ? ok(unsealed.val) : err('KEY_LOCKED' as const);
  }
  const master = userKeyMaster();
  if (!master.ok) return err('MIGRATION_UNAVAILABLE' as const);
  return ok(deriveUserKek(master.val, salt, tenantId, subject));
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
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<Result<{ key: Buffer; version: number }, 'MIGRATION_UNAVAILABLE' | 'NOT_MANAGED'>> {
  const master = userKeyMaster();
  if (!master.ok) return err('MIGRATION_UNAVAILABLE' as const);
  await db
    .insertInto('user_encryption_keys')
    .values({ subject, salt: generateUserKeySalt().toString('base64') })
    .onConflict((oc) => oc.columns(['subject']).doNothing())
    .execute();
  const row = await db
    .selectFrom('user_encryption_keys')
    .select(['salt', 'mode', 'version'])
    .where('subject', '=', subject)
    .executeTakeFirstOrThrow();
  if (row.mode !== 'managed') return err('NOT_MANAGED' as const);
  return ok({
    key: deriveUserKek(master.val, Buffer.from(row.salt, 'base64'), tenantId, subject),
    version: row.version,
  });
}

/** The sweep's seal: a `uenc1:` value under the person's managed key. */
export async function legacySealForSubject(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  plaintext: string
): Promise<Result<string, 'MIGRATION_UNAVAILABLE' | 'NOT_MANAGED'>> {
  const kek = await legacyManagedKek(db, tenantId, subject);
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
  db: Kysely<DB>,
  ref: { tenantId: string; kind: string; resourceId: string },
  ownerSubject: string
): Promise<
  Result<{ id: string; key: Buffer }, 'MIGRATION_UNAVAILABLE' | 'NOT_MANAGED' | 'DECRYPTION_ERROR'>
> {
  const kek = await legacyManagedKek(db, ref.tenantId, ownerSubject);
  if (!kek.ok) return kek;
  const existing = await db
    .selectFrom('resource_keys as k')
    .leftJoin('resource_key_grants as g', (join) =>
      join
        .onRef('g.resource_key_id', '=', 'k.id')
        .on('g.holder_kind', '=', 'user')
        .on('g.holder', '=', ownerSubject)
    )
    .select(['k.id', 'g.wrapped_key'])
    .where('k.resource_kind', '=', ref.kind)
    .where('k.resource_id', '=', ref.resourceId)
    .executeTakeFirst();
  if (existing?.wrapped_key) {
    const key = unwrapKey(existing.wrapped_key, kek.val.key);
    return key.ok ? ok({ id: existing.id, key: key.val }) : err('DECRYPTION_ERROR' as const);
  }
  if (existing) return err('DECRYPTION_ERROR' as const, { message: 'key held by others only' });
  const key = generateDataKey();
  const inserted = await db
    .insertInto('resource_keys')
    .values({ resource_kind: ref.kind, resource_id: ref.resourceId })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('resource_key_grants')
    .values({
      resource_key_id: inserted.id,
      holder_kind: 'user',
      holder: ownerSubject,
      wrapped_key: wrapKey(key, kek.val.key),
      kek_version: kek.val.version,
      granted_by: null,
    })
    .execute();
  return ok({ id: inserted.id, key });
}

export async function legacyShareResourceKey(
  db: Kysely<DB>,
  key: { id: string; key: Buffer },
  tenantId: string,
  fromSubject: string,
  toSubject: string
): Promise<Result<void, 'MIGRATION_UNAVAILABLE' | 'NOT_MANAGED'>> {
  const kek = await legacyManagedKek(db, tenantId, toSubject);
  if (!kek.ok) return kek;
  await db
    .insertInto('resource_key_grants')
    .values({
      resource_key_id: key.id,
      holder_kind: 'user',
      holder: toSubject,
      wrapped_key: wrapKey(key.key, kek.val.key),
      kek_version: kek.val.version,
      granted_by: fromSubject,
    })
    .onConflict((oc) => oc.columns(['resource_key_id', 'holder_kind', 'holder']).doNothing())
    .execute();
  return ok();
}
