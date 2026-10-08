/**
 * The sandbox worker's optional capabilities are org switches, not
 * environment flags: an operator turns the browser, charts, code
 * projects, services and scripts on under Organization → Settings →
 * Sandbox, the rows land in tenant_settings, and the Code section opens
 * for the org the moment code projects are on — with the sandbox stub
 * (e2e/sandbox-stub.mjs) standing in for the worker.
 *
 * Runs in a tenant of its own: the switches are org-wide, and flipping
 * code projects on in the shared `e2e` tenant would open the Code index
 * under another project's "it is off" assertion mid-run.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';

function idsFor(project: string, which: 'off' | 'on') {
  const hex = createHash('sha1').update(`sandbox-settings:${which}:${project}`).digest('hex');
  const uuid = (offset: number) =>
    `${hex.slice(offset, offset + 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return {
    tenantId: uuid(0),
    sessionId: uuid(4),
    slug: `e2e-sandbox-${which}-${project}`,
    subject: `e2e-sandbox-${which}-${project}@example.com`,
  };
}

/**
 * Two tenants, because an org's settings are read through a short cache
 * (the settings page says "within a minute") that the dev server's page
 * modules hold apart from the API route's: the `off` tenant proves the
 * form writes the rows, and the `on` tenant — seeded before any page of
 * it is read — proves the rows are what the pages go by.
 */
function tenantsFor(project: string) {
  return { off: idsFor(project, 'off'), on: idsFor(project, 'on') };
}

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
  // eslint-disable-next-line no-empty-pattern
  storageState: async ({}, use, testInfo) => {
    const tenants = tenantsFor(testInfo.project.name);
    await use({
      // Session cookies are named per tenant, so one jar signs into both.
      cookies: Object.values(tenants).map((ids) => ({
        name: `renkei_session_${ids.tenantId}`,
        value: ids.sessionId,
        domain: '127.0.0.1',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: 'Lax' as const,
      })),
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
let tenants: ReturnType<typeof tenantsFor>;

async function removeTenant(ids: ReturnType<typeof idsFor>): Promise<void> {
  await client.query('DELETE FROM tenant_settings WHERE tenant_id = $1', [ids.tenantId]);
  await client.query('DELETE FROM sessions WHERE tenant_id = $1', [ids.tenantId]);
  await client.query('DELETE FROM tenants WHERE id = $1', [ids.tenantId]);
}

async function createTenant(ids: ReturnType<typeof idsFor>): Promise<void> {
  await client.query('INSERT INTO tenants (id, slug) VALUES ($1, $2)', [ids.tenantId, ids.slug]);
  await client.query(
    `INSERT INTO sessions (id, tenant_id, subject, roles, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 day')`,
    [ids.sessionId, ids.tenantId, ids.subject, ['renkei-user', 'renkei-operator']]
  );
}

async function storedSwitches(ids: ReturnType<typeof idsFor>): Promise<Record<string, unknown>> {
  const rows = await client.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM tenant_settings WHERE tenant_id = $1 AND key LIKE 'sandbox_%_enabled' ORDER BY key`,
    [ids.tenantId]
  );
  return Object.fromEntries(rows.rows.map((row) => [row.key, row.value]));
}

// eslint-disable-next-line no-empty-pattern
test.beforeAll(async ({}, testInfo) => {
  tenants = tenantsFor(testInfo.project.name);
  client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  for (const ids of Object.values(tenants)) {
    await removeTenant(ids);
    await createTenant(ids);
  }
  // The `on` tenant's switches are rows, exactly what the form would write.
  for (const key of ['sandbox_browser_enabled', 'sandbox_workspaces_enabled']) {
    await client.query(
      `INSERT INTO tenant_settings (tenant_id, key, value) VALUES ($1, $2, 'true'::jsonb)`,
      [tenants.on.tenantId, key]
    );
  }
});

test.afterAll(async () => {
  for (const ids of Object.values(tenants)) await removeTenant(ids);
  await client.end();
});

const SWITCHES = [
  'Browser',
  'Charts',
  'Code projects',
  'Code project services',
  'Scripts over staged files',
];

test('the switches write the rows, and the rows open the Code section', async ({
  page,
}, testInfo) => {
  const { off, on } = tenants;

  // Off until an operator says otherwise: the Code index shows its notice.
  await page.goto(`/${off.slug}/code`);
  await expect(
    page.getByText('Code projects are not switched on for this organization')
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /New code project/ })).toHaveCount(0);

  // Every switch is there, and off.
  await page.goto(`/${off.slug}/admin/settings`);
  for (const name of SWITCHES) {
    await expect(page.getByRole('switch', { name })).toHaveAttribute('aria-checked', 'false');
  }
  expect(await storedSwitches(off)).toEqual({});

  // Turn two on and save.
  await page.getByRole('switch', { name: 'Browser' }).click();
  await page.getByRole('switch', { name: 'Code projects' }).click();
  await page.getByRole('switch', { name: 'Code projects' }).scrollIntoViewIfNeeded();
  await shot(page, testInfo, 'sandbox-settings-dirty');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  // The rows are the record, and the API answers from them.
  expect(await storedSwitches(off)).toEqual({
    sandbox_browser_enabled: true,
    sandbox_workspaces_enabled: true,
  });
  const answered = await page.request.get(`/api/admin/${off.slug}/org-settings`);
  expect(answered.ok()).toBe(true);
  const body: { settings?: Record<string, unknown> } = await answered.json();
  expect(body.settings?.sandboxBrowserEnabled).toBe(true);
  expect(body.settings?.sandboxWorkspacesEnabled).toBe(true);
  expect(body.settings?.sandboxChartsEnabled).toBe(false);

  // An org whose rows say so has the section open (what it says next is
  // that nobody here has connected a repository host yet — the step after
  // the switch) and the form reading on.
  await page.goto(`/${on.slug}/code`);
  await expect(
    page.getByText('Code projects are not switched on for this organization')
  ).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('A code project clones, pushes');
  await expect(page.getByRole('link', { name: 'Open Connectors' })).toBeVisible();
  await shot(page, testInfo, 'sandbox-settings-code-open');
  await page.goto(`/${on.slug}/admin/settings`);
  await expect(page.getByRole('switch', { name: 'Browser' })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await expect(page.getByRole('switch', { name: 'Code projects' })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await expect(page.getByRole('switch', { name: 'Charts' })).toHaveAttribute(
    'aria-checked',
    'false'
  );

  // Phone width: the switches still sit beside their labels.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const scripts = page.getByRole('switch', { name: 'Scripts over staged files' });
  await scripts.scrollIntoViewIfNeeded();
  await expect(scripts).toBeVisible();
  await shot(page, testInfo, 'sandbox-settings-mobile');
});
