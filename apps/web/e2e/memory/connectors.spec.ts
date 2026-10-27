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
 * Not reachable here: the "Connected" section and the real disconnect
 * (`DisconnectControl`) — a connected Zoom card needs the grant Zoom's
 * OAuth callback writes after a code exchange with zoom.us, made
 * server-side, which no route or `page.route` can stand in for. (This was
 * also the half of the Postgres spec that last failed, connectors.spec.ts:140.)
 *
 * Pinned Chromium; "mobile" is a resized viewport.
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { addConnectors, connectorConfig, saveConnectorConfig } from '../support/connectors';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory');
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

test('connectors page: needs-setup ordering and the live scope picker', async ({
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

    // Both cards start unconnected: one "Needs setup" section, no "Connected"
    // section at all.
    const zoomCard = page.locator('[data-coach="card-zoom"]');
    const webexCard = page.locator('[data-coach="card-webex"]');
    await expect(page.getByRole('heading', { name: 'Needs setup' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Connected', exact: true })).toHaveCount(0);
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
