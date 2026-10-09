/**
 * The org's act-approval policy on Settings → Agents: an operator picks
 * which agent runs pause a step that changes something, saves, and the
 * choice is what the store and the API show — refused outside the known
 * values when sent straight to the API. Runs in a tenant of its own: the setting
 * is org-wide, and the projects run side by side against one database.
 *
 * Mobile is a resized Chromium viewport, not the `mobile` project's device
 * descriptor (AGENTS.md, "UI changes").
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { enrollForE2E } from './keys';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };

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
    sessionId: uuidFrom(`approval-policy-e2e-session:${projectName}`),
    slug: `e2e-approval-policy-${projectName}`,
    subject: `e2e-approval-policy-${projectName}@example.com`,
  };
}
type Fixture = ReturnType<typeof fixtureFor>;

async function withDb<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function seed(fixture: Fixture): Promise<void> {
  await withDb(async (client) => {
    await client.query(`DELETE FROM settings WHERE key = 'agent_act_steps_require_approval'`);
    await client.query('DELETE FROM sessions WHERE subject = $1', [fixture.subject]);
    await client.query('DELETE FROM identities WHERE subject = $1', [fixture.subject]);
    await client.query(
      `INSERT INTO sessions (id, subject, roles, expires_at) VALUES ($1, $2, $3, $4)`,
      [fixture.sessionId, fixture.subject, ['renkei-user', 'renkei-operator'], new Date(Date.now() + 24 * 3_600_000)]
    );
    await client.query(
      `INSERT INTO identities (subject, email, display_name) VALUES ($1, $2, 'E2E Tester')`,
      [fixture.subject, fixture.subject]
    );
    await client.query(
      `INSERT INTO user_preferences (subject, key, value)\n       VALUES ($1, 'coach_marks', '{"autoStart": false}'::jsonb)\n       ON CONFLICT (subject, key) DO UPDATE SET value = EXCLUDED.value`,
      [fixture.subject]
    );
    // Enrolled already, so the first-sign-in "your encryption key is ready"
    // dialog does not sit over the settings this spec saves.
    await enrollForE2E(client, fixture.subject);
  });
}

async function signIn(page: Page, fixture: Fixture): Promise<void> {
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
    path: path.join(RESULTS, 'screens', testInfo.project.name, `approval-policy-${name}.png`),
    fullPage: true,
  });
}

test('act-step approval policy: default, change, save, API clamp', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const fixture = fixtureFor(testInfo.project.name);
  await seed(fixture);
  await signIn(page, fixture);
  const settingsUrl = `/admin/settings`;
  const select = page.getByLabel('agentActStepsRequireApproval');

  // ── The default: runs an event or webhook started ──
  await page.goto(settingsUrl);
  await expect(select).toBeVisible();
  await expect(select).toHaveValue('externally_triggered');
  await expect(page.getByText('Steps that change something need approval on')).toBeVisible();
  await select.scrollIntoViewIfNeeded();
  await shot(page, testInfo, '01-default');

  // ── Pick "every run" and save; the store and the API agree ──
  await select.selectOption('all');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  const stored = await withDb((client) =>
    client.query<{ value: string }>(
      `SELECT value FROM settings WHERE key = 'agent_act_steps_require_approval'`
    )
  );
  expect(stored.rows[0]?.value).toBe('all');
  const read = await page.request.get(`/api/admin/org-settings`);
  expect((await read.json()).settings.agentActStepsRequireApproval).toBe('all');
  await shot(page, testInfo, '02-saved-all');

  // The form adopts the server's answer, so what it shows is what was
  // stored. (A reload is not asserted: the page reads org settings through
  // their 60-second cache, which this spec deliberately does not wait out —
  // the sandbox-size-requests spec makes the same choice.)
  await expect(select).toHaveValue('all');

  // ── The API refuses a value outside the set, and takes a known one ──
  const refused = await page.request.put(`/api/admin/org-settings`, {
    data: { agentActStepsRequireApproval: 'sometimes' },
  });
  expect(refused.status()).toBe(400);
  const off = await page.request.put(`/api/admin/org-settings`, {
    data: { agentActStepsRequireApproval: 'off' },
  });
  expect((await off.json()).settings.agentActStepsRequireApproval).toBe('off');
  const readOff = await page.request.get(`/api/admin/org-settings`);
  expect((await readOff.json()).settings.agentActStepsRequireApproval).toBe('off');

  // ── Phone width: the row holds its layout ──
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(settingsUrl);
  await expect(select).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await select.scrollIntoViewIfNeeded();
  await shot(page, testInfo, '03-mobile');
});
