/**
 * Enrollment, delegations, rotation and the shred
 * (docs/delegate-key-design.md, "Enrollment, migration, devices, loss").
 *
 * The browser does the key work and this module records it:
 *
 *   enroll     — the person's first sign-in on a build with held keys. The
 *                browser generated their user key, keypair and automation
 *                key, wrapped the private and automation keys under the
 *                user key, and sealed the user key to every live instance.
 *                Here: open the delegation sealed to THIS instance, check
 *                the wrappings are consistent with it, move whatever the
 *                person held under a pre-enrollment key to the new ones,
 *                write the row and the delegations — in one transaction.
 *   delegate   — a later sign-in, or a re-seal after a delegate restart:
 *                store fresh session and automation delegations.
 *   rotate     — a new user key: the browser re-wrapped the private and
 *                automation keys under it and sealed it to the instances;
 *                here every `user` wrapping and every `upriv1` value moves
 *                from the old user key to the new, under the old key's
 *                session delegation. The keypair and the automation key
 *                are unchanged, so shares and credentials need no work.
 *   shred      — the person is gone: their row, and with it (cascade)
 *                every delegation, and every wrapping made for them.
 */

import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '@renkei/db';
import {
  decrypt,
  encrypt,
  isSealedBox,
  kekVerifier,
  openForUser,
  unwrapKey,
  verifierMatches,
  wrapKey,
  x25519PublicKeyOf,
  USER_ENVELOPE_PREFIX,
} from '@renkei/crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import {
  getKeyRing,
  readKeyRow,
  ringFromUserKey,
  type HeldRow,
  type KeyError,
  type KeyRing,
} from './keyring';
import { legacyKekOf, legacyKeyDomain, type LegacyKekError } from './legacy';
import { verifySession } from './request-scope';
import { PRIVATE_ENVELOPE_PREFIX } from './user-sealed';
import { keyVault } from './vault';

/** The most an automation delegation may run for (decision 4). */
export const AUTOMATION_WINDOW_MAX_MS = 30 * 24 * 60 * 60_000;
export const AUTOMATION_WINDOW_DEFAULT_MS = AUTOMATION_WINDOW_MAX_MS;

export interface SealedDelegation {
  instanceId: string;
  /** A sealed box to that instance's public key, holding the user key (session) or the automation key (automation). */
  sealedKey: string;
}

export interface DelegationInput {
  subject: string;
  /** The browser session the session delegations live and die with. */
  sessionId: string;
  session: SealedDelegation[];
  automation: SealedDelegation[];
  /** When the automation delegations lapse; clamped to the maximum. */
  automationUntil: Date | null;
  /**
   * An empty `session` list is otherwise refused (a request that carries no
   * delegation has nothing to store and would only drop this session's);
   * set when dropping them is the point (sign-out, "forget this session").
   */
  revokeSession?: boolean;
}

export interface EnrollInput extends DelegationInput {
  /** Raw X25519 public key, base64. */
  publicKey: string;
  wrappedPrivateKey: string;
  wrappedAutomationKey: string;
  /** For a person on a passphrase-derived key from before: proves the old key. */
  passphrase?: string;
}

export type EnrollError =
  | 'NO_VAULT'
  /** No session delegation for this instance, or it does not open to a 32-byte key. */
  | 'BAD_DELEGATION'
  /** The wrapped private or automation key does not open under the user key, or the public key does not match. */
  | 'KEY_MISMATCH'
  /** The session named is not this person's live session. */
  | 'SESSION_MISMATCH'
  | 'ALREADY_ENROLLED'
  | LegacyKekError
  | 'DECRYPTION_ERROR';

export type DelegateError =
  | 'NO_VAULT'
  | 'NOT_ENROLLED'
  | 'BAD_DELEGATION'
  | 'SESSION_MISMATCH'
  /** Replacing the automation delegations needs the person's own session blob in the same request. */
  | 'NEEDS_SESSION'
  | 'NO_USER_KEY';

export type RotateError =
  KeyError | 'BAD_DELEGATION' | 'KEY_MISMATCH' | 'SESSION_MISMATCH' | 'DECRYPTION_ERROR';

