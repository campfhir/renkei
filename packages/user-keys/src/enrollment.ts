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
 *
 * The transactions are the store's (userKeys.changeKeys): it locks the
 * person's row and what is sealed for them, this module decides and
 * re-seals in between, and the store writes the result in the same
 * transaction.
 */

import {
  getDataStore,
  type UserKeyChangePlan,
  type UserKeyDelegationWrite,
  type UserKeySealedRows,
  type UserKeySealedTable,
} from '@renkei/db';
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
 * Which of the person's keys each table sealed for them goes under once
 * they hold their own (the tables and their columns are the store's:
 * UserKeySealedTable). A change of key walks them all; so does
 * enrollment's move off a pre-enrollment key.
 */
const SCOPE_OF: Readonly<Record<UserKeySealedTable, 'automation' | 'session'>> = {
  provider_grants: 'automation',
  mirth_instance_connections: 'automation',
  admanager_instance_connections: 'automation',
  file_share_connections: 'automation',
  chat_user_memories: 'session',
};

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

type SealedRewrite = Extract<UserKeyChangePlan<unknown>, { commit: true }>['rewrite'];

/**
 * Everything sealed for the person, moved from `old` to `next`: computed
 * here, written by the store in the transaction that read (and locked)
 * it. A row that does not open under `old` aborts the whole change before
 * anything is written: a half-moved person is worse than one on the old
 * key. Wrappings: `user` ones move to the new user key; `automation` ones
 * (held rows only) to the new automation key — the same bytes when only
 * the user key rotated.
 */
function planMove(
  sealed: UserKeySealedRows,
  old: { userKey: Buffer; automationKey: Buffer } | { legacy: Buffer },
  next: { userKey: Buffer; automationKey: Buffer; version: number }
): Result<{ rewrite: SealedRewrite; grants: number; values: number }, 'DECRYPTION_ERROR'> {
  const rewrite: SealedRewrite = { wrappings: [], values: [] };
  for (const grant of sealed.wrappings) {
    const oldKey =
      'legacy' in old
        ? old.legacy
        : grant.holderKind === 'automation'
          ? old.automationKey
          : old.userKey;
    const key = unwrapKey(grant.wrappedKey, oldKey);
    if (!key.ok) return err('DECRYPTION_ERROR' as const, { message: 'a resource key wrapping' });
    const nextKey = grant.holderKind === 'automation' ? next.automationKey : next.userKey;
    rewrite.wrappings.push({
      resourceKeyId: grant.resourceKeyId,
      holderKind: grant.holderKind,
      wrappedKey: wrapKey(key.val, nextKey),
      kekVersion: next.version,
    });
  }
  for (const row of sealed.values) {
    const values: Record<string, string> = {};
    for (const [column, stored] of Object.entries(row.values)) {
      if (typeof stored !== 'string') continue;
      if (!stored.startsWith(USER_ENVELOPE_PREFIX) && !stored.startsWith(PRIVATE_ENVELOPE_PREFIX))
        continue;
      const opened = openUnderOld(stored, old);
      if (opened === null) {
        return err('DECRYPTION_ERROR' as const, { message: `${row.table}.${column}` });
      }
      values[column] = resealed(opened, SCOPE_OF[row.table], next);
    }
    if (Object.keys(values).length === 0) continue;
    rewrite.values.push({ table: row.table, id: row.id, values });
  }
  return ok({ rewrite, grants: sealed.wrappings.length, values: rewrite.values.length });
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
  input: DelegationInput
): Promise<Result<{ expiresAt: Date }, 'SESSION_MISMATCH'>> {
  const session = await verifySession(input.subject, input.sessionId);
  return session ? ok(session) : err('SESSION_MISMATCH' as const);
}

/**
 * The delegations the browser sealed, as the store writes them: session
 * rows for this browser session (replacing its earlier ones), automation
 * rows replacing the person's earlier ones. Rows for an instance that is
 * not registered are dropped there — the browser sealed to a stale list.
 */
function delegationWrite(input: DelegationInput, expiresAt: Date): UserKeyDelegationWrite {
  return {
    sessionId: input.sessionId,
    session: input.session,
    sessionExpiresAt: expiresAt,
    automation: input.automation,
    automationExpiresAt: clampAutomationUntil(input.automationUntil),
  };
}

export interface EnrollmentView {
  version: number;
  enrolledAt: Date | null;
  /** How many wrappings and values moved off a pre-enrollment key; zero for a first-time person. */
  migrated: { grants: number; values: number };
}

type EnrollResult = Result<EnrollmentView, EnrollError>;

