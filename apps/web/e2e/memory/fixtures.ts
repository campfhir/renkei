/**
 * The memory suite's one fixture: a signed-in person of the spec's own.
 *
 * Each test gets a subject and session nobody else has (derived from the
 * project and the test's id), seeded into the server's in-memory store
 * through app/api/test/data-store, and forgotten again afterwards — so
 * tests run in parallel, across projects, without racing on one another's
 * rows or "empty" states. `seed()` adds whatever else the test needs, as
 * table rows — the same columns e2e/seed.ts writes to Postgres
 * (`{ agent_notifications: [{ id, subject, kind, headline, … }] }`); the
 * memory tables fill defaults and refuse what Postgres would.
 *
 * The delegate is the one service the shell calls that the memory store
 * does not replace: /api/keys is answered here, at the browser edge, as
 * "enrolled, and this session already delegated" — the state in which the
 * KeyGuard has nothing to show.
 */

import { randomUUID } from 'node:crypto';
import { test as base, expect, type APIRequestContext } from '@playwright/test';
import type { MemorySeed } from '@renkei/db';
import { MEMORY_BASE_URL, MEMORY_SEED_TOKEN } from './constants';

export interface MemoryPerson {
  subject: string;
  sessionId: string;
  displayName: string;
  email: string;
  /** Add table rows to the store; ids and subjects are the caller's to choose. */
  seed(fixtures: MemorySeed): Promise<void>;
}

const SEED_URL = `${MEMORY_BASE_URL}/api/test/data-store`;
const SEED_HEADERS = { 'x-renkei-seed-token': MEMORY_SEED_TOKEN };

async function seedStore(request: APIRequestContext, fixtures: MemorySeed): Promise<void> {
  const response = await request.post(SEED_URL, { headers: SEED_HEADERS, data: fixtures });
  expect(response.status(), await response.text()).toBe(200);
}

/** The KeyGuard's quiet state; see components/key-guard.tsx. */
const QUIET_KEY_STATUS = {
  enrolled: true,
  legacy: false,
  legacyNeedsPassphrase: false,
  publicKey: null,
  wrappedPrivateKey: null,
  wrappedAutomationKey: null,
  version: 1,
  enrolledAt: '2026-01-01T00:00:00.000Z',
  instances: [],
  instanceSigningKey: null,
  instancesSignature: null,
  sessionDelegated: true,
  instancesMissingSession: [],
  automationInstances: [],
  automationUntil: null,
  automationDays: 30,
  pendingDevices: [],
  unavailable: false,
};

export const test = base.extend<{ person: MemoryPerson; roles: string[] }>({
  roles: [['renkei-user'], { option: true }],
  person: async ({ page, request, roles }, use, testInfo) => {
    const suffix = randomUUID().slice(0, 8);
    const subject = `memory-${testInfo.project.name}-${suffix}@example.test`;
    const sessionId = randomUUID();
    const displayName = `Memory Tester ${suffix}`;

    await seedStore(request, {
      sessions: [
        {
          id: sessionId,
          subject,
          roles,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ],
      identities: [{ subject, email: subject, display_name: displayName }],
      // No tour stealing focus mid-test.
      user_preferences: [{ subject, key: 'coach_marks', value: { autoStart: false } }],
    });

    await page.context().addCookies([
      {
        name: 'renkei_session',
        value: sessionId,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ]);
    await page.route('**/api/keys', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: QUIET_KEY_STATUS })
        : route.fulfill({ status: 204 })
    );

    await use({
      subject,
      sessionId,
      displayName,
      email: subject,
      seed: (fixtures) => seedStore(request, fixtures),
    });

    await request.delete(SEED_URL, { headers: SEED_HEADERS, data: { subject } });
  },
});

export { expect };
