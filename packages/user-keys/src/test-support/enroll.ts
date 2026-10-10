/**
 * The browser's half of enrollment, done in node for tests and seeding:
 * generate a person's user key, keypair and automation key, wrap the two
 * under the user key, seal the user key (session) and the automation key
 * (automation) to each live delegate instance, and hand the delegate the
 * result exactly as the page would. Also the vault a test registers so
 * the package has an instance to open delegations for.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  generateX25519KeyPair,
  sealToPublicKey,
  wrapKey,
  type X25519KeyPair,
} from '@renkei/crypto';
import { enroll, storeDelegations, type EnrollInput, type SealedDelegation } from '../enrollment';
import { createKeyVault, setKeyVault, type KeyVault } from '../vault';

export interface TestInstance {
  id: string;
  pair: X25519KeyPair;
  vault: KeyVault;
}

/** A delegate instance row plus the vault for it, registered as the process's. */
export async function registerTestInstance(db: Kysely<DB>): Promise<TestInstance> {
  const id = randomUUID();
  const pair = generateX25519KeyPair();
  await db
    .insertInto('delegate_instances')
    .values({ id, public_key: pair.publicKey.toString('base64') })
    .execute();
  const vault = createKeyVault(id, pair);
  setKeyVault(vault);
  return { id, pair, vault };
}

/** What the browser keeps: the user key and, for completeness, the other two. */
export interface BrowserKeys {
  userKey: Buffer;
  automationKey: Buffer;
  pair: X25519KeyPair;
}

export function generateBrowserKeys(): BrowserKeys {
  return {
    userKey: randomBytes(32),
    automationKey: randomBytes(32),
    pair: generateX25519KeyPair(),
  };
}

export interface SealTargets {
  instances: { id: string; publicKey: Buffer }[];
}

/** The delegations a browser seals for a sign-in. */
export function sealDelegations(
  keys: BrowserKeys,
  targets: SealTargets
): { session: SealedDelegation[]; automation: SealedDelegation[] } {
  return {
    session: targets.instances.map((instance) => ({
      instanceId: instance.id,
      sealedKey: sealToPublicKey(instance.publicKey, keys.userKey),
    })),
    automation: targets.instances.map((instance) => ({
      instanceId: instance.id,
      sealedKey: sealToPublicKey(instance.publicKey, keys.automationKey),
    })),
  };
}

export interface EnrollTestInput {
  subject: string;
  /** A sessions row is created when none is given. */
  sessionId?: string;
  instances: { id: string; publicKey: Buffer }[];
  passphrase?: string;
  automationUntil?: Date | null;
  /** Leave the automation delegation out (a person who revoked it). */
  withoutAutomation?: boolean;
}

export async function ensureSession(
  db: Kysely<DB>,
  subject: string,
  wanted?: string
): Promise<string> {
  const sessionId = wanted ?? randomUUID();
  await db
    .insertInto('sessions')
    .values({
      id: sessionId,
      subject,
      expires_at: new Date(Date.now() + 24 * 60 * 60_000),
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  return sessionId;
}

/** Enroll a person the way their browser would, returning what the browser keeps. */
export async function enrollTestPerson(
  db: Kysely<DB>,
  input: EnrollTestInput
): Promise<{ keys: BrowserKeys; sessionId: string }> {
  const keys = generateBrowserKeys();
  const sessionId = await ensureSession(db, input.subject, input.sessionId);
  const sealed = sealDelegations(keys, { instances: input.instances });
  const request: EnrollInput = {
    subject: input.subject,
    sessionId,
    publicKey: keys.pair.publicKey.toString('base64'),
    wrappedPrivateKey: wrapKey(keys.pair.privateKey, keys.userKey),
    wrappedAutomationKey: wrapKey(keys.automationKey, keys.userKey),
    session: sealed.session,
    automation: input.withoutAutomation ? [] : sealed.automation,
    automationUntil: input.automationUntil ?? null,
    passphrase: input.passphrase,
  };
  const enrolled = await enroll(db, request);
  if (!enrolled.ok) throw new Error(`enrollment failed: ${enrolled.err.type}`);
  return { keys, sessionId };
}

/** A later sign-in: fresh delegations for a new browser session. */
export async function delegateTestSession(
  db: Kysely<DB>,
  input: {
    subject: string;
    keys: BrowserKeys;
    instances: { id: string; publicKey: Buffer }[];
    sessionId?: string;
    automation?: boolean;
    automationUntil?: Date | null;
  }
): Promise<string> {
  const sessionId = await ensureSession(db, input.subject, input.sessionId);
  const sealed = sealDelegations(input.keys, { instances: input.instances });
  const stored = await storeDelegations(db, {
    subject: input.subject,
    sessionId,
    session: sealed.session,
    automation: input.automation === false ? [] : sealed.automation,
    automationUntil: input.automationUntil ?? null,
  });
  if (!stored.ok) throw new Error(`delegation failed: ${stored.err.type}`);
  return sessionId;
}
