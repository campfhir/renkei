/**
 * The Sandbox section of admin → Settings: the six switches that replaced
 * the SANDBOX_*_ENABLED environment variables (migration 152). An
 * organization starts with every sandbox feature off, so the Code index
 * shows its notice; an operator turns code workspaces on, saves, and the
 * setting lands in the database, the API answers it, and the Code index
 * offers a new project. This spec writes data, so it gets its own tenant
 * per Playwright project (the llm-models.spec.ts pattern). Pinned
 * Chromium; mobile is a viewport resize.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { enrollForE2E } from './keys';

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
 * Two organizations: one left on the defaults (every sandbox feature off),
 * one seeded with code workspaces on. Each page's first read of an
 * organization's settings is what the assertion sees — the dev server
 * caches settings per route bundle for a minute, so a page is never asked
 * to notice a change made through another route (the approval-policy spec
 * makes the same choice); the save itself is checked in the store and
 * through the API.
 */
function fixtureFor(projectName: string, which: 'off' | 'on') {
  return {
    slug: `e2e-sandbox-${which}-${projectName}`,
    sessionId: uuidFrom(`sandbox-settings-e2e-session-${which}:${projectName}`),
    subject: `e2e-sandbox-${which}-${projectName}@example.com`,
    workspacesOn: which === 'on',
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
    const t = fixture.tenantId;
    for (const table of [
      'audit_events',
      'user_preferences',
      'settings',
      'sessions',
      'identities',
    ]) {
      await client.query(`DELETE FROM ${table}`, [t]);
    }
    await client.query('DELETE FROM tenants WHERE id = $1', [t]);
    await client.query(
      'INSERT INTO tenants (id, slug, domain_verified_at) VALUES ($1, $2, NOW())',
      [t, fixture.slug]
    );
    await client.query(
      `INSERT INTO sessions (id, tenant_id, subject, roles, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [
        fixture.sessionId,
        t,
        fixture.subject,
        ['renkei-user', 'renkei-operator'],
        new Date(Date.now() + 24 * 3_600_000),
      ]
    );
    await client.query(
      `INSERT INTO identities (tenant_id, subject, email, display_name) VALUES ($1, $2, $3, 'E2E Operator')`,
      [t, fixture.subject, fixture.subject]
    );
    await client.query(
      `INSERT INTO user_preferences (tenant_id, subject, key, value)
       VALUES ($1, $2, 'coach_marks', '{"autoStart": false}'::jsonb)`,
      [t, fixture.subject]
    );
    if (fixture.workspacesOn) {
      await client.query(
        `INSERT INTO settings (tenant_id, key, value)
         VALUES ($1, 'sandbox_workspaces_enabled', 'true'::jsonb)`,
        [t]
      );
    }
    // Enrolled already (docs/delegate-key-design.md), so the first-sign-in
    // "your encryption key is ready" dialog does not sit over the switches.
    await enrollForE2E(client, t, fixture.subject);
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

async function storedSetting(fixture: Fixture, key: string): Promise<unknown> {
  const stored = await withDb((client) =>
    client.query<{ value: unknown }>(
      `SELECT value FROM settings WHERE key = $2`,
      [fixture.tenantId, key]
    )
  );
  return stored.rows[0]?.value;
}

test('sandbox features are the organization’s own switches', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const off = fixtureFor(testInfo.project.name, 'off');
  const on = fixtureFor(testInfo.project.name, 'on');
  await seed(off);
  await seed(on);
  await signIn(page, off);
  await signIn(page, on);
  const notice = page.getByText('Code workspaces are not enabled for this organization');

  // ── Off by default: the Code index says so ──
  await page.goto(`/code`);
  await expect(notice).toBeVisible();

  // ── An organization with workspaces on gets the Code section proper ──
  await page.goto(`/code`);
  await expect(page.getByRole('heading', { name: 'Code' })).toBeVisible();
  await expect(notice).toHaveCount(0);

  // ── The switches, all off for the default organization ──
  const settingsUrl = `/admin/settings`;
  await page.goto(settingsUrl);
  const workspaces = page.getByRole('switch', { name: 'Code workspaces' });
  await expect(workspaces).toBeVisible();
  for (const name of [
    'Browser',
    'Charts',
    'Code workspaces',
    'Code project services',
    'Python scripts over staged files',
    "Allow scripts on the worker's network",
  ]) {
    await expect(page.getByRole('switch', { name })).toHaveAttribute('aria-checked', 'false');
  }
  await workspaces.scrollIntoViewIfNeeded();
  await shot(page, testInfo, '01-default');

  // ── Turn workspaces and charts on, save; the store and the API agree ──
  await workspaces.click();
  await page.getByRole('switch', { name: 'Charts' }).click();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  expect(await storedSetting(off, 'sandbox_workspaces_enabled')).toBe(true);
  expect(await storedSetting(off, 'sandbox_charts_enabled')).toBe(true);
  expect(await storedSetting(off, 'sandbox_browser_enabled')).toBeUndefined();
  const read = await page.request.get(`/api/admin/org-settings`);
  const settings = (await read.json()).settings;
  expect(settings.sandboxWorkspacesEnabled).toBe(true);
  expect(settings.sandboxChartsEnabled).toBe(true);
  expect(settings.sandboxBrowserEnabled).toBe(false);
  await shot(page, testInfo, '02-saved');

  // ── The API takes only booleans ──
  const refused = await page.request.put(`/api/admin/org-settings`, {
    data: { sandboxScriptsEnabled: 'yes' },
  });
  expect(refused.status()).toBe(400);

  // ── Phone width: the switches still sit on their rows, and the
  //    organization seeded with workspaces on shows it that way ──
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/admin/settings`);
  await expect(page.getByRole('switch', { name: 'Code workspaces' })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await expect(page.getByRole('switch', { name: 'Browser' })).toHaveAttribute(
    'aria-checked',
    'false'
  );
  await page.getByRole('switch', { name: 'Code workspaces' }).scrollIntoViewIfNeeded();
  await shot(page, testInfo, '03-mobile');
});