/**
 * Everything at rest under one person's own keys, by table: the wrappings
 * of resource keys they hold, and every value sealed directly. A change of
 * key walks this list; so does enrollment's move off a pre-enrollment key.
 * Add a table here when a new column is sealed for a subject.
 */
const SEALED_FOR_SUBJECT: {
  table: string;
  subjectColumn: 'subject' | 'owner_subject';
  idColumns: readonly string[];
  columns: readonly string[];
  /** Which of the person's keys the value goes under once they hold their own. */
  scope: 'automation' | 'session';
}[] = [
  {
    table: 'provider_grants',
    subjectColumn: 'subject',
    idColumns: ['provider', 'provider_account_id'],
    columns: ['encrypted_access_token', 'encrypted_refresh_token'],
    scope: 'automation',
  },
  {
    table: 'mirth_instance_connections',
    subjectColumn: 'subject',
    idColumns: ['instance_id'],
    columns: ['encrypted_credentials'],
    scope: 'automation',
  },
  {
    table: 'admanager_instance_connections',
    subjectColumn: 'subject',
    idColumns: ['instance_id'],
    columns: ['encrypted_credentials'],
    scope: 'automation',
  },
  {
    table: 'file_share_connections',
    subjectColumn: 'subject',
    idColumns: ['share_id'],
    columns: ['encrypted_credentials'],
    scope: 'automation',
  },
  {
    table: 'chat_user_memories',
    subjectColumn: 'owner_subject',
    idColumns: ['id'],
    columns: ['content'],
    scope: 'session',
  },
];

