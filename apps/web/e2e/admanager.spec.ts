/**
 * The ADManager Plus connector, end to end in a browser: the admin's
 * instance registry (empty state, create, a reachability test, manage/
 * edit, delete, the transport-security guard) and the user's connect
 * flow on the connectors page (the fail-closed message when the service
 * isn't wired up).
 *
 * The memory server runs no apps/worker-admanager and sets neither
 * ADMANAGER_WORKER_URL nor ADMANAGER_WORKER_API_KEY — so
 * `admanagerWorkerConfigured()` is really false here, the same as a
 * deployment that hasn't stood the worker up yet. The "test
 * reachability" and "connect with an authtoken" flows are exercised
 * against that REAL, unmocked "service not configured" answer (see
 * docs/admanager-connector-design.md: "a missing pair means every
 * operation answers 'unconfigured' — never open").
 *
 * An already-connected card (the permission grid and Disconnect) is not
 * reachable here: the only route that writes a connection validates the
 * authtoken against the worker first, and with no worker it refuses —
 * which is the last step below.
 *
 * Instances are organization-wide, and every project shares the server:
 * each test names its instance with its own tag, scopes what it reads to
 * that row, and deletes it through the registry's own DELETE route. The
 * empty state is the list route answered empty at the browser edge.
 *
 * Pinned Chromium; "mobile" is a resized viewport.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { addConnectors } from './support/connectors';
import { test, expect as baseExpect } from './fixtures';

// Forms here load, save and reload through the dev server: room for a busy machine.
const expect = baseExpect.configure({ timeout: 15_000 });

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const UNCONFIGURED_MESSAGE = 'The ADManager Plus service is not configured on this deployment';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

let tag = '';
// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, testInfo) => {
  tag = `${testInfo.project.name.replace('desktop-', '')}-${randomUUID().slice(0, 6)}`;
});

// What the test registered goes again, through the registry's own route.
test.afterEach(async ({ page, person: _person }) => {
  const listed: { instances: { id: string; name: string }[] } = await (
    await page.request.get('/api/admin/admanager')
  ).json();
  for (const instance of listed.instances.filter((row) => row.name.endsWith(` ${tag}`))) {
    expect((await page.request.delete(`/api/admin/admanager/${instance.id}`)).ok()).toBe(true);
  }
});

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

/** The registry's list, answered empty at the browser edge (the real one is everybody's). */
async function openEmptyRegistry(page: Page): Promise<void> {
  await page.route('**/api/admin/admanager', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { instances: [] } })
      : route.fallback()
  );
  await page.goto(`/admin/admanager`);
  await expect(page.getByRole('heading', { name: 'ADManager Plus', exact: true })).toBeVisible();
  await expect(page.getByText('No instances registered yet.')).toBeVisible();
  // Both of the dev server's mount loads answered before the real list is back.
  await page.waitForLoadState('networkidle');
  await page.unroute('**/api/admin/admanager');
}

function instanceRow(page: Page, name: string) {
  return page.getByRole('listitem').filter({ hasText: name });
}

