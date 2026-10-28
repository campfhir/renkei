/**
 * The connectors page: the "Needs setup" sectioning that floats
 * added-but-unconnected cards to the top, and the live scope picker (a
 * shared client island, `ScopeConnectPanel`) whose "Connect" link follows
 * the boxes before any round trip.
 *
 * Zoom and WebEx — the two single-catalog OAuth cards, the shape most
 * connectors share — are registered through their admin routes (what the
 * admin connector page's Save sends) and added from the catalog
 * (e2e/support/connectors.ts). Connector configs are organization-wide,
 * one row per connector for the whole server, so the flow runs once, in
 * desktop-light, with the dark theme as an `emulateMedia` screenshot, and
 * each config is put back as it was afterwards (disabled again when the
 * test made it — the admin routes have no delete).
 *
 * Then the person connects Zoom for real: the card's Connect link runs the
 * authorize route, which on the in-memory app consents at once (fake
 * OAuth, packages/provider-grants/src/fake-oauth.ts) and lands on the
 * callback, which stores the grant as production does — Zoom moves into
 * "Connected" — and `DisconnectControl` disconnects it through the real
 * DELETE route.
 *
 * Pinned Chromium; "mobile" is a resized viewport.
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { addConnectors, connectorConfig, saveConnectorConfig } from './support/connectors';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

/** Register a connector for the test, and answer how to put it back. */
async function register(page: Page, connector: string): Promise<() => Promise<void>> {
  const before = await connectorConfig(page.request, connector);
  await saveConnectorConfig(page.request, connector, {
    clientId: typeof before.clientId === 'string' ? before.clientId : `e2e-${connector}`,
    clientSecret: 'not-a-real-secret',
    enabled: true,
  });
  return async () => {
    const after = await connectorConfig(page.request, connector);
    await saveConnectorConfig(page.request, connector, {
      clientId: after.clientId,
      enabled: before.configured === true && before.enabled === true,
      ...(typeof before.scopes === 'string' ? { scopes: before.scopes } : {}),
    });
  };
}

test('connectors page: needs-setup ordering, live scope picker, connect and disconnect', async ({
  page,
  person: _person,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-light',
    'Connector configs are organization-wide: one writer, the dark theme as a screenshot.'
  );
  const restores: (() => Promise<void>)[] = [];
  try {
    restores.push(await register(page, 'zoom'));
    restores.push(await register(page, 'webex-user'));
    await addConnectors(page.request, ['zoom', 'webex']);

    await page.goto(`/connectors`);
    await expect(page.getByRole('heading', { name: 'Connectors' })).toBeVisible();

    // Both cards start unconnected, in "Needs setup".
    const zoomCard = page.locator('[data-coach="card-zoom"]').filter({ visible: true });
    const webexCard = page.locator('[data-coach="card-webex"]').filter({ visible: true });
    // The sections, by their headings. Organization-wide features another
    // spec switched on (the sandbox browser's secrets card) may sit in
    // "Connected" already, so its membership is what is asserted.
    const needsSetup = page
      .locator('xpath=//h2[normalize-space()="Needs setup"]/..')
      .filter({ visible: true });
    const connected = page
      .locator('xpath=//h2[normalize-space()="Connected"]/..')
      .filter({ visible: true });
    await expect(needsSetup.locator('[data-coach="card-zoom"]')).toBeVisible();
    await expect(needsSetup.locator('[data-coach="card-webex"]')).toBeVisible();
    await expect(connected.locator('[data-coach="card-zoom"]')).toHaveCount(0);
    await expect(zoomCard.getByText('Not connected')).toBeVisible();
    await expect(webexCard.getByText('Not connected')).toBeVisible();
    await shot(page, testInfo, 'connectors-01-needs-setup');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, testInfo, 'connectors-01-needs-setup-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    // The scope picker is a live client island (ScopeConnectPanel): unchecking
    // a capability must change the "Connect Zoom" link's authorize URL before
    // any network round trip.
    await zoomCard.getByText(/What Renkei may do/).click();
    const connectZoomLink = zoomCard.getByRole('link', { name: 'Connect Zoom' });
    const hrefBefore = await connectZoomLink.getAttribute('href');
    await zoomCard.getByRole('checkbox').first().uncheck();
    await expect.poll(() => connectZoomLink.getAttribute('href')).not.toBe(hrefBefore);

    // Connect: the authorize route, the fake consent, the callback, and back
    // here. Zoom moves out of "Needs setup" into its own "Connected"
    // section, while WebEx — still unconnected — stays in "Needs setup".
    await connectZoomLink.click();
    await page.waitForURL(/\/connectors(\?|$)/, { timeout: 30_000 });
    await expect(connected.locator('[data-coach="card-zoom"]')).toBeVisible();
    await expect(needsSetup.locator('[data-coach="card-webex"]')).toBeVisible();
    await expect(zoomCard.getByText('Connected', { exact: true })).toBeVisible();
    await expect(webexCard.getByText('Not connected')).toBeVisible();
    await shot(page, testInfo, 'connectors-02-mixed');

    // DisconnectControl, for real: cancel first (must not disconnect), then
    // confirm, which hits the actual DELETE route.
    await zoomCard.getByRole('button', { name: 'Disconnect Zoom' }).click();
    await expect(zoomCard.getByText(/Disconnect your Zoom account\?/)).toBeVisible();
    await zoomCard.getByRole('button', { name: 'Keep it' }).click();
    await expect(zoomCard.getByText(/Disconnect your Zoom account\?/)).toHaveCount(0);
    await expect(zoomCard.getByText('Connected', { exact: true })).toBeVisible();

    await zoomCard.getByRole('button', { name: 'Disconnect Zoom' }).click();
    await zoomCard.getByRole('button', { name: 'Yes, disconnect' }).click();
    await expect(zoomCard.getByText('Not connected')).toBeVisible({ timeout: 30_000 });
    // Back to a single "Needs setup" section: the disconnect's refresh
    // re-read the grants and re-sorted both cards into it.
    await expect(needsSetup.locator('[data-coach="card-zoom"]')).toBeVisible();
    await expect(connected.locator('[data-coach="card-zoom"]')).toHaveCount(0);
    await shot(page, testInfo, 'connectors-03-disconnected');

    // Mobile: a resized Chromium viewport, not a device descriptor.
    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(page.getByRole('heading', { name: 'Needs setup' })).toBeVisible();
    await expect(zoomCard).toBeVisible();
    await expect(webexCard).toBeVisible();
    await shot(page, testInfo, 'connectors-04-mobile');
  } finally {
    for (const restore of restores) await restore();
  }
});
