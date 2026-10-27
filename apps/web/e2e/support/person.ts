/**
 * A signed-in person of a spec's own, written through the store methods
 * sign-in writes (sessions.create, identities.upsert) and enrolled through
 * the real delegate (./keys.ts) — what e2e/seed.ts's session and identity
 * rows plus e2e/keys.ts's `enrollForE2E` did with SQL.
 *
 * A subject nobody else uses needs no cleanup: rows the test makes stay
 * under it, and the server forgets everything when it stops. Forget one
 * explicitly with `forgetSubject` (./store.ts) where a spec must.
 */

import { randomUUID } from 'node:crypto';
import type { APIRequestContext, BrowserContext } from '@playwright/test';
import { enrollPerson, type PersonKeys } from './keys';
import { dataStore } from './store';

export interface Person {
  subject: string;
  sessionId: string;
  displayName: string;
  email: string;
  roles: string[];
  /** The keys the person's browser holds; null when created with `enroll: false`. */
  keys: PersonKeys | null;
}

export interface PersonOptions {
  /** Default: `e2e-<random>@example.test`. Make it unique per test and project. */
  subject?: string;
  /** Default: a random UUID. */
  sessionId?: string;
  displayName?: string;
  email?: string;
  /** Default: ['renkei-user']. */
  roles?: string[];
  /** Default: an hour from now. */
  expiresAt?: Date;
  /** Enroll the person's keys through the delegate. Default true. */
  enroll?: boolean;
  /** Give the person an automation delegation at enrollment. Default true. */
  automation?: boolean;
  /** Leave the coach-mark tours on (they start by themselves). Default false: off. */
  coachMarks?: boolean;
}

/** Write the person through the store, enroll them, and answer who they are. */
export async function createPerson(
  request: APIRequestContext,
  options: PersonOptions = {}
): Promise<Person> {
  const store = dataStore(request);
  const subject = options.subject ?? `e2e-${randomUUID().slice(0, 12)}@example.test`;
  const sessionId = options.sessionId ?? randomUUID();
  const roles = options.roles ?? ['renkei-user'];
  const displayName = options.displayName ?? `Tester ${subject.split('@')[0]}`;
  const email = options.email ?? subject;

  await store.identities.upsert({ subject, email, displayName, idpGroups: [] });
  await store.sessions.create({
    id: sessionId,
    subject,
    roles,
    expiresAt: options.expiresAt ?? new Date(Date.now() + 3_600_000),
  });
  if (!options.coachMarks) {
    // No tour stealing focus mid-test.
    await store.userPreferences.set(subject, 'coach_marks', { autoStart: false });
  }
  const keys =
    options.enroll === false
      ? null
      : await enrollPerson(request, { subject, sessionId, automation: options.automation });
  return { subject, sessionId, displayName, email, roles, keys };
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
