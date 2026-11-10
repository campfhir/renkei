/**
 * The ADManager Plus connector in a browser: the admin's instance registry
 * (its empty state, one instance created through the form and drawn in
 * the list, its page read back, the delete confirmation and the way back
 * to the list), the transport-security banner on a lab instance's page,
 * and the user's connect flow on the connectors page (the fail-closed
 * message when the service isn't wired up).
 *
 * Where the registry's rules went: the draft (what Create and Save send,
 * the template blank-as-null, the CA kept, replaced or removed, the URL
 * preview, when Create and Test can be pressed, how a reachability answer
 * reads) is app/(app)/admin/admanager/instance-list.model.test.ts; the
 * edit page (the banner from what is stored, a late load not clobbering an
 * edit — the reason this spec once retried its edits for a minute) is
 * app/(app)/admin/admanager/[instanceId]/instance-config-form.model.test.ts;
 * what the routes store and refuse (the template set and cleared,
 * plaintext refused for production and for a public host, allowed for a
 * private lab host, refused again on a relabel to production; the
 * reachability test failing closed with no worker) is
 * app/api/admin/admanager/route.test.ts.
 *
 * The memory server runs no apps/worker-admanager and sets no delegate
 * worker — so `admanagerWorkerConfigured()` is really false here, the same
 * as a deployment that hasn't stood the worker up yet. The "connect with
 * an authtoken" flow is exercised against that REAL, unmocked "service not
 * configured" answer (see docs/admanager-connector-design.md: "a missing
 * pair means every operation answers 'unconfigured' — never open").
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

test('admin: ADManager Plus instance registry — create, read back, delete', async ({
  page,
  person: _person,
}, testInfo) => {
  const name = `ADManager Plus prod ${tag}`;
  await openEmptyRegistry(page);
  await shot(page, testInfo, 'admanager-admin-01-empty');

  // The one press through: the form's values reach the real create route
  // and the new row is drawn.
  await page.getByRole('button', { name: '+ New instance' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Server URL').fill('https://admp.example.com:8080');
  await page
    .getByLabel('Reset-password template (optional)')
    .fill('Reset Password – must change at next logon');
  await shot(page, testInfo, 'admanager-admin-02-draft-filled');
  await page.getByRole('button', { name: 'Create instance' }).click();
  await expect(instanceRow(page, name)).toBeVisible();
  await shot(page, testInfo, 'admanager-admin-04-created');

  // Its own page reads it back from the store.
  await instanceRow(page, name).getByRole('link', { name: 'Manage', exact: true }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByLabel('Server URL')).toHaveValue('https://admp.example.com:8080');
  await expect(page.getByLabel('Reset-password template (optional)')).toHaveValue(
    'Reset Password – must change at next logon'
  );

  // Mobile: a resized Chromium viewport, not a device descriptor.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(page.getByRole('button', { name: 'Delete instance' })).toBeVisible();
  await shot(page, testInfo, 'admanager-admin-06-mobile-detail');

  // Delete asks first (a native confirm), then goes back to the list without it.
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Delete instance' }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/admanager$`));
  await expect(page.getByRole('heading', { name: 'ADManager Plus', exact: true })).toBeVisible();
  await expect(instanceRow(page, name)).toHaveCount(0);
});

test('admin: a lab instance with transport security off carries the warning banner', async ({
  page,
  person: _person,
}, testInfo) => {
  const name = `ADManager Plus lab ${tag}`;
  // A lab label on a loopback host is what the exception is for (the
  // refusals are the route test's).
  const created = await page.request.post('/api/admin/admanager', {
    data: {
      name,
      environment: 'lab',
      baseUrl: 'http://127.0.0.1:8080',
      tlsVerify: true,
      allowInsecureHttp: true,
      resetPasswordTemplateName: null,
      enabled: true,
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = await created.json();

  await page.goto(`/admin/admanager/${id}`);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const banner = page.getByTestId('insecure-transport-banner');
  await expect(banner).toContainText('Transport security is off');
  await expect(banner).toContainText('plaintext HTTP allowed');
  await shot(page, testInfo, 'admanager-insecure-02-banner');

  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(banner).toBeVisible();
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
