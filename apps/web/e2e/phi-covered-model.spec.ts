/**
 * The "Require a BAA-covered model for PHI connectors" org switch, end to
 * end in a browser: where it lives on the settings page, that saving it
 * writes the org setting, and that a reload reads it back on. The
 * enforcement itself (a chat turn or an agent run refused on an uncovered
 * model) is unit-tested beside the gate in @renkei/agent-llm and the
 * agents worker; this spec covers the one piece only a browser exercises.
 *
 * Its own tenant per project (AGENTS.md: a spec that writes data does not
 * share e2e/seed.ts's), derived deterministically the way llm-models.spec.ts
 * does. Pinned Chromium; mobile is a resized viewport, not a device profile.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { enrollForE2E } from './keys';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const SWITCH = 'Require a BAA-covered model for PHI connectors';

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

function uuidFrom(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function fixtureFor(projectName: string) {
  return {
    sessionId: uuidFrom(`phi-covered-model-e2e-session:${projectName}`),
    slug: `e2e-phi-model-${projectName}`,
    subject: `e2e-phi-model-${projectName}@example.com`,
  };
}

async function seedTenant(fixture: ReturnType<typeof fixtureFor>): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(`DELETE FROM settings WHERE key = 'phi_connectors_require_covered_model'`);
    await client.query('DELETE FROM sessions WHERE subject = $1', [fixture.subject]);
    await client.query('DELETE FROM identities WHERE subject = $1', [fixture.subject]);
    await client.query(
      `INSERT INTO sessions (id, subject, roles, expires_at)\n       VALUES ($1, $2, $3, $4)`,
      [fixture.sessionId, fixture.subject, ['renkei-user', 'renkei-operator'], new Date(Date.now() + 24 * 3_600_000)]
    );
    await client.query(
      `INSERT INTO identities (subject, email, display_name)\n       VALUES ($1, $2, $3)`,
      [fixture.subject, fixture.subject, 'E2E Tester']
    );
    await client.query(
      `INSERT INTO user_preferences (subject, key, value)\n       VALUES ($1, 'coach_marks', '{"autoStart": false}'::jsonb)`,
      [fixture.subject]
    );
    // Enrolled like e2e/seed.ts's shared person, so the KeyGuard shows no dialog.
    await enrollForE2E(client, fixture.subject);
  } finally {
    await client.end();
  }
}

async function storedValue(): Promise<unknown> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query<{ value: unknown }>(
      `SELECT value FROM settings WHERE key = 'phi_connectors_require_covered_model'`
    );
    return result.rows[0]?.value;
  } finally {
    await client.end();
  }
}

async function signIn(page: Page, fixture: ReturnType<typeof fixtureFor>): Promise<void> {
  await page.context().addCookies([
    {
      name: `renkei_session`,
      value: fixture.sessionId,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

test('admin: the PHI covered-model switch saves and reads back', async ({ page }, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seedTenant(fixture);
  await signIn(page, fixture);

  await page.goto(`/admin/settings`);
  const toggle = page.getByRole('switch', { name: SWITCH });
  await expect(toggle).toBeVisible();
  // Off by default: an org without PHI connectors has nothing to gate.
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.scrollIntoViewIfNeeded();
  await shot(page, testInfo, 'phi-covered-model-01-off');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await shot(page, testInfo, 'phi-covered-model-02-saved');
  expect(await storedValue()).toBe(true);

  // What the gate reads: the org-settings route answers the saved value
  // (the settings page itself may show the old value for up to a minute —
  // @renkei/settings caches per process, and a dev server renders pages
  // and routes in separate ones).
  const readBack = await page.request.get(`/api/admin/org-settings`);
  expect(readBack.ok()).toBe(true);
  const body: { settings: { phiConnectorsRequireCoveredModel: boolean } } = await readBack.json();
  expect(body.settings.phiConnectorsRequireCoveredModel).toBe(true);

  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.getByRole('switch', { name: SWITCH }).scrollIntoViewIfNeeded();
  await shot(page, testInfo, 'phi-covered-model-03-mobile');
});
