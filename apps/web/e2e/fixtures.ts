/**
 * The browser suite's one fixture: a signed-in person of the test's own.
 *
 * Each test gets a fresh subject and session from the sign-in route,
 * ENROLLED through the delegate the memory server runs in-process
 * (e2e/support/person.ts), so the KeyGuard has nothing to show. The page's
 * context carries the person's cookie: stage what the test needs through
 * the routes the UI calls, with `page.request` —
 *
 *   await page.request.post('/api/agents', { data: { … } });
 *
 * Nobody else has the subject, so tests run in parallel, across projects,
 * without racing on one another's rows or "empty" states, and nothing
 * needs forgetting afterwards.
 */

import { test as base, expect } from '@playwright/test';
import { createPerson, signIn, type Person } from './support/person';

export type MemoryPerson = Person;

export const test = base.extend<{ person: MemoryPerson; roles: string[] }>({
  roles: [['renkei-user'], { option: true }],
  person: async ({ page, request, roles }, use, testInfo) => {
    const person = await createPerson(request, {
      displayName: `Memory Tester ${testInfo.project.name.replace('desktop-', '')}`,
      roles,
    });
    await signIn(page.context(), person);
    await use(person);
  },
});

export { expect };
