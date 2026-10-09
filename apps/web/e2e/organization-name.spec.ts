/**
 * The organization's name (admin → Settings → Organization): what the
 * consent page and the sign-in flow call the deployment. An operator renames
 * it, saves, and the name lands in the store and the API; the spec puts the
 * default back, since the one organization's settings are shared with every
 * other spec in the run. The spec writes data, so it gets its own person per
 * Playwright project (the llm-models.spec.ts pattern). Pinned Chromium;
 * mobile is a viewport resize.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { enrollForE2E } from './keys';
import { deleteRowsOf } from './seed';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const DEFAULT_NAME = 'Renkei';

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
    sessionId: uuidFrom(`organization-name-e2e-session:${projectName}`),
    subject: `e2e-orgname-${projectName}@example.com`,
    name: `Acme Health (${projectName})`,
  };
}

type Fixture = ReturnType<typeof fixtureFor>;

async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function seed(fixture: Fixture): Promise<void> {
  await withDb(async (client) => {
    await deleteRowsOf(client, fixture.subject, [
      'audit_events',
      'user_preferences',
      'sessions',
      'identities',
    ]);
    await client.query(
      `INSERT INTO sessions (id, subject, roles, expires_at) VALUES ($1, $2, $3, $4)`,
      [fixture.sessionId, fixture.subject, ['renkei-user', 'renkei-operator'], new Date(Date.now() + 24 * 3_600_000)]
    );
    await client.query(
      `INSERT INTO identities (subject, email, display_name) VALUES ($1, $2, 'E2E Operator')`,
      [fixture.subject, fixture.subject]
    );
    await client.query(
      `INSERT INTO user_preferences (subject, key, value)
       VALUES ($1, 'coach_marks', '{"autoStart": false}'::jsonb)`,
      [fixture.subject]
    );
    await enrollForE2E(client, fixture.subject);
  });
}

async function signIn(page: Page, fixture: Fixture): Promise<void> {
  await page.context().addCookies([
    {
      name: 'renkei_session',
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
    path: path.join(RESULTS, 'screens', testInfo.project.name, `organization-name-${name}.png`),
    fullPage: true,
  });
}

async function storedName(): Promise<unknown> {
  const stored = await withDb((client) =>
    client.query<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'organization_name'`)
  );
  return stored.rows[0]?.value;
}

test('an operator names the organization', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const fixture = fixtureFor(testInfo.project.name);
  await seed(fixture);
  await signIn(page, fixture);

  await page.goto('/admin/settings');
  const field = page.getByRole('textbox', { name: 'Organization name' });
  await expect(field).toBeVisible();
  await field.scrollIntoViewIfNeeded();
  await shot(page, testInfo, '01-default');

  try {
    // ── Rename, save; the store and the API agree ──
    await field.fill(`  ${fixture.name}  `);
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    expect(await storedName()).toBe(fixture.name);
    const read = await page.request.get('/api/admin/org-settings');
    expect((await read.json()).settings.organizationName).toBe(fixture.name);
    await shot(page, testInfo, '02-saved');

    // ── The API takes a name, not a blank ──
    const refused = await page.request.put('/api/admin/org-settings', {
      data: { organizationName: '   ' },
    });
    expect(refused.status()).toBe(400);
    expect(await storedName()).toBe(fixture.name);

    // ── Phone width: the field still sits in its section. (The page reads
    //    settings through its own one-minute cache, so what it shows after a
    //    save through the API is not asserted — the store and the API were.) ──
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/admin/settings');
    const narrow = page.getByRole('textbox', { name: 'Organization name' });
    await expect(narrow).toBeVisible();
    await narrow.scrollIntoViewIfNeeded();
    await shot(page, testInfo, '03-mobile');
  } finally {
    // The default back for everyone else in the run.
    const restored = await page.request.put('/api/admin/org-settings', {
      data: { organizationName: DEFAULT_NAME },
    });
    expect(restored.ok()).toBe(true);
  }
  expect(await storedName()).toBe(DEFAULT_NAME);
});
