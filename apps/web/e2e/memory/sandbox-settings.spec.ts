/**
 * The Sandbox section of admin → Settings: the six switches that replaced
 * the SANDBOX_*_ENABLED environment variables (migration 152). The seeded
 * organization has them on (e2e/seed.ts); an operator turns charts off,
 * saves, and the setting lands in the database and the API answers it —
 * then the spec puts it back, since the one organization's settings are
 * shared with every other spec in the run. This spec writes data, so it
 * gets its own person per Playwright project (the llm-models.spec.ts
 * pattern). Pinned Chromium; mobile is a viewport resize.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { enrollForE2E } from './keys';
import { deleteRowsOf } from './seed';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');

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

/**
 * One operator per project. A page's first read of the settings is what
 * the assertion sees — the dev server caches settings per route bundle for
 * a minute, so a page is never asked to notice a change made through
 * another route (the approval-policy spec makes the same choice); the save
 * itself is checked in the store and through the API.
 */
function fixtureFor(projectName: string) {
  return {
    sessionId: uuidFrom(`sandbox-settings-e2e-session:${projectName}`),
    subject: `e2e-sandbox-${projectName}@example.com`,
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
      `INSERT INTO user_preferences (subject, key, value)\n       VALUES ($1, 'coach_marks', '{"autoStart": false}'::jsonb)`,
      [fixture.subject]
    );
    // Enrolled already (docs/delegate-key-design.md), so the first-sign-in
    // "your encryption key is ready" dialog does not sit over the switches.
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
    path: path.join(RESULTS, 'screens', testInfo.project.name, `sandbox-settings-${name}.png`),
    fullPage: true,
  });
}

async function storedSetting(key: string): Promise<unknown> {
  const stored = await withDb((client) =>
    client.query<{ value: unknown }>(
      `SELECT value FROM settings WHERE key = $1`,
      [key]
    )
  );
  return stored.rows[0]?.value;
}

test('sandbox features are the organization’s own switches', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const fixture = fixtureFor(testInfo.project.name);
  await seed(fixture);
  await signIn(page, fixture);

  // ── The seeded organization has every sandbox feature on, so the Code
  //    index offers the section proper ──
  await page.goto(`/code`);
  await expect(page.getByRole('heading', { name: 'Code' })).toBeVisible();
  await expect(
    page.getByText('Code workspaces are not enabled for this organization')
  ).toHaveCount(0);

  // ── The switches, as seeded ──
  const settingsUrl = `/admin/settings`;
  await page.goto(settingsUrl);
  const charts = page.getByRole('switch', { name: 'Charts' });
  await expect(charts).toBeVisible();
  for (const name of ['Browser', 'Charts', 'Code workspaces', 'Code project services']) {
    await expect(page.getByRole('switch', { name })).toHaveAttribute('aria-checked', 'true');
  }
  await charts.scrollIntoViewIfNeeded();
  await shot(page, testInfo, '01-seeded');

  // ── Turn charts off, save; the store and the API agree ──
  try {
    await charts.click();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    expect(await storedSetting('sandbox_charts_enabled')).toBe(false);
    expect(await storedSetting('sandbox_workspaces_enabled')).toBe(true);
    const read = await page.request.get(`/api/admin/org-settings`);
    const settings = (await read.json()).settings;
    expect(settings.sandboxChartsEnabled).toBe(false);
    expect(settings.sandboxWorkspacesEnabled).toBe(true);
    await shot(page, testInfo, '02-saved');

    // ── The API takes only booleans ──
    const refused = await page.request.put(`/api/admin/org-settings`, {
      data: { sandboxScriptsEnabled: 'yes' },
    });
    expect(refused.status()).toBe(400);

    // ── The service container ceilings: a setting too, in MB on the form ──
    const serviceMemory = page.getByRole('spinbutton', { name: 'sandboxServiceMemoryMb' });
    await expect(serviceMemory).toHaveValue('1024');
    await serviceMemory.fill('1536');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    expect(await storedSetting('sandbox_service_memory_bytes')).toBe(1536 * 1_048_576);
    const limits = (await (await page.request.get(`/api/admin/org-settings`)).json()).settings;
    expect(limits.sandboxServiceMemoryBytes).toBe(1536 * 1_048_576);
    expect(limits.sandboxServicePids).toBe(512);
    expect(limits.sandboxScriptMemoryBytes).toBe(2 * 1_073_741_824);
    await shot(page, testInfo, '03-service-memory');

    // ── Below what a container can run in is clamped to the floor, as every
    //    numeric setting is ──
    const tooSmall = await page.request.put(`/api/admin/org-settings`, {
      data: { sandboxServicePids: 1 },
    });
    expect(tooSmall.ok()).toBe(true);
    expect(await storedSetting('sandbox_service_pids')).toBe(16);
  } finally {
    // Back on, and back to the default ceilings, for everyone else in the run.
    const restored = await page.request.put(`/api/admin/org-settings`, {
      data: {
        sandboxChartsEnabled: true,
        sandboxServiceMemoryBytes: 1_073_741_824,
        sandboxServicePids: 512,
      },
    });
    expect(restored.ok()).toBe(true);
  }
  expect(await storedSetting('sandbox_charts_enabled')).toBe(true);
  expect(await storedSetting('sandbox_service_memory_bytes')).toBe(1_073_741_824);
  expect(await storedSetting('sandbox_service_pids')).toBe(512);

  // ── Phone width: the switches still sit on their rows ──
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(settingsUrl);
  await expect(page.getByRole('switch', { name: 'Code workspaces' })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await page.getByRole('switch', { name: 'Code workspaces' }).scrollIntoViewIfNeeded();
  await shot(page, testInfo, '04-mobile');
});
