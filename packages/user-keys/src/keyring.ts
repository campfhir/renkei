/**
 * A person's keys as the delegate holds them for one request
 * (docs/delegate-key-design.md): nothing derived, everything opened from
 * a delegation the browser sealed to this instance.
 *
 *   session     — the USER KEY itself. Opens the person's wrappings, their
 *                 automation key and their private key: everything.
 *   automation  — the AUTOMATION KEY alone. Opens the wrappings made for
 *                 background work (connector credentials, provider tokens,
 *                 the chats agents write into) and nothing of the person's
 *                 conversation history, memory or shares.
 *
 * `getKeyRing` prefers a session delegation and falls back to an
 * automation one when the caller can work with it. A person who has not
 * enrolled yet (`managed` or `own` row from before) has no key here at
 * all: NOT_ENROLLED, until their next sign-in enrolls them.
 */

import { getDataStore } from '@renkei/db';
import { unwrapKey } from '@renkei/crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { keyRequestScope } from './request-scope';
import { keyVault } from './vault';

export type KeyScope = 'session' | 'automation';

export interface KeyRing {
  subject: string;
  /** `user_encryption_keys.version`: which key the wrappings are stamped with. */
  version: number;
  scope: KeyScope;
  /** Present for a session delegation only. */
  userKey: Buffer | null;
  automationKey: Buffer;
  publicKey: Buffer;
  /** The person's X25519 private key, for opening what was sealed to them; session scope only. */
  privateKey(): Buffer | null;
}

export type KeyError =
  /** The person has never had a key. */
  | 'NO_USER_KEY'
  /** The person has a pre-enrollment row and no held key yet. */
  | 'NOT_ENROLLED'
  /** Enrolled, but no delegation for this instance is live: the browser must re-seal. */
  | 'NEEDS_DELEGATION'
  /** Only an automation delegation is live and the operation needs the person present. */
  | 'NEEDS_SESSION'
  /** This process holds no instance keypair (misconfigured delegate). */
  | 'NO_VAULT'
  | 'DECRYPTION_ERROR';

/** How long after its last heartbeat an instance counts as alive for the browser to seal to. */
export const INSTANCE_LIVE_MS = 2 * 60_000;

export interface HeldRow {
  version: number;
  mode: string;
  public_key: string | null;
  wrapped_private_key: string | null;
  wrapped_automation_key: string | null;
  enrolled_at: Date | null;
  /** For a held row: a verifier of the automation key (enrollment.ts, checkOwnAutomation). */
  verifier: string | null;
}

export async function readKeyRow(subject: string): Promise<HeldRow | null> {
  const row = await getDataStore().userKeys.findKeyRow(subject);
  return row
    ? {
        version: row.version,
        mode: row.mode,
        public_key: row.publicKey,
        wrapped_private_key: row.wrappedPrivateKey,
        wrapped_automation_key: row.wrappedAutomationKey,
        enrolled_at: row.enrolledAt,
        verifier: row.verifier,
      }
    : null;
}

interface DelegationRow {
  scope: string;
  session_id: string | null;
  sealed_key: string;
}

async function liveDelegationsFor(subject: string, instanceId: string): Promise<DelegationRow[]> {
  const rows = await getDataStore().userKeys.liveDelegations(subject, instanceId, new Date());
  return rows.map((row) => ({
    scope: row.scope,
    session_id: row.sessionId,
    sealed_key: row.sealedKey,
  }));
}

/**
 * Which of a person's live delegations this request may open
 * (request-scope.ts): a caller other than the web app sees no session
 * row; a request bound to a session sees that session's row and no other
 * session's. Outside a request scope, every row.
 */
function usableDelegations(rows: DelegationRow[]): DelegationRow[] {
  const scope = keyRequestScope();
  if (!scope) return rows;
  return rows.filter((row) => {
    if (row.scope !== 'session') return true;
    if (!scope.allowSession) return false;
    return scope.sessionId === null || row.session_id === scope.sessionId;
  });
}

/** The ring a held row and an opened user key make. */
export function ringFromUserKey(
  subject: string,
  row: HeldRow,
  userKey: Buffer
): Result<KeyRing, 'DECRYPTION_ERROR'> {
  if (!row.wrapped_automation_key || !row.public_key) return err('DECRYPTION_ERROR' as const);
  const automation = unwrapKey(row.wrapped_automation_key, userKey);
  if (!automation.ok) return err('DECRYPTION_ERROR' as const);
  const wrappedPrivate = row.wrapped_private_key;
  let privateKey: Buffer | null | undefined;
  return ok({
    subject,
    version: row.version,
    scope: 'session',
    userKey,
    automationKey: automation.val,
    publicKey: Buffer.from(row.public_key, 'base64'),
    privateKey: () => {
      if (privateKey !== undefined) return privateKey;
      const opened = wrappedPrivate ? unwrapKey(wrappedPrivate, userKey) : null;
      privateKey = opened && opened.ok ? opened.val : null;
      return privateKey;
    },
  });
}

