/**
 * A person's key-encryption key (KEK): derived, never stored.
 *
 * `user_encryption_keys` (migration 133) holds only the SALT; the KEK is
 * HKDF(master, salt, tenant ‖ subject) recomputed on every use, so no
 * table row and no backup yields a usable key without the deployment
 * master as well. The row is created the first time a person needs a
 * key — a chat of theirs is started, a chat is shared with them, a
 * credential of theirs is sealed — and `version` counts rotations.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  deriveUserKek,
  generateUserKeySalt,
  userKeyMaster,
  unwrapKey,
  wrapKey,
} from '@renkei/crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

export interface UserKek {
  key: Buffer;
  version: number;
}

export type KekError = 'MISSING_USER_KEY_MASTER' | 'INVALID_ENCRYPTION_KEY' | 'NO_USER_KEY';

function derive(
  row: { salt: string; version: number },
  tenantId: string,
  subject: string
): Result<UserKek, KekError> {
  const master = userKeyMaster();
  if (!master.ok) return master;
  const salt = Buffer.from(row.salt, 'base64');
  return ok({ key: deriveUserKek(master.val, salt, tenantId, subject), version: row.version });
}

/** The person's current KEK, or NO_USER_KEY when they have never needed one. */
export async function getUserKek(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<Result<UserKek, KekError>> {
  const row = await db
    .selectFrom('user_encryption_keys')
    .select(['salt', 'version'])
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', subject)
    .executeTakeFirst();
  if (!row) return err('NO_USER_KEY' as const);
  return derive(row, tenantId, subject);
}

/**
 * The person's KEK, creating their salt on first use. Two requests racing
 * to create it both land on the one row: the insert does nothing on
 * conflict and the read after it sees whichever salt won.
 */
export async function ensureUserKek(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<Result<UserKek, Exclude<KekError, 'NO_USER_KEY'>>> {
  const existing = await getUserKek(db, tenantId, subject);
  if (existing.ok) return existing;
  if (existing.err.type !== 'NO_USER_KEY') return err(existing.err.type);
  await db
    .insertInto('user_encryption_keys')
    .values({ tenant_id: tenantId, subject, salt: generateUserKeySalt().toString('base64') })
    .onConflict((oc) => oc.columns(['tenant_id', 'subject']).doNothing())
    .execute();
  const created = await getUserKek(db, tenantId, subject);
  if (!created.ok) {
    // The row was just written; only a master-key problem is left.
    return err(created.err.type === 'NO_USER_KEY' ? 'MISSING_USER_KEY_MASTER' : created.err.type);
  }
  return created;
}

/**
 * Rotate one person's KEK: a new salt, and every key wrapped for them
 * rewrapped under the new KEK in the same transaction, so there is never
 * a moment where a grant names a KEK that no longer exists. Values sealed
 * DIRECTLY under the KEK (`uenc1:` credentials) are not here — the
 * caller that owns such rows rewraps them with `rewrapForSubject`.
 */
export async function rotateUserKek(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<Result<{ version: number; rewrapped: number }, KekError | 'DECRYPTION_ERROR'>> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('user_encryption_keys')
      .select(['salt', 'version'])
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', subject)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return err('NO_USER_KEY' as const);
    const current = derive(row, tenantId, subject);
    if (!current.ok) return current;
    const nextSalt = generateUserKeySalt();
    const next = derive(
      { salt: nextSalt.toString('base64'), version: row.version + 1 },
      tenantId,
      subject
    );
    if (!next.ok) return next;

    const grants = await trx
      .selectFrom('resource_key_grants')
      .select(['resource_key_id', 'wrapped_key'])
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', subject)
      .forUpdate()
      .execute();
    for (const grant of grants) {
      const key = unwrapKey(grant.wrapped_key, current.val.key);
      if (!key.ok) return err('DECRYPTION_ERROR' as const);
      await trx
        .updateTable('resource_key_grants')
        .set({ wrapped_key: wrapKey(key.val, next.val.key), kek_version: next.val.version })
        .where('resource_key_id', '=', grant.resource_key_id)
        .where('subject', '=', subject)
        .execute();
    }
    await trx
      .updateTable('user_encryption_keys')
      .set({ salt: nextSalt.toString('base64'), version: next.val.version, rotated_at: new Date() })
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', subject)
      .execute();
    return ok({ version: next.val.version, rewrapped: grants.length });
  });
}

/**
 * Remove a person's salt: every wrapping made for them, and every value
 * sealed directly under their KEK, becomes unopenable at once. The
 * grant rows themselves stay (they are inert) until their resources go.
 */
export async function shredUserKek(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<boolean> {
  const result = await db
    .deleteFrom('user_encryption_keys')
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', subject)
    .executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}
