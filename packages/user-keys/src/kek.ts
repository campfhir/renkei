/**
 * A person's key-encryption key (KEK): derived, never stored.
 *
 * `user_encryption_keys` (migrations 133, 134) holds a SALT and a MODE:
 *
 * - `managed` (the default): the KEK is HKDF(master, salt, tenant ‖
 *   subject), recomputed on every use. No row and no backup yields a
 *   usable key without the deployment master as well.
 * - `own`: the KEK is derived from a passphrase only the person holds
 *   (scrypt, then HKDF into its own key space) — bring-your-own-key. The
 *   row keeps a one-way `verifier` to check the passphrase and, while the
 *   person has UNLOCKED the key, the KEK sealed under a master-derived
 *   key until `unlocked_until`, so every process can use it for that
 *   window. Locked, nothing Renkei stores can produce it: their chats,
 *   credentials and memory are unreadable to everyone, Renkei included,
 *   until they unlock it again. Forgetting the passphrase is losing the
 *   data — there is no recovery by design.
 *
 * The row is created the first time a person needs a key; `version`
 * counts every change of KEK (a managed rotation, an adoption, a revert),
 * and `rewrapForSubject` moves everything sealed under the old KEK to the
 * new one in the same transaction, so there is never a moment where a
 * row names a KEK that no longer exists.
 */

import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@renkei/db';
import {
  deriveOwnKek,
  deriveUnlockKey,
  deriveUserKek,
  generateUserKeySalt,
  isUserSealed,
  kekVerifier,
  openForUser,
  sealForUser,
  unwrapKey,
  userKeyMaster,
  verifierMatches,
  wrapKey,
  OWN_KEY_PASSPHRASE_MAX_CHARS,
  OWN_KEY_PASSPHRASE_MIN_CHARS,
} from '@renkei/crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

export type KekMode = 'managed' | 'own';

export interface UserKek {
  key: Buffer;
  version: number;
  mode: KekMode;
}

export type KekError =
  | 'MISSING_USER_KEY_MASTER'
  | 'INVALID_ENCRYPTION_KEY'
  /** The person has never needed a key. */
  | 'NO_USER_KEY'
  /** The person is on their own key and has not unlocked it. */
  | 'KEY_LOCKED';

/** What the preferences page shows and the chat's notice reads. */
export interface UserKeyStatus {
  mode: KekMode;
  version: number;
  /** For `own`: whether the key is usable right now, and until when. */
  locked: boolean;
  unlockedUntil: Date | null;
  createdAt: Date | null;
  rotatedAt: Date | null;
}

/** How long an unlock lasts unless the person says otherwise, and the most they may ask for. */
export const OWN_KEY_UNLOCK_DEFAULT_MS = 24 * 60 * 60_000;
export const OWN_KEY_UNLOCK_MAX_MS = 30 * 24 * 60 * 60_000;

type KeyRow = {
  salt: string;
  version: number;
  mode: string;
  verifier: string | null;
  sealed_kek: string | null;
  unlocked_until: Date | null;
};

const ROW_COLUMNS = [
  'salt',
  'version',
  'mode',
  'verifier',
  'sealed_kek',
  'unlocked_until',
] as const;

function modeOf(value: string): KekMode {
  return value === 'own' ? 'own' : 'managed';
}

