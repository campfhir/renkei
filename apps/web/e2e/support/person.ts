/**
 * The memory suite's one helper: a signed-in, enrolled person of a spec's
 * own.
 *
 *   1. POST /api/test/session — the suite's only test-only route (OIDC
 *      cannot run in a test): a fresh identity and session, with the
 *      roles asked for.
 *   2. Enrollment the way the person's browser does it
 *      (docs/delegate-key-design.md), against the delegate the memory
 *      server runs in its own process (lib/memory-delegate.ts):
 *      GET /api/keys for the live instances, then POST /api/keys/enroll
 *      with a user key sealed to each instance for this session and an
 *      automation key for the automation window.
 *   3. PUT /api/preferences with the coach-mark tours off, so no tour
 *      steals focus mid-test.
 *
 * A subject nobody else has needs no cleanup: whatever the test makes
 * stays under it, and the server forgets everything when it stops.
 */

import { randomBytes } from 'node:crypto';
import type { APIRequestContext, BrowserContext } from '@playwright/test';
import { MEMORY_BASE_URL, MEMORY_SEED_TOKEN } from '../memory/constants';
import { sealToPublicKey, secretbox, x25519Pair } from './crypto';

export interface Person {
  subject: string;
  sessionId: string;
  displayName: string;
  roles: string[];
  /** `cookie: renkei_session=…`, for staging through the app's routes as this person. */
  headers: Record<string, string>;
}

export interface PersonOptions {
  /** Default: ['renkei-user']. */
  roles?: string[];
  displayName?: string;
  email?: string;
  /** Enroll the person's keys through the delegate. Default true. */
  enroll?: boolean;
  /** Leave the coach-mark tours on (they start by themselves). Default false: off. */
  coachMarks?: boolean;
}

async function expectOk(
  response: Awaited<ReturnType<APIRequestContext['get']>>,
  what: string
): Promise<unknown> {
  if (!response.ok()) {
    throw new Error(`${what} answered ${response.status()}: ${await response.text()}`);
  }
  return response.json();
}

async function liveInstances(
  request: APIRequestContext,
  headers: Record<string, string>
): Promise<{ id: string; publicKey: Buffer }[]> {
  const body = await expectOk(
    await request.get(`${MEMORY_BASE_URL}/api/keys`, { headers }),
    'GET /api/keys'
  );
  const listed =
    typeof body === 'object' &&
    body !== null &&
    'instances' in body &&
    Array.isArray(body.instances)
      ? body.instances
      : [];
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
  return instances;
}

/** Enroll the signed-in person as their browser would: keys made here, sealed to the delegate. */
async function enroll(request: APIRequestContext, headers: Record<string, string>): Promise<void> {
  const userKey = randomBytes(32);
  const automationKey = randomBytes(32);
  const { publicKey, privateKey } = x25519Pair();
  const instances = await liveInstances(request, headers);
  const sealedFor = (key: Buffer) =>
    instances.map((instance) => ({
      instanceId: instance.id,
      sealedKey: sealToPublicKey(instance.publicKey, key),
    }));
  await expectOk(
    await request.post(`${MEMORY_BASE_URL}/api/keys/enroll`, {
      headers,
      data: {
        publicKey: publicKey.toString('base64'),
        wrappedPrivateKey: secretbox(privateKey.toString('base64'), userKey),
        wrappedAutomationKey: secretbox(automationKey.toString('base64'), userKey),
        session: sealedFor(userKey),
        automation: sealedFor(automationKey),
        automationDays: 30,
      },
    }),
    'POST /api/keys/enroll'
  );
}

/** Sign a new person in, enroll them, and answer who they are. */
export async function createPerson(
  request: APIRequestContext,
  options: PersonOptions = {}
): Promise<Person> {
  const roles = options.roles ?? ['renkei-user'];
  const displayName = options.displayName ?? `Tester ${randomBytes(4).toString('hex')}`;
  const body = await expectOk(
    await request.post(`${MEMORY_BASE_URL}/api/test/session`, {
      headers: { 'x-renkei-seed-token': MEMORY_SEED_TOKEN },
      data: { roles, displayName, ...(options.email ? { email: options.email } : {}) },
    }),
    'POST /api/test/session'
  );
  const subject =
    typeof body === 'object' && body !== null && 'subject' in body ? body.subject : null;
  const sessionId =
    typeof body === 'object' && body !== null && 'sessionId' in body ? body.sessionId : null;
  if (typeof subject !== 'string' || typeof sessionId !== 'string') {
    throw new Error(`POST /api/test/session answered something else: ${JSON.stringify(body)}`);
  }
  const headers = { cookie: `renkei_session=${sessionId}` };

  if (options.enroll !== false) await enroll(request, headers);
  if (!options.coachMarks) {
    await expectOk(
      await request.put(`${MEMORY_BASE_URL}/api/preferences`, {
        headers,
        data: { coachMarks: { autoStart: false } },
      }),
      'PUT /api/preferences'
    );
  }
  return { subject, sessionId, displayName, roles, headers };
}

/** Put the person's session cookie in a browser context. */
export async function signIn(
  context: BrowserContext,
  person: Pick<Person, 'sessionId'>,
  domain = '127.0.0.1'
): Promise<void> {
  await context.addCookies([
    {
      name: 'renkei_session',
      value: person.sessionId,
      domain,
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
}