test('admin: ADManager Plus instance registry — create, reachability, edit, delete', async ({
  page,
  person: _person,
}, testInfo) => {
  const name = `ADManager Plus prod ${tag}`;
  await openEmptyRegistry(page);
  await shot(page, testInfo, 'admanager-admin-01-empty');

  await page.getByRole('button', { name: '+ New instance' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Environment').fill('prod');
  await page.getByLabel('Server URL').fill('https://admp.example.com:8080');
  // The reset-password template is an instance setting (the REST API
  // cannot set "must change password at next logon" itself, so the tools
  // apply this template after a reset — see the design doc).
  await page
    .getByLabel('Reset-password template (optional)')
    .fill('Reset Password – must change at next logon');
  await shot(page, testInfo, 'admanager-admin-02-draft-filled');

  // No worker is configured here (see the file header) — the real,
  // unmocked answer is "not configured", the fail-closed behavior.
  await page.getByRole('button', { name: 'Test reachability' }).click();
  await expect(page.getByText(UNCONFIGURED_MESSAGE)).toBeVisible();
  await shot(page, testInfo, 'admanager-admin-03-unconfigured');

  // The instance registry CRUD itself calls no worker — the real create route.
  await page.getByRole('button', { name: 'Create instance' }).click();
  await expect(instanceRow(page, name)).toBeVisible();
  await shot(page, testInfo, 'admanager-admin-04-created');

  await instanceRow(page, name).getByRole('link', { name: 'Manage', exact: true }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByLabel('Server URL')).toHaveValue('https://admp.example.com:8080');
  // The template survived create → stored settings JSON → GET.
  await expect(page.getByLabel('Reset-password template (optional)')).toHaveValue(
    'Reset Password – must change at next logon'
  );

  // Edit and save through the real PATCH route — the template changes too.
  // The dev server mounts the form's load effect twice, and the second load
  // can land after a fill and put the stored values back; so the edit is
  // made again until the instance's own route reads it back saved.
  const instanceId = new URL(page.url()).pathname.split('/').pop() ?? '';
  const stored = async (): Promise<{
    environment: string;
    resetPasswordTemplateName?: string | null;
  }> => {
    const read: {
      instance: { environment: string; resetPasswordTemplateName?: string | null };
    } = await (await page.request.get(`/api/admin/admanager/${instanceId}`)).json();
    return read.instance;
  };
  await expect(async () => {
    await page.getByLabel('Environment').fill('staging');
    await page.getByLabel('Reset-password template (optional)').fill('Helpdesk Reset Template');
    await baseExpect(page.getByLabel('Environment')).toHaveValue('staging');
    await page.getByRole('button', { name: 'Save' }).click();
    await baseExpect(page.getByText('Saved.')).toBeVisible();
    baseExpect((await stored()).environment).toBe('staging');
  }).toPass({ timeout: 60_000 });
  await shot(page, testInfo, 'admanager-admin-05-edited');

  // A reload re-reads it from the store: the new template merged in.
  await page.reload();
  await expect(page.getByLabel('Environment')).toHaveValue('staging', { timeout: 30_000 });
  await expect(page.getByLabel('Reset-password template (optional)')).toHaveValue(
    'Helpdesk Reset Template'
  );

  // Clearing the field clears the stored template (blank → null → key removed).
  // (Again until it reads back saved: the reload mounted the form anew.)
  await expect(async () => {
    await page.getByLabel('Reset-password template (optional)').fill('');
    await baseExpect(page.getByLabel('Reset-password template (optional)')).toHaveValue('');
    await page.getByRole('button', { name: 'Save' }).click();
    await baseExpect(page.getByText('Saved.')).toBeVisible();
    baseExpect((await stored()).resetPasswordTemplateName ?? null).toBeNull();
  }).toPass({ timeout: 60_000 });
  await page.reload();
  await expect(page.getByLabel('Reset-password template (optional)')).toHaveValue('', {
    timeout: 30_000,
  });

  // Mobile: a resized Chromium viewport, not a device descriptor.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(page.getByRole('button', { name: 'Delete instance' })).toBeVisible();
  await shot(page, testInfo, 'admanager-admin-06-mobile-detail');

  // Delete, through the real DELETE route, back to the list without it.
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Delete instance' }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/admanager$`));
  await expect(page.getByRole('heading', { name: 'ADManager Plus', exact: true })).toBeVisible();
  await expect(instanceRow(page, name)).toHaveCount(0);
});

test('admin: transport security off is refused for production or a public host, allowed for a private lab host, and shown as a banner', async ({
  page,
  person: _person,
}, testInfo) => {
  const name = `ADManager Plus lab ${tag}`;
  await openEmptyRegistry(page);
  await page.getByRole('button', { name: '+ New instance' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Server URL').fill('http://127.0.0.1:8080');
  await page.getByLabel(/Allow insecure HTTP/).check();

  // The default label is "prod": a production instance never gets plaintext.
  await page.getByRole('button', { name: 'Create instance' }).click();
  await expect(page.getByText(/production instance must use https/)).toBeVisible();
  await shot(page, testInfo, 'admanager-insecure-01-production-refused');

  // A lab label, but a public host: refused too — the real route resolves
  // the name, so a public IP literal is the deterministic stand-in here.
  await page.getByLabel('Environment').fill('lab');
  await page.getByLabel('Server URL').fill('http://203.0.113.9:8080');
  await page.getByRole('button', { name: 'Create instance' }).click();
  await expect(page.getByText(/only allowed for a host on a private network/)).toBeVisible();

  // A lab label on a loopback host is what the exception is for.
  await page.getByLabel('Server URL').fill('http://127.0.0.1:8080');
  await page.getByRole('button', { name: 'Create instance' }).click();
  await expect(instanceRow(page, name)).toBeVisible();

  // The instance page carries the warning for as long as the setting is on.
  await instanceRow(page, name).getByRole('link', { name: 'Manage', exact: true }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const banner = page.getByTestId('insecure-transport-banner');
  await expect(banner).toContainText('Transport security is off');
  await expect(banner).toContainText('plaintext HTTP allowed');
  await shot(page, testInfo, 'admanager-insecure-02-banner');
  await page.waitForLoadState('networkidle');

  // Relabelling it production while insecure is refused by the real PATCH route.
  await page.getByLabel('Environment').fill('prod');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/production instance must use https/)).toBeVisible();

  // Turning the protection back on clears the banner.
  await page.getByLabel('Environment').fill('lab');
  await page.getByLabel('Server URL').fill('https://127.0.0.1:8443');
  await page.getByLabel(/Allow insecure HTTP/).uncheck();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await expect(banner).toHaveCount(0);

  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
  await shot(page, testInfo, 'admanager-insecure-03-mobile');
});

test('user: an ADManager Plus card offers the instance, and connecting fails closed without the service', async ({
  page,
  person: _person,
}, testInfo) => {
  const name = `ADManager Plus prod ${tag}`;
  // The instance, registered the way the admin form does.
  const created = await page.request.post('/api/admin/admanager', {
    data: {
      name,
      environment: 'prod',
      baseUrl: 'https://admp.example.com:8080',
      tlsVerify: true,
      allowInsecureHttp: false,
      resetPasswordTemplateName: null,
      enabled: true,
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  await addConnectors(page.request, ['admanager']);

  await page.goto(`/connectors`);
  await expect(page.getByRole('heading', { name: 'Connectors' })).toBeVisible();
  const card = page.locator('[data-coach="card-admanager"]');
  await expect(card.getByRole('heading', { name: 'ADManager Plus' })).toBeVisible();
  const row = card.getByRole('listitem').filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row.getByText('Connected as')).toHaveCount(0);
  await shot(page, testInfo, 'admanager-user-01-not-connected');

  // Connecting for real crosses to the worker (the authtoken is validated
  // against the live server before anything is stored) — with none
  // configured here, the real, unmocked answer is the fail-closed message.
  await row.getByRole('button', { name: 'Connect' }).click();
  await row.getByLabel('Your name (for display)').fill('Jamie Lee');
  await row.getByLabel('Authtoken').fill('e2e-fake-authtoken');
  await row.getByRole('button', { name: 'Connect' }).click();
  await expect(card.getByText(UNCONFIGURED_MESSAGE)).toBeVisible();
  await expect(row.getByText('Connected as')).toHaveCount(0);
  await shot(page, testInfo, 'admanager-user-04-reconnect-unconfigured');

  // Mobile.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(card).toBeVisible();
  await shot(page, testInfo, 'admanager-user-05-mobile');
});