function ringFromAutomationKey(
  subject: string,
  row: HeldRow,
  automationKey: Buffer
): Result<KeyRing, 'DECRYPTION_ERROR'> {
  if (!row.public_key) return err('DECRYPTION_ERROR' as const);
  return ok({
    subject,
    version: row.version,
    scope: 'automation',
    userKey: null,
    automationKey,
    publicKey: Buffer.from(row.public_key, 'base64'),
    privateKey: () => null,
  });
}

/**
 * The person's keys for this request: from a session delegation when one
 * is live for this instance, else — when the caller accepts it — from an
 * automation delegation.
 */
export async function getKeyRing(
  subject: string,
  need: 'any' | 'session' = 'any'
): Promise<Result<KeyRing, KeyError>> {
  const vault = keyVault();
  if (!vault) return err('NO_VAULT' as const);
  const row = await readKeyRow(subject);
  if (!row) return err('NO_USER_KEY' as const);
  if (row.mode !== 'held') return err('NOT_ENROLLED' as const);
  const delegations = usableDelegations(await liveDelegationsFor(subject, vault.instanceId));
  let sawAutomation: Buffer | null = null;
  for (const delegation of delegations) {
    const opened = vault.open(delegation.sealed_key);
    if (!opened || opened.byteLength !== 32) continue;
    if (delegation.scope === 'session') {
      const ring = ringFromUserKey(subject, row, opened);
      if (ring.ok) return ring;
      continue;
    }
    sawAutomation ??= opened;
  }
  if (sawAutomation) {
    if (need === 'session') return err('NEEDS_SESSION' as const);
    return ringFromAutomationKey(subject, row, sawAutomation);
  }
  return err('NEEDS_DELEGATION' as const);
}

export interface LiveInstance {
  id: string;
  /** Raw X25519 public key, base64. */
  publicKey: string;
}

/** The delegate instances a browser should seal to right now. */
export async function liveInstances(): Promise<LiveInstance[]> {
  return getDataStore().userKeys.liveInstances(new Date(Date.now() - INSTANCE_LIVE_MS));
}

export interface DelegationStatus {
  /** Enrolled: the person holds their key; the delegate derives nothing for them. */
  enrolled: boolean;
  /** Pre-enrollment row present (managed or own): the next sign-in migrates it. */
  legacy: boolean;
  /** For an `own` row from before: enrollment needs the passphrase to move its rows. */
  legacyNeedsPassphrase: boolean;
  publicKey: string | null;
  wrappedPrivateKey: string | null;
  wrappedAutomationKey: string | null;
  version: number;
  enrolledAt: Date | null;
  /** Live instances holding a session delegation for this person (any session). */
  sessionInstances: string[];
  /** Live instances holding a session delegation for the session asked about. */
  thisSessionInstances: string[];
  /** Live instances holding an automation delegation, and when the latest expires. */
  automationInstances: string[];
  automationUntil: Date | null;
}

/** What is delegated for a person, across the live instances — for the browser and the agents worker. */
export async function delegationStatus(
  subject: string,
  sessionId?: string
): Promise<DelegationStatus> {
  const row = (await readKeyRow(subject)) ?? undefined;
  const live = new Set((await liveInstances()).map((instance) => instance.id));
  const delegations = (await getDataStore().userKeys.delegationsOf(subject, new Date())).map(
    (delegation) => ({
      instance_id: delegation.instanceId,
      scope: delegation.scope,
      session_id: delegation.sessionId,
      expires_at: delegation.expiresAt,
    })
  );
  const session = new Set<string>();
  const thisSession = new Set<string>();
  const automation = new Set<string>();
  let automationUntil: Date | null = null;
  for (const delegation of delegations) {
    if (!live.has(delegation.instance_id)) continue;
    if (delegation.scope === 'session') {
      session.add(delegation.instance_id);
      if (sessionId && delegation.session_id === sessionId) thisSession.add(delegation.instance_id);
    } else {
      automation.add(delegation.instance_id);
      if (!automationUntil || delegation.expires_at > automationUntil)
        automationUntil = delegation.expires_at;
    }
  }
  const enrolled = row?.mode === 'held';
  return {
    enrolled,
    legacy: row !== undefined && row.mode !== 'held',
    legacyNeedsPassphrase: row !== undefined && row.mode === 'own' && row.verifier !== null,
    publicKey: enrolled ? (row?.public_key ?? null) : null,
    wrappedPrivateKey: enrolled ? (row?.wrapped_private_key ?? null) : null,
    wrappedAutomationKey: enrolled ? (row?.wrapped_automation_key ?? null) : null,
    version: row?.version ?? 0,
    enrolledAt: row?.enrolled_at ?? null,
    sessionInstances: [...session],
    thisSessionInstances: [...thisSession],
    automationInstances: [...automation],
    automationUntil,
  };
}