/** First sign-in on a build with held keys; see the module comment. */
export async function enroll(input: EnrollInput): Promise<EnrollResult> {
  // Both read outside the store's transaction: the session row and an
  // org setting, neither of which the transaction changes.
  const session = await boundSession(input);
  const domain = await legacyKeyDomain();
  const refuse = (answer: EnrollResult): UserKeyChangePlan<EnrollResult> => ({
    commit: false,
    answer,
  });
  return getDataStore().userKeys.changeKeys<EnrollResult>(
    input.subject,
    async (existing, readSealed) => {
      if (existing && existing.mode === 'held') return refuse(err('ALREADY_ENROLLED' as const));
      if (!session.ok) return refuse(session);
      const keys = openOwnDelegation(input.session, {
        public_key: input.publicKey,
        wrapped_private_key: input.wrappedPrivateKey,
        wrapped_automation_key: input.wrappedAutomationKey,
      });
      if (!keys.ok) return refuse(keys);
      if (input.automation.length > 0) {
        const automation = checkOwnAutomation(input.automation, keys.val.automationKey, null);
        if (!automation.ok) return refuse(automation);
      }
      const version = (existing?.version ?? 0) + 1;
      let migrated = { grants: 0, values: 0 };
      let rewrite: SealedRewrite = { wrappings: [], values: [] };
      if (existing) {
        const legacy = legacyKekOf(
          {
            salt: existing.salt,
            mode: existing.mode,
            version: existing.version,
            verifier: existing.verifier,
            sealed_kek: existing.sealedKek,
            unlocked_until: existing.unlockedUntil,
          },
          domain,
          input.subject,
          input.passphrase
        );
        if (!legacy.ok) return refuse(legacy);
        const moved = planMove(
          await readSealed(),
          { legacy: legacy.val },
          { ...keys.val, version }
        );
        if (!moved.ok) return refuse(moved);
        rewrite = moved.val.rewrite;
        migrated = { grants: moved.val.grants, values: moved.val.values };
      }
      const enrolledAt = new Date();
      return {
        commit: true,
        answer: ok({ version, enrolledAt, migrated }),
        rewrite,
        keyRow: {
          kind: 'enroll',
          salt: existing?.salt ?? Buffer.alloc(32).toString('base64'),
          version,
          publicKey: input.publicKey,
          wrappedPrivateKey: input.wrappedPrivateKey,
          wrappedAutomationKey: input.wrappedAutomationKey,
          enrolledAt,
          // For a held row the verifier is of the AUTOMATION key: what a later
          // `delegate` checks an automation blob against (checkOwnAutomation).
          verifier: kekVerifier(keys.val.automationKey),
          rotatedAt: existing ? enrolledAt : null,
        },
        dropDelegations: false,
        delegations: delegationWrite(input, session.val.expiresAt),
      };
    }
  );
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
  input: DelegationInput
): Promise<Result<void, DelegateError>> {
  const vault = keyVault();
  if (!vault) return err('NO_VAULT' as const);
  const row = await readKeyRow(input.subject);
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
  const session = await boundSession(input);
  if (!session.ok) return session;
  await getDataStore().userKeys.writeDelegations(
    input.subject,
    delegationWrite(input, session.val.expiresAt)
  );
  return ok();
}

/** Revoke every automation delegation: the person's agents pause until their next sign-in. */
export async function revokeAutomation(subject: string): Promise<number> {
  return getDataStore().userKeys.revokeAutomation(subject);
}

export interface RotateInput extends DelegationInput {
  wrappedPrivateKey: string;
  wrappedAutomationKey: string;
}

type RotateResult = Result<{ version: number; moved: number }, RotateError>;

/**
 * A new user key, under the old one's session delegation: the browser
 * re-wrapped the private and automation keys under the new key and sealed
 * the new key to the instances. Everything under the old user key moves;
 * the automation key is unchanged, so what is under it stays.
 */
export async function rotateUserKey(input: RotateInput): Promise<RotateResult> {
  const current = await getKeyRing(input.subject, 'session');
  if (!current.ok) return current;
  const ring = current.val;
  if (!ring.userKey) return err('NEEDS_SESSION' as const);
  const oldUserKey = ring.userKey;
  const row = await readKeyRow(input.subject);
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
  const session = await boundSession(input);
  if (!session.ok) return session;
  const version = row.version + 1;
  return getDataStore().userKeys.changeKeys<RotateResult>(
    input.subject,
    async (_existing, readSealed) => {
      const moved = planMove(
        await readSealed(),
        { userKey: oldUserKey, automationKey: ring.automationKey },
        { userKey: next.val.userKey, automationKey: next.val.automationKey, version }
      );
      if (!moved.ok) return { commit: false, answer: moved };
      return {
        commit: true,
        answer: ok({ version, moved: moved.val.grants + moved.val.values }),
        rewrite: moved.val.rewrite,
        keyRow: {
          kind: 'rotate',
          version,
          wrappedPrivateKey: input.wrappedPrivateKey,
          wrappedAutomationKey: input.wrappedAutomationKey,
          rotatedAt: new Date(),
        },
        // Every other session's delegation carries the OLD key: gone, so those
        // browsers re-seal (from their own copy of the key, which they must
        // first replace through device approval or by typing the new key).
        dropDelegations: true,
        delegations: delegationWrite(input, session.val.expiresAt),
      };
    }
  );
}

/**
 * Remove a person's key row: every delegation cascades, and every wrapping
 * made for them — including boxes sealed to their public key — is deleted,
 * so nothing stored for them can be opened by anyone, Renkei included.
 */
export async function shredUserKey(subject: string): Promise<boolean> {
  return getDataStore().userKeys.shred(subject);
}

/** How many people still carry a pre-enrollment row — the operator's signal for removing the master. */
export async function enrollmentCensus(): Promise<{ held: number; managed: number; own: number }> {
  const rows = await getDataStore().userKeys.countByMode();
  const census = { held: 0, managed: 0, own: 0 };
  for (const row of rows) {
    if (row.mode === 'held') census.held = row.count;
    else if (row.mode === 'own') census.own = row.count;
    else census.managed = row.count;
  }
  return census;
}