/** An id column's value as a bindable scalar (uuid, text) — never an object. */
function idValue(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

/** The next envelope for a value, by scope: `uenc1:` under the automation key, `upriv1:` under the user key. */
function resealed(
  plaintext: string,
  scope: 'automation' | 'session',
  keys: { userKey: Buffer; automationKey: Buffer }
): string {
  return scope === 'session'
    ? PRIVATE_ENVELOPE_PREFIX + encrypt(plaintext, keys.userKey)
    : USER_ENVELOPE_PREFIX + encrypt(plaintext, keys.automationKey);
}

/** A value under the OLD key opened: the pre-enrollment `uenc1:` (one KEK for everything), or the held forms. */
function openUnderOld(
  stored: string,
  old: { userKey: Buffer; automationKey: Buffer } | { legacy: Buffer }
): string | null {
  if ('legacy' in old) {
    const opened = openForUser(stored, old.legacy);
    return opened.ok ? opened.val : null;
  }
  if (stored.startsWith(PRIVATE_ENVELOPE_PREFIX)) {
    const opened = decrypt(stored.slice(PRIVATE_ENVELOPE_PREFIX.length), old.userKey);
    return opened.ok ? opened.val : null;
  }
  if (stored.startsWith(USER_ENVELOPE_PREFIX)) {
    const opened = decrypt(stored.slice(USER_ENVELOPE_PREFIX.length), old.automationKey);
    return opened.ok ? opened.val : null;
  }
  return null;
}

/**
 * Move everything sealed for the person from `old` to `next`, inside the
 * caller's transaction. A row that does not open under `old` aborts the
 * whole change: a half-moved person is worse than one on the old key.
 * Wrappings: `user` ones move to the new user key; `automation` ones (held
 * rows only) to the new automation key — the same bytes when only the
 * user key rotated.
 */
async function moveSealedRows(
  trx: Transaction<DB>,
  subject: string,
  old: { userKey: Buffer; automationKey: Buffer } | { legacy: Buffer },
  next: { userKey: Buffer; automationKey: Buffer; version: number }
): Promise<Result<{ grants: number; values: number }, 'DECRYPTION_ERROR'>> {
  const grants = await trx
    .selectFrom('resource_key_grants')
    .select(['resource_key_id', 'holder_kind', 'wrapped_key'])
    .where('holder', '=', subject)
    .where('holder_kind', 'in', ['user', 'automation'])
    .forUpdate()
    .execute();
  for (const grant of grants) {
    const oldKey =
      'legacy' in old
        ? old.legacy
        : grant.holder_kind === 'automation'
          ? old.automationKey
          : old.userKey;
    const key = unwrapKey(grant.wrapped_key, oldKey);
    if (!key.ok) return err('DECRYPTION_ERROR' as const, { message: 'a resource key wrapping' });
    const nextKey = grant.holder_kind === 'automation' ? next.automationKey : next.userKey;
    await trx
      .updateTable('resource_key_grants')
      .set({ wrapped_key: wrapKey(key.val, nextKey), kek_version: next.version })
      .where('resource_key_id', '=', grant.resource_key_id)
      .where('holder_kind', '=', grant.holder_kind)
      .where('holder', '=', subject)
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
       WHERE ${subjectColumn} = ${subject}
       FOR UPDATE
    `.execute(trx);
    for (const row of rows.rows) {
      const assignments: ReturnType<typeof sql>[] = [];
      for (const column of spec.columns) {
        const stored = row[column];
        if (typeof stored !== 'string') continue;
        if (!stored.startsWith(USER_ENVELOPE_PREFIX) && !stored.startsWith(PRIVATE_ENVELOPE_PREFIX))
          continue;
        const opened = openUnderOld(stored, old);
        if (opened === null) {
          return err('DECRYPTION_ERROR' as const, { message: `${spec.table}.${column}` });
        }
        assignments.push(sql`${sql.ref(column)} = ${resealed(opened, spec.scope, next)}`);
      }
      if (assignments.length === 0) continue;
      const identity = spec.idColumns.map(
        (column) => sql`${sql.ref(column)} = ${idValue(row[column])}`
      );
      await sql`
        UPDATE ${table} SET ${sql.join(assignments)}
         WHERE ${subjectColumn} = ${subject}
           AND ${sql.join(identity, sql` AND `)}
      `.execute(trx);
      values += 1;
    }
  }
  return ok({ grants: grants.length, values });
}

/** The user key this instance's session delegation carries, checked against the wrappings. */
function openOwnDelegation(
  session: SealedDelegation[],
  row: Pick<HeldRow, 'public_key' | 'wrapped_private_key' | 'wrapped_automation_key'>
): Result<
  { userKey: Buffer; automationKey: Buffer },
  'NO_VAULT' | 'BAD_DELEGATION' | 'KEY_MISMATCH'
> {
  const vault = keyVault();
  if (!vault) return err('NO_VAULT' as const);
  const own = session.find((entry) => entry.instanceId === vault.instanceId);
  if (!own || !isSealedBox(own.sealedKey)) return err('BAD_DELEGATION' as const);
  const userKey = vault.open(own.sealedKey);
  if (!userKey || userKey.byteLength !== 32) return err('BAD_DELEGATION' as const);
  if (!row.wrapped_automation_key || !row.wrapped_private_key || !row.public_key) {
    return err('KEY_MISMATCH' as const);
  }
  const automation = unwrapKey(row.wrapped_automation_key, userKey);
  const privateKey = unwrapKey(row.wrapped_private_key, userKey);
  if (!automation.ok || !privateKey.ok) return err('KEY_MISMATCH' as const);
  if (!x25519PublicKeyOf(privateKey.val).equals(Buffer.from(row.public_key, 'base64'))) {
    return err('KEY_MISMATCH' as const);
  }
  return ok({ userKey, automationKey: automation.val });
}

/**
 * The automation blob sealed to THIS instance must open to the person's
 * real automation key — the one their session ring (or their fresh
 * wrappings, at rotation) says it is — and to the verifier the row keeps
 * of it. Without that, a request that proves nothing could replace every
 * automation row with boxes of its own making and sideline the person's
 * agents until their next sign-in, or hand a key of the attacker's choosing
 * to a delegate instance.
 */
function checkOwnAutomation(
  automation: SealedDelegation[],
  expected: Buffer,
  verifier: string | null
): Result<void, 'NO_VAULT' | 'BAD_DELEGATION'> {
  const vault = keyVault();
  if (!vault) return err('NO_VAULT' as const);
  const own = automation.find((entry) => entry.instanceId === vault.instanceId);
  if (!own || !isSealedBox(own.sealedKey)) {
    return err('BAD_DELEGATION' as const, {
      message: 'the automation delegation for this instance is missing',
    });
  }
  const opened = vault.open(own.sealedKey);
  if (!opened || opened.byteLength !== 32 || !opened.equals(expected)) {
    return err('BAD_DELEGATION' as const, {
      message: "the automation delegation does not open to this person's automation key",
    });
  }
  if (verifier && !verifierMatches(opened, verifier)) return err('BAD_DELEGATION' as const);
  return ok();
}

function clampAutomationUntil(until: Date | null): Date {
  const max = Date.now() + AUTOMATION_WINDOW_MAX_MS;
  if (!until || Number.isNaN(until.getTime()))
    return new Date(Date.now() + AUTOMATION_WINDOW_DEFAULT_MS);
  return new Date(Math.max(Date.now() + 60_000, Math.min(max, until.getTime())));
}

/**
 * The session the delegations are for must be THIS person's and live: a
 * session id that belongs to someone else, or to nobody, binds nothing.
 */
async function boundSession(
  trx: Kysely<DB> | Transaction<DB>,
  input: DelegationInput
): Promise<Result<{ expiresAt: Date }, 'SESSION_MISMATCH'>> {
  const session = await verifySession(trx, input.subject, input.sessionId);
  return session ? ok(session) : err('SESSION_MISMATCH' as const);
}

/**
 * Write the delegations the browser sealed: session rows for this browser
 * session (replacing its earlier ones), automation rows replacing the
 * person's earlier ones. Rows for an instance that is not registered are
 * dropped — the browser sealed to a stale list.
 */
async function writeDelegations(
  trx: Kysely<DB> | Transaction<DB>,
  input: DelegationInput,
  expiresAt: Date
): Promise<void> {
  const known = new Set(
    (await trx.selectFrom('delegate_instances').select('id').execute()).map((row) => row.id)
  );
  await trx
    .deleteFrom('key_delegations')
    .where('subject', '=', input.subject)
    .where('scope', '=', 'session')
    .where('session_id', '=', input.sessionId)
    .execute();
  const session = input.session.filter((entry) => known.has(entry.instanceId));
  if (session.length > 0) {
    await trx
      .insertInto('key_delegations')
      .values(
        session.map((entry) => ({
          subject: input.subject,
          instance_id: entry.instanceId,
          scope: 'session',
          session_id: input.sessionId,
          sealed_key: entry.sealedKey,
          expires_at: expiresAt,
        }))
      )
      .execute();
  }
  const automation = input.automation.filter((entry) => known.has(entry.instanceId));
  if (automation.length > 0) {
    await trx
      .deleteFrom('key_delegations')
      .where('subject', '=', input.subject)
      .where('scope', '=', 'automation')
      .execute();
    const until = clampAutomationUntil(input.automationUntil);
    await trx
      .insertInto('key_delegations')
      .values(
        automation.map((entry) => ({
          subject: input.subject,
          instance_id: entry.instanceId,
          scope: 'automation',
          session_id: null,
          sealed_key: entry.sealedKey,
          expires_at: until,
        }))
      )
      .execute();
  }
}

export interface EnrollmentView {
  version: number;
  enrolledAt: Date | null;
  /** How many wrappings and values moved off a pre-enrollment key; zero for a first-time person. */
  migrated: { grants: number; values: number };
}

/** First sign-in on a build with held keys; see the module comment. */
export async function enroll(
  db: Kysely<DB>,
  input: EnrollInput
): Promise<Result<EnrollmentView, EnrollError>> {
  return db.transaction().execute(async (trx): Promise<Result<EnrollmentView, EnrollError>> => {
    const existing = await trx
      .selectFrom('user_encryption_keys')
      .select(['salt', 'mode', 'version', 'verifier', 'sealed_kek', 'unlocked_until'])
      .where('subject', '=', input.subject)
      .forUpdate()
      .executeTakeFirst();
    if (existing && existing.mode === 'held') return err('ALREADY_ENROLLED' as const);
    const session = await boundSession(trx, input);
    if (!session.ok) return session;
    const keys = openOwnDelegation(input.session, {
      public_key: input.publicKey,
      wrapped_private_key: input.wrappedPrivateKey,
      wrapped_automation_key: input.wrappedAutomationKey,
    });
    if (!keys.ok) return keys;
    if (input.automation.length > 0) {
      const automation = checkOwnAutomation(input.automation, keys.val.automationKey, null);
      if (!automation.ok) return automation;
    }
    const version = (existing?.version ?? 0) + 1;
    let migrated = { grants: 0, values: 0 };
    if (existing) {
      const legacy = legacyKekOf(existing, await legacyKeyDomain(trx), input.subject, input.passphrase);
      if (!legacy.ok) return legacy;
      const moved = await moveSealedRows(
        trx,
        input.subject,
        { legacy: legacy.val },
        {
          ...keys.val,
          version,
        }
      );
      if (!moved.ok) return moved;
      migrated = moved.val;
    }
    const enrolledAt = new Date();
    await trx
      .insertInto('user_encryption_keys')
      .values({
        subject: input.subject,
        salt: existing?.salt ?? Buffer.alloc(32).toString('base64'),
        mode: 'held',
        version,
        public_key: input.publicKey,
        wrapped_private_key: input.wrappedPrivateKey,
        wrapped_automation_key: input.wrappedAutomationKey,
        enrolled_at: enrolledAt,
        // For a held row the verifier is of the AUTOMATION key: what a later
        // `delegate` checks an automation blob against (checkOwnAutomation).
        verifier: kekVerifier(keys.val.automationKey),
        sealed_kek: null,
        unlocked_until: null,
        rotated_at: existing ? enrolledAt : null,
      })
      .onConflict((oc) =>
        oc.columns(['subject']).doUpdateSet({
          mode: 'held',
          version,
          public_key: input.publicKey,
          wrapped_private_key: input.wrappedPrivateKey,
          wrapped_automation_key: input.wrappedAutomationKey,
          enrolled_at: enrolledAt,
          verifier: kekVerifier(keys.val.automationKey),
          sealed_kek: null,
          unlocked_until: null,
          rotated_at: enrolledAt,
        })
      )
      .execute();
    await writeDelegations(trx, input, session.val.expiresAt);
    return ok({ version, enrolledAt, migrated });
  });
}

/**
 * Fresh delegations from an enrolled person's browser. The session blob
 * sealed to this instance must open to the user key the wrappings are
 * under; the others are stored as sealed. Replacing the AUTOMATION rows
 * takes more than a session cookie: the same request must carry that valid
 * session blob, and the automation blob for this instance must open to the
 * automation key the ring says the person has (and the row's verifier of
 * it). An empty session list stores nothing and is refused unless the
 * caller says dropping this session's rows is the point.
 */
export async function storeDelegations(
  db: Kysely<DB>,
  input: DelegationInput
): Promise<Result<void, DelegateError>> {
  const vault = keyVault();
  if (!vault) return err('NO_VAULT' as const);
  const row = await readKeyRow(db, input.subject);
  if (!row) return err('NO_USER_KEY' as const);
  if (row.mode !== 'held') return err('NOT_ENROLLED' as const);
  if (input.session.length === 0 && !input.revokeSession) {
    return err('BAD_DELEGATION' as const, {
      message: "no session delegation; set revokeSession to drop this session's",
    });
  }
  const ownSession = input.session.find((entry) => entry.instanceId === vault.instanceId);
  let ring: KeyRing | null = null;
  if (ownSession) {
    const userKey = vault.open(ownSession.sealedKey);
    const made = userKey ? ringFromUserKey(input.subject, row, userKey) : null;
    if (!made || !made.ok) return err('BAD_DELEGATION' as const);
    ring = made.val;
  }
  if (input.automation.length > 0) {
    if (!ring) return err('NEEDS_SESSION' as const);
    const automation = checkOwnAutomation(input.automation, ring.automationKey, row.verifier);
    if (!automation.ok) return automation;
  }
  const session = await boundSession(db, input);
  if (!session.ok) return session;
  await writeDelegations(db, input, session.val.expiresAt);
  return ok();
}

/** Revoke every automation delegation: the person's agents pause until their next sign-in. */
export async function revokeAutomation(
  db: Kysely<DB>,
  subject: string
): Promise<number> {
  const result = await db
    .deleteFrom('key_delegations')
    .where('subject', '=', subject)
    .where('scope', '=', 'automation')
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

export interface RotateInput extends DelegationInput {
  wrappedPrivateKey: string;
  wrappedAutomationKey: string;
}

/**
 * A new user key, under the old one's session delegation: the browser
 * re-wrapped the private and automation keys under the new key and sealed
 * the new key to the instances. Everything under the old user key moves;
 * the automation key is unchanged, so what is under it stays.
 */
export async function rotateUserKey(
  db: Kysely<DB>,
  input: RotateInput
): Promise<Result<{ version: number; moved: number }, RotateError>> {
  const current = await getKeyRing(db, input.subject, 'session');
  if (!current.ok) return current;
  const ring = current.val;
  if (!ring.userKey) return err('NEEDS_SESSION' as const);
  const row = await readKeyRow(db, input.subject);
  if (!row) return err('NO_USER_KEY' as const);
  const next = openOwnDelegation(input.session, {
    public_key: row.public_key,
    wrapped_private_key: input.wrappedPrivateKey,
    wrapped_automation_key: input.wrappedAutomationKey,
  });
  if (!next.ok) return next.err.type === 'NO_VAULT' ? err('NO_VAULT' as const) : next;
  if (!next.val.automationKey.equals(ring.automationKey)) return err('KEY_MISMATCH' as const);
  if (input.automation.length > 0) {
    const automation = checkOwnAutomation(input.automation, ring.automationKey, row.verifier);
    if (!automation.ok) return automation;
  }
  const session = await boundSession(db, input);
  if (!session.ok) return session;
  return db
    .transaction()
    .execute(async (trx): Promise<Result<{ version: number; moved: number }, RotateError>> => {
      const version = row.version + 1;
      const moved = await moveSealedRows(
        trx,
        input.subject,
        { userKey: ring.userKey ?? Buffer.alloc(0), automationKey: ring.automationKey },
        { userKey: next.val.userKey, automationKey: next.val.automationKey, version }
      );
      if (!moved.ok) return moved;
      await trx
        .updateTable('user_encryption_keys')
        .set({
          version,
          wrapped_private_key: input.wrappedPrivateKey,
          wrapped_automation_key: input.wrappedAutomationKey,
          rotated_at: new Date(),
        })
        .where('subject', '=', input.subject)
        .execute();
      // Every other session's delegation carries the OLD key: gone, so those
      // browsers re-seal (from their own copy of the key, which they must
      // first replace through device approval or by typing the new key).
      await trx
        .deleteFrom('key_delegations')
        .where('subject', '=', input.subject)
        .execute();
      await writeDelegations(trx, input, session.val.expiresAt);
      return ok({ version, moved: moved.val.grants + moved.val.values });
    });
}

/**
 * Remove a person's key row: every delegation cascades, and every wrapping
 * made for them — including boxes sealed to their public key — is deleted,
 * so nothing stored for them can be opened by anyone, Renkei included.
 */
export async function shredUserKey(
  db: Kysely<DB>,
  subject: string
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom('resource_key_grants')
      .where('holder', '=', subject)
      .where('holder_kind', 'in', ['user', 'automation', 'public'])
      .execute();
    const result = await trx
      .deleteFrom('user_encryption_keys')
      .where('subject', '=', subject)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  });
}

/** How many people still carry a pre-enrollment row — the operator's signal for removing the master. */
export async function enrollmentCensus(
  db: Kysely<DB>
): Promise<{ held: number; managed: number; own: number }> {
  const rows = await db
    .selectFrom('user_encryption_keys')
    .select(['mode', (eb) => eb.fn.countAll<string>().as('count')])
    .groupBy('mode')
    .execute();
  const census = { held: 0, managed: 0, own: 0 };
  for (const row of rows) {
    if (row.mode === 'held') census.held = Number(row.count);
    else if (row.mode === 'own') census.own = Number(row.count);
    else census.managed = Number(row.count);
  }
  return census;
}
