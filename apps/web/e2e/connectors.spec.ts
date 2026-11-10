/**
 * The connectors page in a browser: it renders on the real server, one
 * real connect walk, and a phone's width.
 *
 * Where its rules went:
 *   - which cards the page draws, their order, which sit under "Needs
 *     setup" and when the rest are headed "Connected", what each card hosts
 *     and is handed: app/(app)/connectors/connectors-page.model.test.ts;
 *   - what the scope picker offers and ticks, its "N of M" summary, and the
 *     Connect link following the boxes: scope-connect-panel.model.test.ts
 *     and components/scope-picker.model.test.ts;
 *   - Disconnect's confirm / "Keep it" / refusal: disconnect-control.model.test.ts;
 *   - the authorize route (ceiling refusal, what Zoom is asked for, the
 *     pending row) and the disconnect route (whose grant, the purge, the
 *     refusal): app/api/zoom/authorize/route.test.ts and
 *     app/api/zoom/grant/route.test.ts.
 *
 * Zoom and WebEx are registered through their admin routes (what the admin
 * connector page's Save sends) and added from the catalog
 * (e2e/support/connectors.ts). Connector configs are organization-wide,
 * one row per connector for the whole server, so the flow runs once, in
 * desktop-light, with the dark theme as an `emulateMedia` screenshot, and
 * each config is put back as it was afterwards (disabled again when the
 * test made it — the admin routes have no delete).
 *
 * The walk: the card's Connect link runs the authorize route, which on the
 * in-memory app consents at once (fake OAuth,
 * packages/provider-grants/src/fake-oauth.ts) and lands on the callback,
 * which stores the grant as production does — and the page, re-rendered on
 * the server, draws Zoom under "Connected".
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

test('connectors page: renders, connects Zoom for real, fits a phone', async ({
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

    const zoomCard = page.locator('[data-coach="card-zoom"]').filter({ visible: true });
    const webexCard = page.locator('[data-coach="card-webex"]').filter({ visible: true });
    // The sections, by their headings. Organization-wide features another
    // spec switched on (the sandbox browser's secrets card) may sit in
    // "Connected" already, so only Zoom's membership is asserted.
    const needsSetup = page
      .locator('xpath=//h2[normalize-space()="Needs setup"]/..')
      .filter({ visible: true });
    const connected = page
      .locator('xpath=//h2[normalize-space()="Connected"]/..')
      .filter({ visible: true });
    await expect(needsSetup.locator('[data-coach="card-zoom"]')).toBeVisible();
    await expect(webexCard.getByText('Not connected')).toBeVisible();
    await shot(page, testInfo, 'connectors-01-needs-setup');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, testInfo, 'connectors-01-needs-setup-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    // Connect: the authorize route, the fake consent, the callback, and back
    // here, where the server draws Zoom connected.
    await zoomCard.getByRole('link', { name: 'Connect Zoom' }).click();
    await page.waitForURL(/\/connectors(\?|$)/, { timeout: 30_000 });
    await expect(connected.locator('[data-coach="card-zoom"]')).toBeVisible();
    await expect(zoomCard.getByText('Connected', { exact: true })).toBeVisible();
    await expect(zoomCard.getByRole('button', { name: 'Disconnect Zoom' })).toBeVisible();
    await shot(page, testInfo, 'connectors-02-mixed');

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
