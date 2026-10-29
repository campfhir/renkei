/**
 * The "Require a BAA-covered model for PHI connectors" org switch, end to
 * end in a browser: where it lives on the settings page, that saving it
 * writes the org setting, and that the org-settings route (what the gate
 * reads) reads it back on. The enforcement itself (a chat
 * turn or an agent run refused on an uncovered model) is unit-tested
 * beside the gate in @renkei/agent-llm and the agents worker; this spec
 * covers the one piece only a browser exercises.
 *
 * The switch is one organization-wide setting: the flow runs once, in
 * desktop-light (two projects flipping it at once would each see the
 * other's value), with the dark theme as an `emulateMedia` screenshot, and
 * the switch is put back off through the same route afterwards.
 * Pinned Chromium; mobile is a resized viewport, not a device profile.
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const SWITCH = 'Require a BAA-covered model for PHI connectors';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

async function storedValue(page: Page): Promise<unknown> {
  const readBack = await page.request.get(`/api/admin/org-settings`);
  expect(readBack.ok()).toBe(true);
  const body: { settings: { phiConnectorsRequireCoveredModel: boolean } } = await readBack.json();
  return body.settings.phiConnectorsRequireCoveredModel;
}

test('admin: the PHI covered-model switch saves and reads back', async ({
  page,
  person: _person,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-light',
    'An organization-wide switch: one writer, the dark theme as a screenshot.'
  );
  try {
    await page.goto(`/admin/settings`);
    const toggle = page.getByRole('switch', { name: SWITCH });
    await expect(toggle).toBeVisible();
    // Off by default: an org without PHI connectors has nothing to gate.
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'phi-covered-model-01-off');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await shot(page, testInfo, 'phi-covered-model-02-saved');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, testInfo, 'phi-covered-model-02-saved-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    // What the gate reads: the org-settings route answers the saved value
    // (the settings page itself may show the old value for up to a minute —
    // @renkei/settings caches what a page render reads).
    expect(await storedValue(page)).toBe(true);

    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.getByRole('switch', { name: SWITCH }).scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'phi-covered-model-03-mobile');
  } finally {
    const restored = await page.request.put('/api/admin/org-settings', {
      data: { phiConnectorsRequireCoveredModel: false },
    });
    expect(restored.ok()).toBe(true);
  }
  expect(await storedValue(page)).toBe(false);
});
