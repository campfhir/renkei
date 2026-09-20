/**
 * The escape hatch: an operator switches the guided tours off for the
 * whole organization (Organization → Settings → Guided tours) and every
 * tour goes away at once — nothing starts unasked, a `?tour=` link does
 * nothing, the Tutorials door leaves the account menu, and the Tutorials
 * page says why.
 *
 * Runs in a tenant of its own. The switch is org-wide, and the three
 * projects work the shared `e2e` tenant side by side: flipping it there
 * would blank out another project's tour mid-step.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';

/**
 * A tenant per project: the three projects run side by side, and a tenant
 * one of them is deleting is no place for another to be signed in.
 */
function idsFor(project: string) {
  const hex = createHash('sha1').update(`coach-marks-off:${project}`).digest('hex');
  const uuid = (offset: number) =>
    `${hex.slice(offset, offset + 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return {
    tenantId: uuid(0),
    sessionId: uuid(4),
    slug: `e2e-tours-off-${project}`,
    subject: `e2e-tours-off-${project}@example.com`,
  };
}

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
  // eslint-disable-next-line no-empty-pattern
  storageState: async ({}, use, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    await use({
      cookies: [
        {
          name: `renkei_session_${ids.tenantId}`,
          value: ids.sessionId,
          domain: '127.0.0.1',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    });
  },
});

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      `${name}.png`
    ),
    fullPage: false,
  });
}

let client: Client;
let ids: ReturnType<typeof idsFor>;

async function removeTenant(): Promise<void> {
  // tenant_settings does not cascade from tenants; sessions does not either.
  await client.query('DELETE FROM tenant_settings WHERE tenant_id = $1', [ids.tenantId]);
  await client.query('DELETE FROM sessions WHERE tenant_id = $1', [ids.tenantId]);
  await client.query('DELETE FROM tenants WHERE id = $1', [ids.tenantId]);
}

// eslint-disable-next-line no-empty-pattern
test.beforeAll(async ({}, testInfo) => {
  ids = idsFor(testInfo.project.name);
  client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await removeTenant();
  await client.query('INSERT INTO tenants (id, slug) VALUES ($1, $2)', [ids.tenantId, ids.slug]);
  await client.query(
    `INSERT INTO tenant_settings (tenant_id, key, value) VALUES ($1, 'coach_marks_enabled', 'false'::jsonb)`,
    [ids.tenantId]
  );
  await client.query(
    `INSERT INTO sessions (id, tenant_id, subject, roles, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 day')`,
    [ids.sessionId, ids.tenantId, ids.subject, ['renkei-user', 'renkei-operator']]
  );
});

test.afterAll(async () => {
  await removeTenant();
  await client.end();
});

test('with the org switch off, no tour runs and the Tutorials door is closed', async ({
  page,
}, testInfo) => {
  // The welcome tour would greet a newcomer here; the switch says no.
  await page.goto(`/${ids.slug}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Actionable items' })).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(page.getByTestId('coach-mark')).toHaveCount(0);

  // Nor does a link that asks for one by name.
  await page.goto(`/${ids.slug}?tour=welcome`);
  await expect(page.getByRole('heading', { level: 1, name: 'Actionable items' })).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(page.getByTestId('coach-mark')).toHaveCount(0);

  await page.getByRole('button', { name: 'Account menu' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Preferences' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Tutorials' })).toHaveCount(0);
  await shot(page, testInfo, 'coach-off-account-menu');
  await page.keyboard.press('Escape');

  // The page itself still answers, and says why there is nothing to start.
  await page.goto(`/${ids.slug}/tutorials`);
  await expect(page.getByTestId('tutorials-off')).toBeVisible();
  await expect(page.getByRole('button', { name: /Start|Replay/ })).toHaveCount(0);
  await shot(page, testInfo, 'coach-off-tutorials');

  // Where the switch lives.
  await page.goto(`/${ids.slug}/admin/settings`);
  const toggle = page.getByRole('switch', { name: 'Guided tours' });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.scrollIntoViewIfNeeded();
  await shot(page, testInfo, 'coach-off-org-switch');
});
