/**
 * The memory suite's one fixture: a signed-in person of the test's own.
 *
 * Each test gets a subject and session nobody else has (derived from the
 * project and a random suffix), written through the store methods sign-in
 * writes and ENROLLED through the delegate the memory server runs
 * in-process (e2e/support/person.ts) — the KeyGuard then has nothing to
 * show, because the person really is enrolled and delegated. The person is
 * forgotten again afterwards, so tests run in parallel, across projects,
 * without racing on one another's rows or "empty" states.
 *
 * `person.store` is the data store as the app sees it (e2e/support/store.ts):
 * seed what the test needs with the methods the app writes it with —
 * `await person.store.notifications.insert({ … })`.
 */

import { randomUUID } from 'node:crypto';
import { test as base, expect } from '@playwright/test';
import { createPerson, signIn, type Person } from '../support/person';
import { dataStore, forgetSubject, type RemoteDataStore } from '../support/store';

export interface MemoryPerson extends Person {
  /** The server's data store, every method a promise. */
  store: RemoteDataStore;
}

export const test = base.extend<{ person: MemoryPerson; roles: string[] }>({
  roles: [['renkei-user'], { option: true }],
  person: async ({ page, request, roles }, use, testInfo) => {
    const suffix = randomUUID().slice(0, 8);
    const person = await createPerson(request, {
      subject: `memory-${testInfo.project.name}-${suffix}@example.test`,
      displayName: `Memory Tester ${suffix}`,
      roles,
    });
    await signIn(page.context(), person);

    await use({ ...person, store: dataStore(request) });

    await forgetSubject(request, person.subject);
  },
});

export { expect };