async function readRow(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  forUpdate = false
): Promise<KeyRow | null> {
  let query = db
    .selectFrom('user_encryption_keys')
    .select(ROW_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', subject);
  if (forUpdate) query = query.forUpdate();
  return (await query.executeTakeFirst()) ?? null;
}

/** The KEK a row yields right now: derived for managed, unsealed for an unlocked own key. */
function kekOf(row: KeyRow, tenantId: string, subject: string): Result<UserKek, KekError> {
  const master = userKeyMaster();
  if (!master.ok) return master;
  const salt = Buffer.from(row.salt, 'base64');
  if (modeOf(row.mode) === 'managed') {
    return ok({
      key: deriveUserKek(master.val, salt, tenantId, subject),
      version: row.version,
      mode: 'managed',
    });
  }
  if (!row.sealed_kek || !row.unlocked_until || row.unlocked_until.getTime() <= Date.now()) {
    return err('KEY_LOCKED' as const);
  }
  const unsealed = unwrapKey(row.sealed_kek, deriveUnlockKey(master.val, salt, tenantId, subject));
  if (!unsealed.ok) return err('KEY_LOCKED' as const);
  return ok({ key: unsealed.val, version: row.version, mode: 'own' });
}

/** The person's current KEK, or NO_USER_KEY when they have never needed one. */
export async function getUserKek(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<Result<UserKek, KekError>> {
  const row = await readRow(db, tenantId, subject);
  if (!row) return err('NO_USER_KEY' as const);
  return kekOf(row, tenantId, subject);
}

/**
 * The person's KEK, creating a managed salt on first use. Two requests
 * racing to create it both land on the one row: the insert does nothing
 * on conflict and the read after it sees whichever salt won.
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

export async function getUserKeyStatus(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<UserKeyStatus> {
  const row = await db
    .selectFrom('user_encryption_keys')
    .select([...ROW_COLUMNS, 'created_at', 'rotated_at'])
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', subject)
    .executeTakeFirst();
  if (!row) {
    return {
      mode: 'managed',
      version: 0,
      locked: false,
      unlockedUntil: null,
      createdAt: null,
      rotatedAt: null,
    };
  }
  const mode = modeOf(row.mode);
  const unlocked =
    mode === 'own' &&
    row.sealed_kek !== null &&
    row.unlocked_until !== null &&
    row.unlocked_until.getTime() > Date.now();
  return {
    mode,
    version: row.version,
    locked: mode === 'own' && !unlocked,
    unlockedUntil: unlocked ? row.unlocked_until : null,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
  };
}

/**
 * Everything at rest under one person's KEK, by table: the wrappings of
 * resource keys they hold, and every value sealed directly (`uenc1:`).
 * A change of KEK walks this list; so does the shred's reasoning about
 * what a shred makes unreadable. Add a table here when a new column is
 * sealed for a subject.
 */
const SEALED_FOR_SUBJECT: {
  table: string;
  subjectColumn: 'subject' | 'owner_subject';
  idColumns: readonly string[];
  columns: readonly string[];
}[] = [
  {
    table: 'provider_grants',
    subjectColumn: 'subject',
    idColumns: ['provider', 'provider_account_id'],
    columns: ['encrypted_access_token', 'encrypted_refresh_token'],
  },
  {
    table: 'mirth_instance_connections',
    subjectColumn: 'subject',
    idColumns: ['instance_id'],
    columns: ['encrypted_credentials'],
  },
  {
    table: 'admanager_instance_connections',
    subjectColumn: 'subject',
    idColumns: ['instance_id'],
    columns: ['encrypted_credentials'],
  },
  {
    table: 'file_share_connections',
    subjectColumn: 'subject',
    idColumns: ['share_id'],
    columns: ['encrypted_credentials'],
  },
  {
    table: 'chat_user_memories',
    subjectColumn: 'owner_subject',
    idColumns: ['id'],
    columns: ['content'],
  },
];

/**
 * Move everything sealed under `from` to `to`, inside the caller's
 * transaction. A row that does not open under `from` aborts the whole
 * change: a half-rewrapped person is worse than one on the old key.
 */
export async function rewrapForSubject(
  trx: Transaction<DB>,
  tenantId: string,
  subject: string,
  from: Buffer,
  to: { key: Buffer; version: number }
): Promise<Result<{ grants: number; values: number }, 'DECRYPTION_ERROR'>> {
  const grants = await trx
    .selectFrom('resource_key_grants')
    .select(['resource_key_id', 'wrapped_key'])
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', subject)
    .forUpdate()
    .execute();
  for (const grant of grants) {
    const key = unwrapKey(grant.wrapped_key, from);
    if (!key.ok) return err('DECRYPTION_ERROR' as const, { message: 'a resource key wrapping' });
    await trx
      .updateTable('resource_key_grants')
      .set({ wrapped_key: wrapKey(key.val, to.key), kek_version: to.version })
      .where('resource_key_id', '=', grant.resource_key_id)
      .where('subject', '=', subject)
      .execute();
  }
  let values = 0;
  for (const spec of SEALED_FOR_SUBJECT) {
    // The schema types are per table; the walk is the same for each, so it
    // is written once as SQL over identifiers rather than five typed copies.
    const table = sql.table(spec.table);
    const subjectColumn = sql.ref(spec.subjectColumn);
    const selected = [...spec.idColumns, ...spec.columns].map((column) => sql.ref(column));
    const rows = await sql<Record<string, unknown>>`
      SELECT ${sql.join(selected)} FROM ${table}
       WHERE tenant_id = ${tenantId} AND ${subjectColumn} = ${subject}
       FOR UPDATE
    `.execute(trx);
    for (const row of rows.rows) {
      const next: { column: string; value: string }[] = [];
      for (const column of spec.columns) {
        const stored = row[column];
        if (typeof stored !== 'string' || !isUserSealed(stored)) continue;
        const opened = openForUser(stored, from);
        if (!opened.ok) {
          return err('DECRYPTION_ERROR' as const, { message: `${spec.table}.${column}` });
        }
        next.push({ column, value: sealForUser(opened.val, to.key) });
      }
      if (next.length === 0) continue;
      const assignments = next.map((entry) => sql`${sql.ref(entry.column)} = ${entry.value}`);
      const identity = spec.idColumns.map(
        (column) => sql`${sql.ref(column)} = ${idValue(row[column])}`
      );
      await sql`
        UPDATE ${table} SET ${sql.join(assignments)}
         WHERE tenant_id = ${tenantId} AND ${subjectColumn} = ${subject}
           AND ${sql.join(identity, sql` AND `)}
      `.execute(trx);
      values += 1;
    }
  }
  return ok({ grants: grants.length, values });
}

/** An id column's value as a bindable scalar (uuid, text) — never an object. */
function idValue(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

export type RewrapError = KekError | 'DECRYPTION_ERROR';

/**
 * Rotate a MANAGED KEK: a new salt, everything rewrapped under the new
 * derivation. (A person on their own key changes it with `adoptOwnKey`.)
 */
export async function rotateUserKek(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<Result<{ version: number; rewrapped: number }, RewrapError | 'NOT_MANAGED'>> {
  return db.transaction().execute(async (trx) => {
    const row = await readRow(trx, tenantId, subject, true);
    if (!row) return err('NO_USER_KEY' as const);
    if (modeOf(row.mode) !== 'managed') return err('NOT_MANAGED' as const);
    const current = kekOf(row, tenantId, subject);
    if (!current.ok) return current;
    const master = userKeyMaster();
    if (!master.ok) return master;
    const nextSalt = generateUserKeySalt();
    const next = {
      key: deriveUserKek(master.val, nextSalt, tenantId, subject),
      version: row.version + 1,
    };
    const moved = await rewrapForSubject(trx, tenantId, subject, current.val.key, next);
    if (!moved.ok) return moved;
    await trx
      .updateTable('user_encryption_keys')
      .set({ salt: nextSalt.toString('base64'), version: next.version, rotated_at: new Date() })
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', subject)
      .execute();
    return ok({ version: next.version, rewrapped: moved.val.grants + moved.val.values });
  });
}

export type PassphraseError = 'PASSPHRASE_TOO_SHORT' | 'PASSPHRASE_TOO_LONG';

function checkPassphrase(passphrase: string): Result<string, PassphraseError> {
  const normalized = passphrase.normalize('NFKC');
  if (normalized.length < OWN_KEY_PASSPHRASE_MIN_CHARS) return err('PASSPHRASE_TOO_SHORT' as const);
  if (normalized.length > OWN_KEY_PASSPHRASE_MAX_CHARS) return err('PASSPHRASE_TOO_LONG' as const);
  return ok(normalized);
}

function unlockWindow(ms: number | undefined): number {
  const requested = ms ?? OWN_KEY_UNLOCK_DEFAULT_MS;
  return Math.max(60_000, Math.min(OWN_KEY_UNLOCK_MAX_MS, requested));
}

/** The sealed form of an own KEK for its unlock window. */
function sealUnlocked(
  master: Buffer,
  salt: Buffer,
  tenantId: string,
  subject: string,
  kek: Buffer
): string {
  return wrapKey(kek, deriveUnlockKey(master, salt, tenantId, subject));
}

/**
 * Switch to (or change) a passphrase-derived key: everything the person
 * holds is rewrapped from the current KEK — managed, or their current
 * own key, which must be unlocked — to the new one, and the new key is
 * left unlocked for `unlockMs` so the person is not locked out of what
 * they just did.
 */
export async function adoptOwnKey(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  passphrase: string,
  options: { unlockMs?: number } = {}
): Promise<Result<UserKeyStatus, RewrapError | PassphraseError>> {
  const checked = checkPassphrase(passphrase);
  if (!checked.ok) return checked;
  const ensured = await ensureUserKek(db, tenantId, subject);
  if (!ensured.ok) return ensured;
  const outcome = await db
    .transaction()
    .execute(async (trx): Promise<Result<void, RewrapError>> => {
      const row = await readRow(trx, tenantId, subject, true);
      if (!row) return err('NO_USER_KEY' as const);
      const current = kekOf(row, tenantId, subject);
      if (!current.ok) return current;
      const master = userKeyMaster();
      if (!master.ok) return master;
      const salt = Buffer.from(row.salt, 'base64');
      const next = {
        key: deriveOwnKek(checked.val, salt, tenantId, subject),
        version: row.version + 1,
      };
      const moved = await rewrapForSubject(trx, tenantId, subject, current.val.key, next);
      if (!moved.ok) return moved;
      await trx
        .updateTable('user_encryption_keys')
        .set({
          mode: 'own',
          version: next.version,
          verifier: kekVerifier(next.key),
          sealed_kek: sealUnlocked(master.val, salt, tenantId, subject, next.key),
          unlocked_until: new Date(Date.now() + unlockWindow(options.unlockMs)),
          rotated_at: new Date(),
        })
        .where('tenant_id', '=', tenantId)
        .where('subject', '=', subject)
        .execute();
      return ok();
    });
  if (!outcome.ok) return outcome;
  return ok(await getUserKeyStatus(db, tenantId, subject));
}

export type UnlockError = KekError | 'NOT_OWN_KEY' | 'WRONG_PASSPHRASE';

/** Check the passphrase and hold the derived key for the window. */
export async function unlockOwnKey(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  passphrase: string,
  options: { unlockMs?: number } = {}
): Promise<Result<UserKeyStatus, Exclude<UnlockError, 'KEY_LOCKED'>>> {
  const row = await readRow(db, tenantId, subject);
  if (!row) return err('NO_USER_KEY' as const);
  if (modeOf(row.mode) !== 'own' || !row.verifier) return err('NOT_OWN_KEY' as const);
  const master = userKeyMaster();
  if (!master.ok) return master;
  const salt = Buffer.from(row.salt, 'base64');
  const kek = deriveOwnKek(passphrase.normalize('NFKC'), salt, tenantId, subject);
  if (!verifierMatches(kek, row.verifier)) return err('WRONG_PASSPHRASE' as const);
  await db
    .updateTable('user_encryption_keys')
    .set({
      sealed_kek: sealUnlocked(master.val, salt, tenantId, subject, kek),
      unlocked_until: new Date(Date.now() + unlockWindow(options.unlockMs)),
    })
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', subject)
    .execute();
  return ok(await getUserKeyStatus(db, tenantId, subject));
}

/** Forget the held key now; the next use needs the passphrase again. */
export async function lockOwnKey(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<UserKeyStatus> {
  await db
    .updateTable('user_encryption_keys')
    .set({ sealed_kek: null, unlocked_until: null })
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', subject)
    .where('mode', '=', 'own')
    .execute();
  return getUserKeyStatus(db, tenantId, subject);
}

/**
 * Back to a managed key, with the passphrase as proof: everything is
 * rewrapped from the own KEK to a fresh managed derivation and the
 * passphrase stops mattering.
 */
export async function revertToManagedKey(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  passphrase: string
): Promise<Result<UserKeyStatus, RewrapError | 'NOT_OWN_KEY' | 'WRONG_PASSPHRASE'>> {
  const outcome = await db
    .transaction()
    .execute(
      async (trx): Promise<Result<void, RewrapError | 'NOT_OWN_KEY' | 'WRONG_PASSPHRASE'>> => {
        const row = await readRow(trx, tenantId, subject, true);
        if (!row) return err('NO_USER_KEY' as const);
        if (modeOf(row.mode) !== 'own' || !row.verifier) return err('NOT_OWN_KEY' as const);
        const master = userKeyMaster();
        if (!master.ok) return master;
        const salt = Buffer.from(row.salt, 'base64');
        const own = deriveOwnKek(passphrase.normalize('NFKC'), salt, tenantId, subject);
        if (!verifierMatches(own, row.verifier)) return err('WRONG_PASSPHRASE' as const);
        const nextSalt = generateUserKeySalt();
        const next = {
          key: deriveUserKek(master.val, nextSalt, tenantId, subject),
          version: row.version + 1,
        };
        const moved = await rewrapForSubject(trx, tenantId, subject, own, next);
        if (!moved.ok) return moved;
        await trx
          .updateTable('user_encryption_keys')
          .set({
            mode: 'managed',
            salt: nextSalt.toString('base64'),
            version: next.version,
            verifier: null,
            sealed_kek: null,
            unlocked_until: null,
            rotated_at: new Date(),
          })
          .where('tenant_id', '=', tenantId)
          .where('subject', '=', subject)
          .execute();
        return ok();
      }
    );
  if (!outcome.ok) return outcome;
  return ok(await getUserKeyStatus(db, tenantId, subject));
}

/**
 * Remove a person's salt: every wrapping made for them, and every value
 * sealed directly under their KEK, becomes unopenable at once. The
 * rows themselves stay (they are inert) until their resources go.
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
