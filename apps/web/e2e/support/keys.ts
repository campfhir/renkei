/**
 * A person's held keys, enrolled the way their browser enrolls them
 * (docs/delegate-key-design.md), against the delegate the memory server
 * runs in its own process (lib/memory-delegate.ts):
 *
 *   1. GET /api/keys as the person — the live delegate instances;
 *   2. a user key, an X25519 keypair and an automation key, the private
 *      and automation keys wrapped under the user key;
 *   3. POST /api/keys/enroll with the user key sealed to every instance
 *      for this session and the automation key for the automation window —
 *      or, already enrolled, POST /api/keys/delegate for a further session.
 *
 * The delegate checks and records it exactly as it would a browser's. The
 * keys stay with the spec, so it can wrap a chat's key for the person
 * (`keyFor`) and seal their own values (`sealForSubject`) — what
 * e2e/keys.ts did with SQL, here through store calls.
 *
 * Keys are DERIVED from the subject, as e2e/keys.ts's are: Playwright's
 * workers are separate processes, and a fixture one worker enrolled must
 * open in another.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { MEMORY_BASE_URL } from '../memory/constants';
import { openSecretbox, sealToPublicKey, secretbox, x25519Pair } from './crypto';
import type { RemoteDataStore } from './store';

export interface PersonKeys {
  userKey: Buffer;
  automationKey: Buffer;
  publicKey: Buffer;
  privateKey: Buffer;
}

/** The same keys for the same subject in every process; test keys, never a product secret. */
export function keysOf(subject: string): PersonKeys {
  const derive = (purpose: string): Buffer =>
    createHash('sha256').update(`renkei-e2e/${purpose}/${subject}`).digest();
  return {
    userKey: derive('user-key'),
    automationKey: derive('automation-key'),
    ...x25519Pair(derive('private-key')),
  };
}

function cookieHeader(sessionId: string): Record<string, string> {
  return { cookie: `renkei_session=${sessionId}` };
}

async function liveInstances(
  request: APIRequestContext,
  sessionId: string
): Promise<{ enrolled: boolean; instances: { id: string; publicKey: Buffer }[] }> {
  const response = await request.get(`${MEMORY_BASE_URL}/api/keys`, {
    headers: cookieHeader(sessionId),
  });
  if (response.status() !== 200) {
    throw new Error(`GET /api/keys answered ${response.status()}: ${await response.text()}`);
  }
  const body: unknown = await response.json();
  const view = typeof body === 'object' && body !== null ? body : {};
  const enrolled = 'enrolled' in view && view.enrolled === true;
  const listed = 'instances' in view && Array.isArray(view.instances) ? view.instances : [];
  const instances: { id: string; publicKey: Buffer }[] = [];
  for (const item of listed) {
    if (typeof item !== 'object' || item === null) continue;
    const id = 'id' in item && typeof item.id === 'string' ? item.id : null;
    const key = 'publicKey' in item && typeof item.publicKey === 'string' ? item.publicKey : null;
    if (id && key) instances.push({ id, publicKey: Buffer.from(key, 'base64') });
  }
  if (instances.length === 0) {
    throw new Error('No delegate instance is alive: the memory server starts one at boot.');
  }
  return { enrolled, instances };
}

/**
 * Enroll the person signed in with `sessionId` (or, already enrolled,
 * delegate this session too), as their browser would. Returns their keys.
 */
export async function enrollPerson(
  request: APIRequestContext,
  input: { subject: string; sessionId: string; automation?: boolean }
): Promise<PersonKeys> {
  const keys = keysOf(input.subject);
  const { enrolled, instances } = await liveInstances(request, input.sessionId);
  const session = instances.map((instance) => ({
    instanceId: instance.id,
    sealedKey: sealToPublicKey(instance.publicKey, keys.userKey),
  }));
  const automation =
    input.automation === false
      ? []
      : instances.map((instance) => ({
          instanceId: instance.id,
          sealedKey: sealToPublicKey(instance.publicKey, keys.automationKey),
        }));
  const path = enrolled ? '/api/keys/delegate' : '/api/keys/enroll';
  const data = enrolled
    ? { session, automation, automationDays: 30 }
    : {
        publicKey: keys.publicKey.toString('base64'),
        wrappedPrivateKey: secretbox(keys.privateKey.toString('base64'), keys.userKey),
        wrappedAutomationKey: secretbox(keys.automationKey.toString('base64'), keys.userKey),
        session,
        automation,
        automationDays: 30,
      };
  const response = await request.post(`${MEMORY_BASE_URL}${path}`, {
    headers: cookieHeader(input.sessionId),
    data,
  });
  if (response.status() !== 200) {
    throw new Error(`POST ${path} answered ${response.status()}: ${await response.text()}`);
  }
  return keys;
}

export interface SeededKey {
  id: string;
  key: Buffer;
  /** The `renc2:<key id>:…` envelope every chat table carries. */
  seal(plaintext: string): string;
}

/**
 * A chat's, project's or artifact's data key, wrapped for its owner (a
 * `user` and an `automation` wrapping, as the delegate writes them) —
 * minted on the first call and reused after, so every row a spec seeds
 * for one resource lands under one key. The owner must be enrolled.
 */
export async function keyFor(
  store: RemoteDataStore,
  input: { kind: 'chat' | 'chat_project' | 'artifact'; resourceId: string; ownerSubject: string }
): Promise<SeededKey> {
  const keys = keysOf(input.ownerSubject);
  const existing = await store.resourceKeys.findWithWrapping(
    input.kind,
    input.resourceId,
    'user',
    input.ownerSubject
  );
  let id: string;
  let key: Buffer;
  if (existing?.wrappedKey) {
    id = existing.id;
    key = Buffer.from(openSecretbox(existing.wrappedKey, keys.userKey), 'base64');
  } else {
    if (existing) await store.resourceKeys.delete(input.kind, input.resourceId);
    const minted = await store.resourceKeys.insertIfAbsent(input.kind, input.resourceId);
    if (!minted) throw new Error(`a key for ${input.kind} ${input.resourceId} appeared meanwhile`);
    id = minted;
    key = randomBytes(32);
    for (const [holderKind, under] of [
      ['user', keys.userKey],
      ['automation', keys.automationKey],
    ] as const) {
      await store.resourceKeys.upsertWrapping({
        resourceKeyId: id,
        holderKind,
        holder: input.ownerSubject,
        wrappedKey: secretbox(key.toString('base64'), under),
        kekVersion: 1,
        grantedBy: null,
      });
    }
  }
  return { id, key, seal: (plaintext) => `renc2:${id}:${secretbox(plaintext, key)}` };
}

/** A person's own value, sealed under their automation key: `uenc1:…`. */
export function sealForSubject(subject: string, plaintext: string): string {
  return `uenc1:${secretbox(plaintext, keysOf(subject).automationKey)}`;
}
