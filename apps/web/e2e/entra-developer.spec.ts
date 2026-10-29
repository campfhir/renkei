/**
 * Entra Developer, end to end in a browser: an operator registers the
 * second Entra app through the real admin form and save route, a person
 * finds its own card on the connectors page, narrows its directory-wide
 * scopes in the live picker, and the authorize route turns that into a
 * Microsoft consent request carrying exactly those scopes — and refuses
 * a scope beyond what the org allows. Then the person connects for real,
 * beside a connected Microsoft 365 card, and disconnects Entra Developer
 * alone: separate apps, separate grants.
 *
 * Nothing here reaches Microsoft: on the in-memory app the authorize
 * route's consent is the app's own fake OAuth
 * (packages/provider-grants/src/fake-oauth.ts), which sends the browser
 * straight back to the callback with a code carrying the request
 * Microsoft would have been sent (read with `fakeConsentRequest`); the
 * delegate trades it for a fake token set and the callback stores the
 * grant as production does.
 *
 * The connector configs are organization-wide (one row each for the whole
 * server): the flow runs once, in desktop-light, with the dark theme as an
 * `emulateMedia` screenshot. Entra Developer's config is put back as it
 * was afterwards (disabled again when the test made it — the admin route
 * has no delete); Microsoft 365's is left on, since other specs connect
 * through it too.
 *
 * Pinned Chromium; "mobile" is a resized viewport, per AGENTS.md.
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import {
  addConnectors,
  connectThrough,
  connectorConfig,
  fakeConsentRequest,
  registerConnector,
  saveConnectorConfig,
} from './support/connectors';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DIRECTORY_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

test('entra developer: register the app, connect with narrowed scopes', async ({
  page,
  person: _person,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-light',
    'The connector config is organization-wide: one writer, the dark theme as a screenshot.'
  );
  const before = await connectorConfig(page.request, 'entra-developer');
  try {
    // Microsoft 365, the first Entra app, registered (and left on: other
    // specs connect through it too) and connected first.
    await registerConnector(
      page.request,
      'microsoft',
      {
        clientId: 'e2e-microsoft-client',
        clientSecret: 'e2e-microsoft-secret',
        directoryTenantId: DIRECTORY_ID,
      },
      ['directoryTenantId']
    );
    await addConnectors(page.request, ['microsoft']);
    await connectThrough(page, '/api/microsoft/authorize');

    // --- The operator registers the second Entra app. ---
    await page.goto(`/admin/connectors/entra-developer`);
    await expect(page.getByRole('heading', { name: 'Entra Developer', level: 1 })).toBeVisible();
    const form = page.locator('[data-coach="admin-connector-form"]');
    // The one thing an operator must not miss: it is a separate app, and
    // its permissions need an admin's consent.
    await expect(form.getByText(/separate/)).toBeVisible();
    await expect(form.getByText('Read applications')).toBeVisible();
    await expect(form.getByText('Assign people and groups to app roles')).toBeVisible();
    // Every box starts ticked; this org holds group lookups back, so its
    // people cannot pick them (below) until an admin ticks it here.
    const groups = form.getByRole('checkbox', { name: /Find groups/ });
    await expect(groups).toBeChecked();
    await groups.uncheck();

    await form.getByLabel('Client ID').fill('e2e-entra-client');
    await form.getByLabel('Directory (tenant) ID').fill(DIRECTORY_ID);
    await form.getByLabel('Client secret').fill('e2e-entra-secret');
    // On, whatever an earlier run left it at.
    await form.getByRole('checkbox', { name: 'Enabled', exact: true }).check();
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form.getByText('Saved')).toBeVisible({ timeout: 30_000 });
    await shot(page, testInfo, 'entra-developer-01-registered');

    // Saved for real: a reload shows the stored secret as stored, never its value.
    await page.reload();
    await expect(form.getByLabel('Client secret')).toHaveAttribute(
      'placeholder',
      'Stored — leave blank to keep'
    );
    const stored = await connectorConfig(page.request, 'entra-developer');
    expect(stored.enabled).toBe(true);
    expect(stored.directoryTenantId).toBe(DIRECTORY_ID);
    expect(String(stored.scopes).split(' ').sort()).toEqual(
      [
        'Application.Read.All',
        'Application.ReadWrite.All',
        'AppRoleAssignment.ReadWrite.All',
        'User.ReadBasic.All',
        'openid',
        'profile',
        'email',
        'offline_access',
        'User.Read',
      ].sort()
    );

    // --- The person connects it from its own card. ---
    await addConnectors(page.request, ['entra-developer']);
    await page.goto(`/connectors`);
    const microsoftCard = page.locator('[data-coach="card-microsoft"]').filter({ visible: true });
    await expect(microsoftCard.getByText('Connected', { exact: true })).toBeVisible();
    const card = page.locator('[data-coach="card-entra-developer"]').filter({ visible: true });
    await expect(card.getByRole('heading', { name: 'Entra Developer' })).toBeVisible();
    await expect(card.getByText('Not connected')).toBeVisible();

    // The live picker narrows the scopes before any round trip: leaving out
    // the write bundle drops Application.ReadWrite.All from the authorize link.
    await card.getByText(/What Renkei may do/).click();
    // What the org held back is not even offered.
    await expect(card.getByRole('checkbox', { name: /Find groups/ })).toHaveCount(0);
    const connect = card.getByRole('link', { name: 'Connect Entra Developer' });
    await expect(connect).toHaveAttribute('href', /Application\.ReadWrite\.All/);
    await card.getByRole('checkbox', { name: /Create and change applications/ }).uncheck();
    await expect(connect).not.toHaveAttribute('href', /Application\.ReadWrite\.All/);
    await shot(page, testInfo, 'entra-developer-02-narrowed');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, testInfo, 'entra-developer-02-narrowed-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    // The authorize route turns the narrowed choice into Microsoft's consent
    // request — read with redirects off, from the fake consent's code —
    // against the org's own directory, never `common`.
    const href = await connect.getAttribute('href');
    expect(href).toMatch(new RegExp(`^/api/entra-developer/authorize`));
    const authorize = await page.request.get(href ?? '', { maxRedirects: 0 });
    expect([302, 307]).toContain(authorize.status());
    const consent = fakeConsentRequest(authorize.headers()['location'] ?? '');
    expect(consent.origin + consent.pathname).toBe(
      `https://login.microsoftonline.com/${DIRECTORY_ID}/oauth2/v2.0/authorize`
    );
    expect(consent.searchParams.get('client_id')).toBe('e2e-entra-client');
    expect(consent.searchParams.get('scope')?.split(' ').sort()).toEqual(
      [
        'Application.Read.All',
        'AppRoleAssignment.ReadWrite.All',
        'User.ReadBasic.All',
        'openid',
        'profile',
        'email',
        'offline_access',
        'User.Read',
      ].sort()
    );

    // A scope beyond the org's ceiling — the box it held back — is refused,
    // not silently dropped.
    const widened = await page.request.get(
      `/api/entra-developer/authorize?scopes=Application.Read.All+Group.Read.All`,
      { maxRedirects: 0 }
    );
    expect(widened.status()).toBe(400);

    // --- Connected through the card's own link, then the real disconnect. ---
    await connect.click();
    await page.waitForURL(/\/connectors(\?|$)/, { timeout: 30_000 });
    await expect(card).toHaveCount(1);
    await expect(card.getByText('Connected', { exact: true })).toBeVisible();
    await expect(card.getByText('Connected as')).toBeVisible();
    // The fake directory user, the same one Microsoft 365 connected as.
    await expect(card.getByText(/Microsoft user [0-9a-f]{6}/)).toBeVisible();
    await shot(page, testInfo, 'entra-developer-03-connected');

    await card.getByRole('button', { name: 'Disconnect Entra Developer' }).click();
    await expect(card.getByText(/Your Microsoft 365 connection is not affected/)).toBeVisible();
    await card.getByRole('button', { name: 'Yes, disconnect' }).click();
    await expect(card.getByText('Not connected')).toBeVisible({ timeout: 30_000 });
    // Separate apps, separate grants: Microsoft 365 is still connected.
    await page.reload();
    await expect(microsoftCard.getByText('Connected', { exact: true })).toBeVisible();
    await expect(card.getByText('Not connected')).toBeVisible();

    // Mobile: a resized Chromium viewport, not a device descriptor.
    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(card.getByRole('heading', { name: 'Entra Developer' })).toBeVisible();
    await expect(card.getByRole('link', { name: 'Connect Entra Developer' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, testInfo, 'entra-developer-04-mobile');
  } finally {
    // As it was: the earlier registration, or none in use.
    const after = await connectorConfig(page.request, 'entra-developer');
    // Nothing to put back when the test stopped before it saved one.
    if (after.configured === true)
      await saveConnectorConfig(page.request, 'entra-developer', {
        clientId: before.configured === true ? before.clientId : after.clientId,
        directoryTenantId:
          before.configured === true ? before.directoryTenantId : after.directoryTenantId,
        enabled: before.configured === true && before.enabled === true,
        ...(typeof before.scopes === 'string' ? { scopes: before.scopes } : {}),
      });
  }
});
